// Which services depend on which, for `quickdraw-docs --services`: the other
// services each one's declarations name. A service depends on another when
// its row policy `inherit`s from it (inside `anyOf` too), it `writes` the
// model that service's rows live in, a write to its rows `affects` that
// service's, a method, channel or stream takes a `{ scope, of }` form of it,
// or a collection is anchored on its rows. Only declarations are read, never
// source: a handler that reads another service's rows without declaring it
// shows nothing here. A page writes them as its "Depends on" section, and
// the index as a Mermaid graph (`render.ts`).

import type { AnyContract } from "../contract/defineContract";
import { contractName, type ServiceDoc } from "./access";
import { code, list, section, table } from "./markdown";

/** How one service names another, as the graph's edge labels say it. */
export type DependencyKind = "inherit" | "writes" | "affects" | "scope" | "anchor";

/** The order kinds are written in, on a page and on an edge. */
const KINDS: readonly DependencyKind[] = ["inherit", "writes", "affects", "scope", "anchor"];

/** One declaration that names another service. */
export interface DependencyReason {
  readonly kind: DependencyKind;
  /** The declaration, in words (Markdown). */
  readonly text: string;
}

/** Another service one service depends on, and every declaration that says so. */
export interface ServiceDependency {
  readonly service: string;
  readonly reasons: readonly DependencyReason[];
}

/** What one service depends on. */
export interface ServiceDependencies {
  /** The services its declarations name, by name. */
  readonly services: readonly ServiceDependency[];
  /** The models it `writes` that no service's rows live in. */
  readonly models: readonly string[];
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A model name in the client's spelling, as `modelKey` writes it: `"TaskLabel"` is `"taskLabel"`. */
function modelKey(model: string): string {
  return `${model.charAt(0).toLowerCase()}${model.slice(1)}`;
}

/** How deep `anyOf` policies are searched for an `inherit`, as `policyText` writes them. */
const MAX_POLICY_DEPTH = 3;

/** Every `inherit` of a row policy, with its parent's name and the column that names the parent row. */
function inheritsOf(policy: unknown, depth = 0): { readonly from: string; readonly via: string }[] {
  if (!isRecord(policy)) {
    return [];
  }
  if (policy.kind === "inherit") {
    const from = contractName(policy.from);
    return from === undefined ? [] : [{ from, via: String(policy.via) }];
  }
  if (policy.kind === "anyOf" && Array.isArray(policy.policies) && depth < MAX_POLICY_DEPTH) {
    return policy.policies.flatMap((member: unknown) => inheritsOf(member, depth + 1));
  }
  return [];
}

/** The service a `{ scope, of }` form names, or `undefined` for every other form. */
function scopeOf(form: unknown): string | undefined {
  return isRecord(form) && typeof form.scope === "string" ? contractName(form.of) : undefined;
}

/** The services one service's declarations name, with the model owners `writes` resolves through. */
function dependenciesOfService(
  service: ServiceDoc,
  contract: AnyContract | undefined,
  owners: ReadonlyMap<string, readonly string[]>,
): ServiceDependencies {
  const found = new Map<string, DependencyReason[]>();
  const add = (target: string | undefined, kind: DependencyKind, text: string): void => {
    if (target === undefined || target === service.name) {
      return;
    }
    found.set(target, [...(found.get(target) ?? []), { kind, text }]);
  };
  for (const { from, via } of inheritsOf(service.policy)) {
    add(from, "inherit", `row policy: ${code("inherit")} through the ${code(via)} column`);
  }
  const models: string[] = [];
  for (const model of service.writes) {
    const serving = owners.get(modelKey(model)) ?? [];
    if (serving.length === 0) {
      models.push(model);
    }
    for (const owner of serving) {
      add(owner, "writes", `${code("writes")}: its ${code(model)} model`);
    }
  }
  for (const target of new Set(service.affects)) {
    add(target, "affects", `${code("affects")}: a write to a row here changes its rows`);
  }
  for (const [name, method] of service.methods) {
    add(scopeOf(method.access), "scope", `method ${code(name)}: ${code("{ scope, of }")}`);
  }
  for (const [name, access] of service.channels) {
    add(scopeOf(access), "scope", `channel ${code(name)}: ${code("{ scope, of }")}`);
  }
  for (const [name, stream] of Object.entries(contract?.streams ?? {})) {
    add(scopeOf(stream.access), "scope", `stream ${code(name)}: ${code("{ scope, of }")}`);
  }
  for (const [name, collection] of service.collections) {
    add(
      contractName(collection.anchor),
      "anchor",
      `collection ${code(name)}: anchored on its rows`,
    );
  }
  return {
    services: [...found]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, reasons]) => ({
        service: name,
        reasons: KINDS.flatMap((kind) => reasons.filter((reason) => reason.kind === kind)),
      })),
    models,
  };
}

