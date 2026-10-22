// The sections `quickdraw-docs` writes for a contract's realtime members
// (`render.ts`): its streams, channels and events, with what a subscriber
// starts from, what a channel requires of its sender, and which members
// the room's host serves (host mode) rather than the server.

import {
  CHANNEL_DEFAULT_RATE,
  isHostServed,
  isScopedStream,
  type ChannelDef,
  type EventDef,
  type StreamAccess,
  type StreamDef,
} from "../contract/realtime";
import { accessFormText, type ServiceDoc } from "./access";
import { code, described, optionTable, section } from "./markdown";
import { typeOf } from "./schemaText";

/**
 * What a subscriber starts from (finding F6.8 of the quickdraw-chat
 * migration): the contract's `seed`, or a seed the service computes, which
 * only a page made with `--services` (`known`) can tell from none.
 */
function seedText(seed: number | undefined, computed: boolean, known: boolean): string {
  if (computed) {
    return "computed by the service when a socket subscribes";
  }
  if (seed === undefined) {
    return known ? "none (default)" : "none in the contract; the service may compute one";
  }
  if (seed === 0) {
    return "none";
  }
  return seed === 1 ? "the latest item" : `the latest ${seed} items`;
}

/** The "Served by" of a host-served stream or channel; nothing for a server-served one. */
function servedByText(def: { readonly serve?: unknown }): string | undefined {
  return isHostServed(def)
    ? `the room's host (${code('serve: "host"')}), over peer links: the server never handles it`
    : undefined;
}

/** A host-served stream's seed: what its host keeps, or computes. */
function hostSeedText(seed: number | undefined): string {
  if (seed === undefined || seed === 0) {
    return "none kept by the host; the host may compute one";
  }
  return `the latest ${seed === 1 ? "item" : `${seed} items`} the host kept, or the host's own`;
}

/** What a channel's `requires` asks of the sending socket. */
function requiresText(requires: ChannelDef["requires"]): string | undefined {
  if (requires === undefined) {
    return undefined;
  }
  const selector = (value: unknown): string =>
    typeof value === "string" ? code(value) : "a function of the payload";
  if (requires.room !== undefined) {
    return typeof requires.room === "string"
      ? `the sending socket in the app room ${code(requires.room)}`
      : "the sending socket in the app room a function of the payload names";
  }
  return requires.collection === undefined
    ? `a subscription to the row ${selector(requires.entity)} names`
    : `a subscription to the ${code(requires.collection)} scope ${selector(requires.scope)} names`;
}

/** Who may subscribe to a stream, as its contract says. */
function accessText(access: StreamAccess | undefined): string {
  if (access === undefined) {
    return "none: closed to every client";
  }
  if (typeof access === "string") {
    return code(JSON.stringify(access));
  }
  if (access.room !== undefined) {
    const { room } = access;
    if (typeof room === "string") {
      return code(`{ room: "${room}" }`);
    }
    return typeof room === "function"
      ? code("{ room: (scope) => ... }")
      : code(`{ room: { prefix: "${room.prefix}" } }`);
  }
  if (access.scope !== undefined) {
    return code(`{ scope: "${access.scope}", of: ${access.of.name} }`);
  }
  const parts = [
    access.service === undefined ? undefined : `service: "${access.service}"`,
    access.entry === undefined ? undefined : `entry: "${access.entry}"`,
  ].filter((part) => part !== undefined);
  return code(`{ ${parts.join(", ")} }`);
}

/** A stream's section of a page; `service` with `--services`. */
export function streamSection(
  name: string,
  stream: StreamDef,
  service: ServiceDoc | undefined,
): string[] {
  const scoped = isScopedStream(stream);
  const served = service?.streams.get(name);
  return section(`### ${code(name)}`, [
    ...described(stream.describe),
    optionTable([
      ["Served by", servedByText(stream)],
      ["Item", code(typeOf(stream.item, "output"))],
      ["Scope", scoped ? `one feed per ${code(stream.scope ?? "")}` : "one global feed"],
      [
        "Seed",
        isHostServed(stream)
          ? hostSeedText(stream.seed)
          : seedText(stream.seed, served?.computedSeed === true, served !== undefined),
      ],
      ["Volatile", stream.volatile === true ? "yes" : "no"],
      ["Access", accessText(stream.access)],
      [
        "Checked",
        served === undefined
          ? undefined
          : served.validate === "development"
            ? `in development only (${code('validate: "development"')})`
            : "always",
      ],
    ]),
  ]);
}

/** A channel's section of a page; `service` with `--services`. */
export function channelSection(
  name: string,
  channel: ChannelDef,
  service: ServiceDoc | undefined,
): string[] {
  const rate = channel.ratePerSecond ?? CHANNEL_DEFAULT_RATE;
  const served = service?.channels.has(name) === true;
  return section(`### ${code(name)}`, [
    ...described(channel.describe),
    optionTable([
      ["Served by", servedByText(channel)],
      ["Payload", code(typeOf(channel.payload, "input"))],
      [
        "Rate",
        `${rate} a second per socket${channel.ratePerSecond === undefined ? " (default)" : ""}`,
      ],
      [
        "Burst",
        channel.burst === undefined ? `${Math.max(1, 2 * rate)} (default)` : String(channel.burst),
      ],
      ["Requires", requiresText(channel.requires)],
      ["Access", served ? accessFormText(service?.channels.get(name)) : undefined],
    ]),
  ]);
}

/** An event's section of a page. */
export function eventSection(name: string, event: EventDef): string[] {
  return section(`### ${code(name)}`, [
    ...described(event.describe),
    optionTable([["Payload", code(typeOf(event.payload, "output"))]]),
  ]);
}
