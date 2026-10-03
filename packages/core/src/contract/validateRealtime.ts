// Definition-time checks of a contract's streams, channels and events (RFC
// 0003 section 12.5), for `validateContract.ts`. The types catch the same
// mistakes at compile time; these catch them for JavaScript callers and casts.
// Every member name is checked against the names taken before it: methods,
// collections, streams, channels and events share `qd.<service>.<name>`.

import { ACCESS_LEVELS, isAccessLevel } from "./access";
import type { ChannelDef, EventDef, StreamDef } from "./realtime";
import { isScopedStream, STREAM_MAX_SEED } from "./realtime";
import { isStandardSchema } from "./standardSchema";

type Fail = (message: string) => never;

type UnknownRecord = Readonly<Record<string, unknown>>;

/** The member names taken so far, and by what kind of member. */
export type TakenNames = Map<string, string>;

/** What the realtime members are checked against. */
export interface RealtimeScope {
  readonly hasEntity: boolean;
  readonly collections: ReadonlySet<string>;
  readonly taken: TakenNames;
  readonly reserved: ReadonlySet<string>;
}

const STREAM_KEYS: ReadonlySet<string> = new Set(["item", "scope", "seed", "volatile", "access"]);
const CHANNEL_KEYS: ReadonlySet<string> = new Set([
  "payload",
  "ratePerSecond",
  "burst",
  "requires",
]);
const EVENT_KEYS: ReadonlySet<string> = new Set(["payload"]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function quote(names: Iterable<string>): string {
  return [...names].map((name) => `"${name}"`).join(", ");
}

/** The members of an optional map: absent is empty, anything else must be a plain object. */
function entriesOf(value: unknown, label: string, fail: Fail): [string, unknown][] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }
  return Object.entries(value);
}

function checkName(kind: string, name: string, scope: RealtimeScope, fail: Fail): void {
  if (scope.reserved.has(name) || name.startsWith("$")) {
    fail(
      `${kind} "${name}" uses a reserved name; ${quote(scope.reserved)} and names starting with "$" are reserved`,
    );
  }
  const holder = scope.taken.get(name);
  if (holder !== undefined) {
    fail(
      `${kind} "${name}" has the same name as a ${holder}; the client exposes both as qd.<service>.${name}`,
    );
  }
  scope.taken.set(name, kind);
}

function checkMember(
  kind: string,
  name: string,
  value: unknown,
  schemaKey: "item" | "payload",
  keys: ReadonlySet<string>,
  fail: Fail,
): UnknownRecord {
  if (!isRecord(value) || !isStandardSchema(value[schemaKey])) {
    fail(`${kind} "${name}" must be { ${schemaKey}: <Standard Schema>, ... }`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      fail(`${kind} "${name}" has an unknown option "${key}"; the options are ${quote(keys)}`);
    }
  }
  return value;
}

/** Why `access` is not a stream access form, or `undefined` when it is one. */
function streamAccessProblem(access: unknown): string | undefined {
  if (access === "public" || access === "authenticated") {
    return undefined;
  }
  const levels = isRecord(access)
    ? ["service", "entry", "scope"].filter((key) => access[key] !== undefined)
    : [];
  if (
    !isRecord(access) ||
    levels.length === 0 ||
    !levels.every((key) => isAccessLevel(access[key]))
  ) {
    return `must be "public", "authenticated", { service }, { entry } or { scope, of }, with levels among ${quote(ACCESS_LEVELS)}`;
  }
  const extra = Object.keys(access).find(
    (key) => !["service", "entry", "scope", "of"].includes(key),
  );
  if (extra !== undefined) {
    return `has an unknown key "${extra}"`;
  }
  if (access.scope !== undefined) {
    const of: unknown = access.of;
    return levels.length === 1 && isRecord(of) && isName(of.name)
      ? undefined
      : "a scope form is { scope, of: contract } and nothing else";
  }
  return access.of === undefined ? undefined : "of belongs to scope forms";
}

