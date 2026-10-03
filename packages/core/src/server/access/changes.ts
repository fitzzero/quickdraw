// What tracked writes do to access (RFC 0003 sections 4.2 and 4.4): a flush
// sink, first on the dispatcher's sink list, that evicts the cached lookups a
// write may have changed and then tells `onAccessChanged` listeners which
// rows' access may have changed and for whom. The revocation of live
// subscriptions (section 4.4) listens here.
//
// Per write, from the bindings' policies:
//
// | Write                                     | Evicts                        | Reports                   |
// |-------------------------------------------|-------------------------------|---------------------------|
// | a create or delete of a policy's row, or  | the row's columns, for every  | `{ service, id }`; a      |
// | an update setting a column it reads       | user                          | create reports nothing    |
// | a membership row                          | the member's level on its row | `{ service, id, userId }` |
// |                                           | before and after the write    | for each                  |
// | a membership row whose row or user is not | the whole membership table    | `{ service }`: any row    |
// | known (`ctx.touch`, array transactions)   |                               |                           |
// | the delete of a row with memberships      | every member's level on it    | `{ service, id }`         |
//
// An update that sets none of the columns a policy reads changes nothing.
// Evictions all happen before the first listener is told.

import type { Logger } from "../../contract/logger";
import { describeError } from "../pipeline/metrics";
import type { FlushSink } from "../uow/flushSink";
import { ANY_FIELD, type WriteRecord } from "../uow/types";
import type { Binding } from "./bindings";
import type { AccessCache, Namespace } from "./cache";
import type { MembershipRead } from "./policy";
import { modelKey } from "../storage";

/**
 * A row whose access may have changed: who may now see more or less of it.
 * `id` is the row (the anchor subscriptions record); without it, any row of
 * the service. `userId` is the user whose level may have changed; without it,
 * anyone's.
 */
export interface AccessChange {
  /** The service name. */
  readonly service: string;
  readonly id?: string;
  readonly userId?: string;
}

/** Receives access changes; a promise it returns is awaited before the flush moves on. */
export type AccessChangeListener = (change: AccessChange) => void | PromiseLike<void>;

type Rule =
  | { readonly kind: "rows"; readonly binding: Binding }
  | { readonly kind: "anchor"; readonly binding: Binding; readonly ns: Namespace }
  | {
      readonly kind: "members";
      readonly binding: Binding;
      readonly read: MembershipRead;
      readonly ns: Namespace;
    };

function sets(write: WriteRecord, columns: readonly string[]): boolean {
  return (
    write.op !== "update" ||
    write.fields.includes(ANY_FIELD) ||
    write.fields.some((field) => columns.includes(field))
  );
}

function rulesByModel(bindings: ReadonlyMap<string, Binding>): Map<string, Rule[]> {
  const rules = new Map<string, Rule[]>();
  const add = (model: string, rule: Rule): void => {
    const key = modelKey(model);
    rules.set(key, [...(rules.get(key) ?? []), rule]);
  };
  for (const binding of bindings.values()) {
    if (binding.columns.length > 0) {
      add(binding.model, { kind: "rows", binding });
    }
    for (const [read, ns] of binding.memberships) {
      add(binding.model, { kind: "anchor", binding, ns });
      add(read.model, { kind: "members", binding, read, ns });
    }
  }
  return rules;
}

type Values = WriteRecord["before"];

function stringIn(values: Values, key: string): string | undefined {
  const value = values?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The (user, row) pair in `values`, taking a column `values` lacks from `fallback`. */
function keyIn(
  read: MembershipRead,
  values: Values,
  fallback: Values,
): [string, string] | undefined {
  const user = stringIn(values, read.user) ?? stringIn(fallback, read.user);
  const entry = stringIn(values, read.entry) ?? stringIn(fallback, read.entry);
  return user === undefined || entry === undefined ? undefined : [user, entry];
}

/**
 * The (user, row) pairs a membership write touched: the old pair (from
 * `before`, which holds only the columns an update changed, then `after`)
 * unless the row was created, and the new pair (from `after`) unless it was
 * deleted. `undefined` when the write does not say: then any member's level
 * on any row may have changed.
 */
function membershipKeys(write: WriteRecord, read: MembershipRead): [string, string][] | undefined {
  const old = write.op === "create" ? undefined : keyIn(read, write.before, write.after);
  const now = write.op === "delete" ? undefined : keyIn(read, write.after, undefined);
  if (
    (write.op !== "create" && old === undefined) ||
    (write.op !== "delete" && now === undefined)
  ) {
    return undefined;
  }
  const keys = new Map<string, [string, string]>();
  for (const key of [old, now]) {
    if (key !== undefined) {
      keys.set(`${key[0]}\u0000${key[1]}`, key);
    }
  }
  return [...keys.values()];
}

/** Collects the access changes of one flush, without duplicates. */
class Changes {
  readonly #changes = new Map<string, AccessChange>();

  add(change: AccessChange): void {
    this.#changes.set(
      `${change.service}\u0000${change.id ?? ""}\u0000${change.userId ?? ""}`,
      change,
    );
  }

  get all(): AccessChange[] {
    return [...this.#changes.values()];
  }
}

function apply(
  rule: Rule,
  write: WriteRecord,
  cache: AccessCache | undefined,
  changes: Changes,
): void {
  const service = rule.binding.service.name;
  if (rule.kind === "rows") {
    if (sets(write, rule.binding.columns)) {
      cache?.evict(rule.binding.rows, "", write.id);
      if (write.op !== "create") {
        changes.add({ service, id: write.id });
      }
    }
    return;
  }
  if (rule.kind === "anchor") {
    if (write.op === "delete") {
      cache?.evict(rule.ns, undefined, write.id);
      changes.add({ service, id: write.id });
    }
    return;
  }
  if (!sets(write, [rule.read.entry, rule.read.user, rule.read.level])) {
    return;
  }
  const keys = membershipKeys(write, rule.read);
  if (keys === undefined) {
    cache?.evict(rule.ns);
    changes.add({ service });
    return;
  }
  for (const [userId, id] of keys) {
    cache?.evict(rule.ns, userId, id);
    changes.add({ service, id, userId });
  }
}

async function notify(
  listeners: ReadonlySet<AccessChangeListener>,
  changes: readonly AccessChange[],
  logger: Logger,
): Promise<void> {
  const running: Promise<void>[] = [];
  for (const change of changes) {
    for (const listener of listeners) {
      running.push(
        (async () => {
          await listener(change);
        })().catch((error: unknown) => {
          logger.error("An onAccessChanged listener failed", {
            category: "quickdraw.access",
            service: change.service,
            id: change.id,
            error: describeError(error),
          });
        }),
      );
    }
  }
  await Promise.all(running);
}

/**
 * The flush sink that evicts cached lookups and reports access changes, or
 * `undefined` when no served service has a policy.
 */
export function createChangeSink(
  bindings: ReadonlyMap<string, Binding>,
  cache: AccessCache | undefined,
  listeners: ReadonlySet<AccessChangeListener>,
  logger: Logger,
): FlushSink | undefined {
  const rules = rulesByModel(bindings);
  if (rules.size === 0) {
    return undefined;
  }
  return Object.freeze({
    async flush(writes: readonly WriteRecord[]): Promise<void> {
      const changes = new Changes();
      for (const write of writes) {
        for (const rule of rules.get(modelKey(write.model)) ?? []) {
          apply(rule, write, cache, changes);
        }
      }
      if (listeners.size > 0) {
        await notify(listeners, changes.all, logger);
      }
    },
  });
}