/**
 * What each service depends on, by name: the services its declarations name,
 * a model it `writes` resolved to the services whose `model` it is.
 */
export function dependenciesOf(
  contracts: readonly AnyContract[],
  services: ReadonlyMap<string, ServiceDoc>,
): ReadonlyMap<string, ServiceDependencies> {
  const owners = new Map<string, string[]>();
  for (const service of services.values()) {
    if (service.model !== undefined) {
      const key = modelKey(service.model);
      owners.set(key, [...(owners.get(key) ?? []), service.name]);
    }
  }
  const byName = new Map(contracts.map((contract) => [contract.name, contract]));
  return new Map(
    [...services.values()].map((service) => [
      service.name,
      dependenciesOfService(service, byName.get(service.name), owners),
    ]),
  );
}

/** The kinds of a dependency's reasons, once each, in order: an edge's label. */
function kindsOf(dependency: ServiceDependency): readonly DependencyKind[] {
  return KINDS.filter((kind) => dependency.reasons.some((reason) => reason.kind === kind));
}

/** The page's "Depends on" section, with `--services`: the services its declarations name. */
export function dependsOnSection(dependencies: ServiceDependencies): string[] {
  const { services, models } = dependencies;
  const unserved =
    models.length === 0
      ? []
      : [`It also ${code("writes")} models no service's rows live in: ${list(models)}.`];
  if (services.length === 0) {
    return section("## Depends on", ["No other service: its declarations name none.", ...unserved]);
  }
  return section("## Depends on", [
    `The other services its declarations name: its row policy, ${code("writes")}, ${code("affects")}, ${code("{ scope, of }")} access forms and collection anchors. A handler's undeclared reads are not listed.`,
    table(
      ["Service", "Declared by"],
      services.map(({ service, reasons }) => [
        code(service),
        reasons.map((reason) => reason.text).join("; "),
      ]),
    ),
    ...unserved,
  ]);
}

/** A Mermaid node id for each service name: the name, made safe, and unique. */
function nodeIds(names: readonly string[]): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const name of names) {
    const safe = name.replace(/\W/g, "_");
    let id = /^end$/i.test(safe) ? `${safe}_` : safe;
    for (let n = 2; taken.has(id); n += 1) {
      id = `${safe}_${n}`;
    }
    taken.add(id);
    ids.set(name, id);
  }
  return ids;
}

/**
 * The index's "Dependencies" section, with `--services`: a Mermaid graph
 * with an arrow from each service to each one its declarations name,
 * labelled with how.
 */
export function dependencyGraph(dependencies: ReadonlyMap<string, ServiceDependencies>): string[] {
  const edges = [...dependencies].flatMap(([from, { services }]) =>
    services.map((dependency) => ({
      from,
      to: dependency.service,
      label: kindsOf(dependency).join(", "),
    })),
  );
  if (edges.length === 0) {
    return section("## Dependencies", ["No service's declarations name another service."]);
  }
  const names = [...new Set(edges.flatMap(({ from, to }) => [from, to]))].sort();
  const ids = nodeIds(names);
  const id = (name: string): string => ids.get(name) ?? name;
  const nodes = names
    .filter((name) => id(name) !== name)
    .map((name) => `  ${id(name)}["${name.replace(/"/g, "#quot;")}"]`);
  return section("## Dependencies", [
    `An arrow points from a service to another its declarations name: ${code("inherit")} (its row policy), ${code("writes")} (that service's model), ${code("affects")}, ${code("scope")} (a ${code("{ scope, of }")} access form) or ${code("anchor")} (a collection's anchor). Each service's page lists them.`,
    [
      "```mermaid",
      "graph LR",
      ...nodes,
      ...edges.map(({ from, to, label }) => `  ${id(from)} -->|${label}| ${id(to)}`),
      "```",
    ],
  ]);
}