function checkStream(name: string, value: unknown, fail: Fail): StreamDef {
  const owner = `stream "${name}"`;
  const stream = checkMember("stream", name, value, "item", STREAM_KEYS, fail);
  if (name.includes(":")) {
    fail(`${owner} may not contain ":"; it is part of the stream's room name`);
  }
  if (stream.scope !== undefined && !isName(stream.scope)) {
    fail(`${owner}: scope must be "global" or a non-empty name for what a scope value is`);
  }
  const { seed } = stream;
  if (
    seed !== undefined &&
    !(Number.isInteger(seed) && (seed as number) >= 0 && (seed as number) <= STREAM_MAX_SEED)
  ) {
    fail(`${owner}: seed must be a whole number from 0 to ${STREAM_MAX_SEED}`);
  }
  if (stream.volatile !== undefined && typeof stream.volatile !== "boolean") {
    fail(`${owner}: volatile must be a boolean`);
  }
  if (stream.access !== undefined) {
    const problem = streamAccessProblem(stream.access);
    if (problem !== undefined) {
      fail(`${owner}: access ${problem}`);
    }
    const access = stream.access as UnknownRecord | string;
    const rowForm = isRecord(access) && (access.entry !== undefined || access.scope !== undefined);
    if (rowForm && !isScopedStream(stream as Pick<StreamDef, "scope">)) {
      fail(`${owner}: entry and scope access check the scope's row, so the stream needs a scope`);
    }
  }
  return Object.freeze({ ...stream }) as unknown as StreamDef;
}

function isSelector(value: unknown): boolean {
  return isName(value) || typeof value === "function";
}

function checkRequires(owner: string, requires: unknown, scope: RealtimeScope, fail: Fail): void {
  if (requires === undefined) {
    return;
  }
  const form = isRecord(requires) ? requires : {};
  if (form.entity !== undefined && form.collection === undefined && form.scope === undefined) {
    if (!isSelector(form.entity)) {
      fail(`${owner}: requires.entity must be a payload key or a function of the payload`);
    }
    if (!scope.hasEntity) {
      fail(`${owner}: requires.entity needs the contract's entity`);
    }
    return;
  }
  if (form.entity !== undefined || !isName(form.collection) || !isSelector(form.scope)) {
    fail(`${owner}: requires must be { entity } or { collection, scope }`);
  }
  if (!scope.collections.has(form.collection)) {
    fail(
      `${owner}: requires names unknown collection "${form.collection}"; the collections are ${quote(scope.collections)}`,
    );
  }
}

function checkChannel(name: string, value: unknown, scope: RealtimeScope, fail: Fail): ChannelDef {
  const owner = `channel "${name}"`;
  const channel = checkMember("channel", name, value, "payload", CHANNEL_KEYS, fail);
  const positive = (rate: unknown, least: number): boolean =>
    rate === undefined || (typeof rate === "number" && Number.isFinite(rate) && rate >= least);
  if (!positive(channel.ratePerSecond, Number.MIN_VALUE)) {
    fail(`${owner}: ratePerSecond must be a number of messages above 0`);
  }
  if (!positive(channel.burst, 1)) {
    fail(`${owner}: burst must be a number of messages, at least 1`);
  }
  checkRequires(owner, channel.requires, scope, fail);
  return Object.freeze({ ...channel }) as unknown as ChannelDef;
}

/**
 * Checks the `streams`, `channels` and `events` of a contract definition,
 * taking their names in `scope.taken` after the methods and collections, and
 * returns them frozen.
 */
export function checkRealtime(
  def: UnknownRecord,
  scope: RealtimeScope,
  fail: Fail,
): {
  readonly streams: Readonly<Record<string, StreamDef>>;
  readonly channels: Readonly<Record<string, ChannelDef>>;
  readonly events: Readonly<Record<string, EventDef>>;
} {
  const streams: Record<string, StreamDef> = {};
  for (const [name, value] of entriesOf(def.streams, "streams", fail)) {
    checkName("stream", name, scope, fail);
    streams[name] = checkStream(name, value, fail);
  }
  const channels: Record<string, ChannelDef> = {};
  for (const [name, value] of entriesOf(def.channels, "channels", fail)) {
    checkName("channel", name, scope, fail);
    channels[name] = checkChannel(name, value, scope, fail);
  }
  const events: Record<string, EventDef> = {};
  for (const [name, value] of entriesOf(def.events, "events", fail)) {
    checkName("event", name, scope, fail);
    const event = checkMember("event", name, value, "payload", EVENT_KEYS, fail);
    events[name] = Object.freeze({ ...event }) as unknown as EventDef;
  }
  return {
    streams: Object.freeze(streams),
    channels: Object.freeze(channels),
    events: Object.freeze(events),
  };
}
