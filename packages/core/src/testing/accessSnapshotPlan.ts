// What `snapshotAccessMatrix` will run (`accessSnapshot.ts`), read from its
// options and the app before any cell: the principals and rows a fixture
// gives, checked, and the rows of the matrix. A method has one row per
// variant of the row it is about (`accessInputs.ts`, `rowServiceOf`), an
// entity subscribe one per variant of its service's rows, and a collection
// one per variant of its anchor's rows (a `"self"` scope one, `(self)`).
// `rows` must name every service those are about: a matrix of cells that
// could reach no row pins nothing, so a missing service fails before any
// cell runs.

import type { AnyService, ServiceMethod } from "../server/service";
import { rowServiceOf } from "./accessInputs";
import { ANONYMOUS } from "./accessMatrix";
import type { TestApp } from "./createTestApp";

/** The row ids a matrix's cells are about, by service name: one id, or named variants (`{ own, other }`). */
export type AccessRows = Readonly<Record<string, string | Readonly<Record<string, string>>>>;

/** The callers of a matrix by name, or a function of the fixture making them. */
export type AccessPrincipals<P, Fixture, Name extends string = string> =
  | Readonly<Record<Name, P | null>>
  | ((fixture: Fixture) => Readonly<Record<Name, P | null>>);

/** The rows of one fixture: per service, its row id by variant (`undefined` for a single id). */
export type Rows = ReadonlyMap<string, ReadonlyMap<string | undefined, string>>;

/** A method of the matrix, for one row variant. */
export interface MethodRow {
  /** The row's key in the snapshot: `<service>.<method>`, plus ` (<variant>)`. */
  readonly key: string;
  readonly service: AnyService;
  readonly method: ServiceMethod;
  /** The service whose row the method is about; `undefined` for a method about no row. */
  readonly rowService: string | undefined;
  readonly variant: string | undefined;
}

/** An entity subscribe of the matrix: every row variant of one service, in one `qd:sub`. */
export interface SubscribeRow {
  readonly service: string;
  /** The rows' keys in the snapshot, by variant. */
  readonly keys: ReadonlyMap<string | undefined, string>;
}

/** A collection scope of the matrix, for one row variant of its anchor (or the caller's own id). */
export interface ScopeRow {
  readonly key: string;
  readonly service: string;
  readonly collection: string;
  /** The anchor service; `undefined` for a `"self"` scope, whose value is the caller's user id. */
  readonly anchor: string | undefined;
  readonly variant: string | undefined;
}

/** Every row of the matrix, in the order a principal runs them, and the methods left out. */
export interface Plan {
  readonly subscribes: readonly SubscribeRow[];
  readonly scopes: readonly ScopeRow[];
  readonly queries: readonly MethodRow[];
  readonly mutations: readonly MethodRow[];
  readonly excluded: readonly string[];
}

type Json = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws the `TypeError` of a matrix that cannot run as given. */
export function fail(message: string): never {
  throw new TypeError(`snapshotAccessMatrix: ${message}`);
}

