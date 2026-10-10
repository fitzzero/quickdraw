// Who may call what, for `quickdraw-docs --services` (finding F5.3 of the
// quickdraw-chat migration: 4.x's generator printed each method's access
// level, while 5.0's read contracts alone, which do not say). The services
// module's `defineService` results are read as data: each method's access
// form, `rowless` and principal kinds, the service's row policy, admin
// bypass, kinds and `watchAccess`, who may open each collection, each
// channel's access, and each stream's computed seed and validation. Functions (a `custom` check,
// an `id` selector, a `resolver`) are named, never printed. A service is
// recognized by its shape, not by identity, so a services module that loaded
// its own copy of the framework is read as well.

import { code } from "./markdown";

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One method of a defined service, as the docs read it. */
export interface MethodAccessDoc {
  /** Its access form, as `defineService` checked it. */
  readonly access: unknown;
  /** It said `rowless: true`. */
  readonly rowless: boolean;
  /** The kinds of principal that may call it (its own, its service's or the app's); `undefined`: every kind. */
  readonly kinds: readonly string[] | undefined;
}

/** What the docs read of one collection of a defined service. */
export interface CollectionAccessDoc {
  /** The level a subscriber needs on the anchor row. */
  readonly level: unknown;
  /** The contract of the rows scope values are ids of; `undefined` for a `"self"` scope. */
  readonly anchor: unknown;
}

/** What the docs read of one stream of a defined service. */
export interface StreamServiceDoc {
  /** The service computes each subscriber's seed. */
  readonly computedSeed: boolean;
  /** When pushed items are checked: `"always"` or `"development"`. */
  readonly validate: unknown;
}

/** What the docs read of one defined service. */
export interface ServiceDoc {
  readonly name: string;
  /** Its row policy, or `undefined` without one. */
  readonly policy: unknown;
  /** Whether a service-wide `Admin` grant passes every check. */
  readonly adminBypass: boolean;
  /** The kinds of principal it admits (its own or the app's); `undefined`: every kind. */
  readonly kinds: readonly string[] | undefined;
  /** Who may watch its change topic, or `undefined`: closed. */
  readonly watchAccess: unknown;
  readonly methods: ReadonlyMap<string, MethodAccessDoc>;
  readonly collections: ReadonlyMap<string, CollectionAccessDoc>;
  /** Per channel: the access form its handler is called under. */
  readonly channels: ReadonlyMap<string, unknown>;
  readonly streams: ReadonlyMap<string, StreamServiceDoc>;
}

/** `value` as a map of named records, or `undefined` when it is not one. */
function recordsOf(value: unknown): ReadonlyMap<string, UnknownRecord> | undefined {
  if (!(value instanceof Map)) {
    return undefined;
  }
  for (const [key, member] of value as Map<unknown, unknown>) {
    if (typeof key !== "string" || !isRecord(member)) {
      return undefined;
    }
  }
  return value as ReadonlyMap<string, UnknownRecord>;
}

/** A `kinds` list as a service holds it, or `undefined` for anything else (every kind). */
function kindsOf(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((kind) => typeof kind === "string")
    ? (value as readonly string[])
    : undefined;
}

/** Each named member of `records`, read by `read`. */
function mapEach<T>(
  records: ReadonlyMap<string, UnknownRecord>,
  read: (record: UnknownRecord) => T,
): ReadonlyMap<string, T> {
  return new Map([...records].map(([name, record]) => [name, read(record)]));
}

/**
 * The service `value` is, read as the docs need it, or `undefined` for
 * anything that is not what `defineService` returns: an object with a name,
 * a contract, one record per method (its access form and handler), and its
 * collections, channels and streams as maps.
 */
export function serviceDocOf(value: unknown): ServiceDoc | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.contract)) {
    return undefined;
  }
  const { methods } = value;
  const collections = recordsOf(value.collections);
  const channels = recordsOf(value.channels);
  const streams = recordsOf(value.streams);
  if (
    !isRecord(methods) ||
    collections === undefined ||
    channels === undefined ||
    streams === undefined ||
    !Object.values(methods).every(
      (method) => isRecord(method) && typeof method.handler === "function" && "access" in method,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    name: value.name,
    policy: value.access,
    adminBypass: value.adminBypass !== false,
    kinds: kindsOf(value.kinds),
    watchAccess: value.watchAccess,
    methods: new Map(
      Object.entries(methods as Readonly<Record<string, UnknownRecord>>).map(([name, method]) => [
        name,
        { access: method.access, rowless: method.rowless === true, kinds: kindsOf(method.kinds) },
      ]),
    ),
    collections: mapEach(collections, (collection) => ({
      level: collection.access,
      anchor: collection.anchor,
    })),
    channels: mapEach(channels, (channel) => channel.access),
    streams: mapEach(streams, (stream) => ({
      computedSeed: typeof stream.computeSeed === "function",
      validate: stream.validate,
    })),
  });
}

/**
 * Every service a module exports, directly or in an exported list or map,
 * by name. Two different services with one name are an error, as they would
 * be on a server.
 */
