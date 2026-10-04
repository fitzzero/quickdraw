// The run-time half of `defineService`'s channels and streams (RFC 0003
// section 12.5): one handler per channel of the contract, no more and no
// fewer, with its access; and each stream's access form as the access engine
// decides it. The types make the same checks; these catch JavaScript callers
// and casts when the service is defined.

import { isAccessLevel } from "../../contract/access";
import type { AnyContract } from "../../contract/defineContract";
import { reservedRoomPrefix } from "../../contract/names";
import {
  CHANNEL_DEFAULT_RATE,
  isScopedStream,
  type ChannelDef,
  type PayloadSelector,
  type RoomSelector,
  type StreamAccess,
  type StreamDef,
} from "../../contract/realtime";
import type { AccessForm } from "../access/types";
import type {
  AnyChannelHandler,
  ChannelAccess,
  CompiledSelector,
  ServiceChannel,
  ServiceStream,
} from "./types";

type Fail = (message: string) => never;

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A payload key, or a function of the payload, as a function that returns a non-empty string or nothing. */
function compileSelector(selector: PayloadSelector): CompiledSelector {
  const read =
    typeof selector === "function"
      ? (selector as (payload: unknown) => unknown)
      : (payload: unknown) => (isRecord(payload) ? payload[selector] : undefined);
  return (payload) => {
    try {
      const value = read(payload);
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      // A selector that throws names nothing: the message is dropped.
      return undefined;
    }
  };
}

/**
 * The app room a message must come from: a fixed name (checked when the
 * contract was defined), or a function of the payload whose answer names no
 * room when it is not a string, is empty or is reserved (`qd:`, `user:`),
 * since a socket is never in such a room as an app room.
 */
function compileRoom(room: RoomSelector): CompiledSelector {
  if (typeof room === "string") {
    return () => room;
  }
  const computed = compileSelector(room);
  return (payload) => {
    const name = computed(payload);
    return name === undefined || reservedRoomPrefix(name) !== undefined ? undefined : name;
  };
}

function compileRequires(def: ChannelDef): ServiceChannel["requires"] {
  const { requires } = def;
  if (requires === undefined) {
    return undefined;
  }
  if (requires.room !== undefined) {
    return { kind: "room", select: compileRoom(requires.room) };
  }
  if (requires.collection === undefined) {
    return { kind: "entity", select: compileSelector(requires.entity) };
  }
  return {
    kind: "collection",
    collection: requires.collection,
    select: compileSelector(requires.scope),
  };
}

function checkChannelAccess(owner: string, access: unknown, fail: Fail): ChannelAccess {
  if (access === undefined || access === "authenticated") {
    return "authenticated";
  }
  const keys = isRecord(access) ? Object.keys(access) : [];
  if (!isRecord(access) || keys.length !== 1 || !isAccessLevel(access.service)) {
    fail(`${owner}: access must be "authenticated" or { service: level }`);
  }
  return Object.freeze({ service: access.service });
}

function checkChannel(
  service: string,
  name: string,
  def: ChannelDef,
  entry: unknown,
  fail: Fail,
): ServiceChannel {
  const owner = `channel "${name}"`;
  const implementation = typeof entry === "function" ? { handler: entry } : entry;
  if (!isRecord(implementation) || typeof implementation.handler !== "function") {
    fail(`${owner} must be a handler function or { access, handler }`);
  }
  const unknownKey = Object.keys(implementation).find(
    (key) => !["access", "handler"].includes(key),
  );
  if (unknownKey !== undefined) {
    fail(`${owner} has an unknown option "${unknownKey}"; the options are access, handler`);
  }
  const ratePerSecond = def.ratePerSecond ?? CHANNEL_DEFAULT_RATE;
  return Object.freeze({
    service,
    name,
    payload: def.payload,
    ratePerSecond,
    // At least one token, so a slow channel (0.2 a second) still lets a message through.
    burst: def.burst ?? Math.max(1, ratePerSecond * 2),
    requires: compileRequires(def),
    access: checkChannelAccess(owner, implementation.access, fail),
    handler: implementation.handler as AnyChannelHandler,
  });
}

/**
 * The channels of a service: `defineService`'s `channels` option checked
 * against the contract's channels, one implementation each.
 */
export function compileChannels(
  contract: AnyContract,
  value: unknown,
  fail: Fail,
): ReadonlyMap<string, ServiceChannel> {
  const declared = Object.entries(contract.channels);
  if (value === undefined && declared.length === 0) {
    return new Map();
  }
  if (!isRecord(value)) {
    fail("channels must be an object with one implementation per contract channel");
  }
  const missing = declared.filter(([name]) => !Object.hasOwn(value, name)).map(([name]) => name);
  if (missing.length > 0) {
    fail(`channels has no implementation for ${missing.map((name) => `"${name}"`).join(", ")}`);
  }
  const channels = new Map<string, ServiceChannel>();
  for (const [name, entry] of Object.entries(value)) {
    const def = Object.hasOwn(contract.channels, name) ? contract.channels[name] : undefined;
    if (def === undefined) {
      fail(`"${name}" is not a channel of the contract`);
    }
    channels.set(name, checkChannel(contract.name, name, def, entry, fail));
  }
  return channels;
}

/** A stream's access as the engine decides it: the scope is the row id an entry or scope form checks. */
function engineForm(access: StreamAccess | undefined): AccessForm | undefined {
  if (access === undefined || typeof access === "string") {
    return access;
  }
  if (access.scope !== undefined) {
    return Object.freeze({ scope: access.scope, of: access.of, id: "scope" });
  }
  if (access.entry !== undefined) {
    const service = access.service === undefined ? {} : { service: access.service };
    return Object.freeze({ entry: access.entry, ...service, id: "scope" });
  }
  return Object.freeze({ service: access.service });
}

/** What a service declares that its streams' row-level access forms need. */
export interface StreamNeeds {
  readonly model: string | undefined;
  readonly hasPolicy: boolean;
}

function checkStream(name: string, def: StreamDef, needs: StreamNeeds, fail: Fail): ServiceStream {
  const access = engineForm(def.access);
  if (typeof access === "object" && "entry" in access && !needs.hasPolicy) {
    fail(
      `stream "${name}" uses entry access, which needs the service's access policy: declare model and access`,
    );
  }
  if (typeof access === "object" && "scope" in access && needs.model === undefined) {
    fail(
      `stream "${name}" uses scope access, but the service declares no model; a service without a model may only use "public", "authenticated" or { service } access`,
    );
  }
  return Object.freeze({
    name,
    item: def.item,
    scoped: isScopedStream(def),
    seed: def.seed ?? 0,
    volatile: def.volatile === true,
    access,
  });
}

/** The streams of a service, from its contract, with the access forms checked against what it declares. */
export function compileStreams(
  contract: AnyContract,
  needs: StreamNeeds,
  fail: Fail,
): ReadonlyMap<string, ServiceStream> {
  const streams = new Map<string, ServiceStream>();
  for (const [name, def] of Object.entries(contract.streams)) {
    streams.set(name, checkStream(name, def, needs, fail));
  }
  return streams;
}