/** By name, in UTF-16 code unit order: the same order on every machine. */
function byName(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** A row's key: its base, plus ` (<variant>)` for a named variant. */
export function keyOf(base: string, variant: string | undefined): string {
  return variant === undefined ? base : `${base} (${variant})`;
}

/** The principals `given` makes for `fixture`, plus the anonymous caller unless one is `null`. */
export function readPrincipals<P, Fixture>(
  given: AccessPrincipals<P, Fixture>,
  fixture: Fixture,
): Map<string, P | null> {
  const record: unknown = typeof given === "function" ? given(fixture) : given;
  if (!isRecord(record)) {
    fail("principals must map names to principals (null for an anonymous caller)");
  }
  const principals = new Map<string, P | null>();
  for (const [name, principal] of Object.entries(record)) {
    if (principal !== null && !isRecord(principal)) {
      fail(`principals.${name} must be a principal, or null for an anonymous caller`);
    }
    principals.set(name, principal as P | null);
  }
  if (![...principals.values()].includes(null)) {
    if (principals.has(ANONYMOUS)) {
      fail(
        `a principal is named "${ANONYMOUS}", the name of the anonymous caller added for you: name your anonymous caller with null, or rename that principal`,
      );
    }
    principals.set(ANONYMOUS, null);
  }
  return principals;
}

/** The variants of one service's entry in `rows`, checked. */
function variantsIn(service: string, value: unknown): Map<string | undefined, string> {
  if (typeof value === "string" && value.length > 0) {
    return new Map([[undefined, value]]);
  }
  const entries = isRecord(value) ? Object.entries(value) : [];
  const ids: [string, string][] = [];
  for (const [variant, id] of entries) {
    if (typeof id === "string" && id.length > 0) {
      ids.push([variant, id]);
    }
  }
  if (ids.length === 0 || ids.length !== entries.length) {
    fail(`rows.${service} must be a row id, or named row ids ({ own: id, other: id })`);
  }
  return new Map(ids.sort(([a], [b]) => byName(a, b)));
}

/** The rows `rows(fixture)` gave: every service it names must be served, and every id a non-empty string. */
export function readRows(given: unknown, served: ReadonlyMap<string, AnyService>): Rows {
  if (!isRecord(given)) {
    fail("rows(fixture) must map service names to a row id, or to named row ids");
  }
  const rows = new Map<string, ReadonlyMap<string | undefined, string>>();
  for (const [service, value] of Object.entries(given)) {
    if (!served.has(service)) {
      fail(`rows names ${service}, which the app does not serve`);
    }
    rows.set(service, variantsIn(service, value));
  }
  return rows;
}

/** True when two fixtures' principals and rows have the same names: the matrix's rows and columns. */
export function sameShape(
  a: { readonly principals: ReadonlyMap<string, unknown>; readonly rows: Rows },
  b: { readonly principals: ReadonlyMap<string, unknown>; readonly rows: Rows },
): boolean {
  const names = (map: ReadonlyMap<unknown, unknown>): string => [...map.keys()].join("\n");
  const rows = (of: Rows): string =>
    [...of].map(([service, ids]) => `${service}:${names(ids)}`).join("\n\n");
  return names(a.principals) === names(b.principals) && rows(a.rows) === rows(b.rows);
}

/** The variants of a service's rows: `[undefined]` for a single id, or for a method about no row. */
export function variantsOf(rows: Rows, service: string | undefined): (string | undefined)[] {
  const ids = service === undefined ? undefined : rows.get(service);
  return ids === undefined ? [undefined] : [...ids.keys()];
}

/** The services the matrix covers (default every service the app serves), each served, by name. */
export function servicesOf(app: TestApp, given: readonly AnyService[] | undefined): AnyService[] {
  const { services } = app.server.dispatcher.registry;
  if (given === undefined) {
    return [...services.values()].sort((a, b) => byName(a.name, b.name));
  }
  if (!Array.isArray(given)) {
    fail("services must be a list of services the app serves");
  }
  for (const service of given) {
    if (services.get(service.name) !== service) {
      fail(`the app does not serve ${service.name}`);
    }
  }
  return [...new Set(given)].sort((a, b) => byName(a.name, b.name));
}

/** The methods `exclude` names, each a method of the matrix's services. */
export function excludedOf(
  services: readonly AnyService[],
  given: readonly string[] | undefined,
): Set<string> {
  const known = new Set(
    services.flatMap((service) =>
      Object.keys(service.methods).map((name) => `${service.name}.${name}`),
    ),
  );
  if (given !== undefined && !Array.isArray(given)) {
    fail("exclude must be a list of methods, as <service>.<method>");
  }
  const excluded = new Set<string>();
  for (const name of given ?? []) {
    if (typeof name !== "string" || !known.has(name)) {
      fail(
        `exclude names ${String(name)}, which is no method (<service>.<method>) of the matrix's services`,
      );
    }
    excluded.add(name);
  }
  return excluded;
}

/** The methods of the matrix, one row per variant of the row each is about. */
function methodRows(
  services: readonly AnyService[],
  excluded: ReadonlySet<string>,
  rows: Rows,
): MethodRow[] {
  const list: MethodRow[] = [];
  for (const service of services) {
    for (const name of Object.keys(service.methods).sort(byName)) {
      const method = service.methods[name];
      const base = `${service.name}.${name}`;
      if (method === undefined || excluded.has(base)) {
        continue;
      }
      const rowService = rowServiceOf(service, method);
      for (const variant of variantsOf(rows, rowService)) {
        list.push({ key: keyOf(base, variant), service, method, rowService, variant });
      }
    }
  }
  return list;
}

/** The entity subscribes of the matrix: one per service with rows to subscribe to. */
function subscribeRows(services: readonly AnyService[], rows: Rows): SubscribeRow[] {
  return services
    .filter((service) => service.model !== undefined && service.contract.entity !== undefined)
    .map((service) => ({
      service: service.name,
      keys: new Map(
        variantsOf(rows, service.name).map((variant) => [variant, keyOf(service.name, variant)]),
      ),
    }));
}

/** The collection scopes of the matrix: one per variant of each collection's anchor, `(self)` for a self scope. */
function scopeRows(services: readonly AnyService[], rows: Rows): ScopeRow[] {
  const list: ScopeRow[] = [];
  for (const service of services) {
    for (const collection of [...service.collections.keys()].sort(byName)) {
      const anchor = service.collections.get(collection)?.anchor?.name;
      const base = `${service.name}.${collection}`;
      if (anchor === undefined) {
        list.push({
          key: keyOf(base, "self"),
          service: service.name,
          collection,
          anchor,
          variant: undefined,
        });
        continue;
      }
      for (const variant of variantsOf(rows, anchor)) {
        list.push({
          key: keyOf(base, variant),
          service: service.name,
          collection,
          anchor,
          variant,
        });
      }
    }
  }
  return list;
}

/** Throws when `rows` names no row of a service a row of the matrix is about, listing every such service. */
function checkRowsCover(plan: Plan, rows: Rows): void {
  const needs = new Map<string, Set<string>>();
  const need = (service: string | undefined, what: string): void => {
    if (service !== undefined && !rows.has(service)) {
      needs.set(service, (needs.get(service) ?? new Set()).add(what));
    }
  };
  for (const row of [...plan.queries, ...plan.mutations]) {
    need(row.rowService, `${row.service.name}.${row.method.name}`);
  }
  for (const row of plan.subscribes) {
    need(row.service, `qd:sub ${row.service}`);
  }
  for (const row of plan.scopes) {
    need(row.anchor, `qd:col:sub ${row.service}.${row.collection}`);
  }
  if (needs.size > 0) {
    const missing = [...needs].map(([service, what]) => `${service} (for ${[...what].join(", ")})`);
    fail(
      `rows names no row of ${missing.join("; ")}. Give rows(fixture) a row id of each, or named row ids ({ own: id, other: id }); leave a method out with exclude`,
    );
  }
}

/** Every row of the matrix: the methods of `services` but those excluded, their subscribes and scopes. */
export function planOf(
  services: readonly AnyService[],
  excluded: ReadonlySet<string>,
  rows: Rows,
): Plan {
  const methods = methodRows(services, excluded, rows);
  const plan: Plan = {
    subscribes: subscribeRows(services, rows),
    scopes: scopeRows(services, rows),
    queries: methods.filter((row) => row.method.kind === "query"),
    mutations: methods.filter((row) => row.method.kind === "mutation"),
    excluded: [...excluded].sort(byName),
  };
  checkRowsCover(plan, rows);
  return plan;
}