export function servicesOf(exports: UnknownRecord): ReadonlyMap<string, ServiceDoc> {
  const found = new Map<string, { readonly from: unknown; readonly doc: ServiceDoc }>();
  const add = (value: unknown): void => {
    const doc = serviceDocOf(value);
    if (doc === undefined) {
      return;
    }
    const known = found.get(doc.name);
    if (known !== undefined && known.from !== value) {
      throw new Error(`two different services are named "${doc.name}"`);
    }
    found.set(doc.name, { from: value, doc });
  };
  for (const value of Object.values(exports)) {
    if (serviceDocOf(value) !== undefined) {
      add(value);
    } else if (Array.isArray(value)) {
      value.forEach(add);
    } else if (isRecord(value)) {
      Object.values(value).forEach(add);
    }
  }
  return new Map(
    [...found]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, { doc }]) => [name, doc]),
  );
}

/** A contract's service name, for a form or policy that names one. */
function serviceName(contract: unknown): string {
  return isRecord(contract) && typeof contract.name === "string"
    ? contract.name
    : "another service";
}

/** Which row an `entry` or `scope` form is about, as declared and in words. */
function idOf(id: unknown): { readonly declared: string; readonly words: string } {
  if (id === undefined) {
    return { declared: "", words: code("input.id") };
  }
  return typeof id === "string"
    ? { declared: `, id: "${id}"`, words: code(`input.${id}`) }
    : { declared: ", id: (input) => ...", words: "a function of the input" };
}

/** A method's (or a topic's, or a channel's) access form, as declared, then in words. */
export function accessFormText(form: unknown): string {
  if (form === "public") {
    return `${code('"public"')}: anyone, signed in or not`;
  }
  if (form === "authenticated") {
    return `${code('"authenticated"')}: any signed-in caller`;
  }
  if (!isRecord(form)) {
    return "not readable";
  }
  if (form.kind === "custom") {
    return `${code("custom(check)")}: a signed-in caller the service's own check lets through`;
  }
  const id = idOf(form.id);
  if (typeof form.scope === "string") {
    const of = serviceName(form.of);
    return `${code(`{ scope: "${form.scope}", of: ${of}${id.declared} }`)}: ${form.scope} or more on the ${code(of)} row ${id.words} names`;
  }
  const service = typeof form.service === "string" ? form.service : undefined;
  const entry = typeof form.entry === "string" ? form.entry : undefined;
  const declared = [
    service === undefined ? undefined : `service: "${service}"`,
    entry === undefined ? undefined : `entry: "${entry}"${id.declared}`,
  ].filter((part) => part !== undefined);
  const words = [
    service === undefined ? undefined : `a service-wide grant of ${service} or more`,
    entry === undefined ? undefined : `${entry} or more on the row ${id.words} names`,
  ].filter((part) => part !== undefined);
  return `${code(`{ ${declared.join(", ")} }`)}: ${words.join(", or ")}`;
}

/** How deep `anyOf` members are written out before they are only named. */
const MAX_POLICY_DEPTH = 3;

/** A row policy, in words. */
export function policyText(policy: unknown, depth = 0): string {
  if (!isRecord(policy) || typeof policy.kind !== "string") {
    return "none: its methods take no `entry` form";
  }
  const column = (name: unknown): string => code(String(name));
  switch (policy.kind) {
    case "owner":
      return `${code("owner")}: Admin for the user the ${column(policy.field)} column names`;
    case "jsonAcl": {
      const owner =
        typeof policy.owner === "string"
          ? `, and Admin for the user the ${column(policy.owner)} column names`
          : "";
      return `${code("jsonAcl")}: the level the ${column(policy.field)} column lists for the user${owner}`;
    }
    case "members": {
      const read = isRecord(policy.membership) ? policy.membership : {};
      return `${code("members")}: the role in the user's ${column(read.model)} row (${column(read.entry)} names the row, ${column(read.user)} the user, ${column(read.level)} the role)`;
    }
    case "inherit":
      return `${code("inherit")}: the level on the ${code(serviceName(policy.from))} row the ${column(policy.via)} column names`;
    case "anyOf": {
      const members = Array.isArray(policy.policies) ? (policy.policies as unknown[]) : [];
      return depth >= MAX_POLICY_DEPTH
        ? code("anyOf")
        : `${code("anyOf")}: the highest level of ${members.map((member) => `(${policyText(member, depth + 1)})`).join(", ")}`;
    }
    case "resolver":
      return `${code("resolver")}: the service's own code`;
    case "everyone":
      return `${code("everyone")}: ${String(policy.level)} for every signed-in user, on every row`;
    default:
      return code(policy.kind);
  }
}

/** Who may watch a service's change topic. */
export function watchAccessText(watch: unknown): string {
  return watch === undefined
    ? `closed: the service declares no ${code("watchAccess")}`
    : accessFormText(watch);
}

/** Who may open a scope of a collection. */
export function collectionAccessText(collection: CollectionAccessDoc): string {
  if (collection.anchor === undefined) {
    return `the subscriber's own user id (${code('scopeAccess: "self"')})`;
  }
  return `${String(collection.level)} or more on the ${code(serviceName(collection.anchor))} row the scope names`;
}
