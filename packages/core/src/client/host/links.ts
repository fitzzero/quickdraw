// A connection's ways to the hosts of its rooms (host mode, RFC 0003 section
// 12.5): one per room, to the host `qd:host` named (`hosts.ts`). A link
// (`createPeerLink`, `offerer: true`) is made when a host-served channel's
// message or a host-served stream's feed first needs one, and again when
// the room gets another host or the link closed while a feed still needs
// it. After a link closes, the next to the same host waits
// (`HOST_LINK_RETRY_MS`, doubling up to `HOST_LINK_MAX_RETRY_MS` while links
// keep closing unopened): a game that sends input each frame makes no link
// a frame when the server refuses them. When the host is this
// connection's own socket and it serves the room (`defineHost(...).serve`),
// the way is an in-process link (`local.ts`): the host hears this client as
// one of its peers, over a link like theirs.
//
// No peer code is imported here, nor by `hosts.ts`, since every typed
// client reaches both: the serving hands in its in-process link's maker
// and `controlOf` with its host (`registerLocalHost`), and `./remote` (the
// peer link, WebRTC, the relay, the lag simulator) loads on demand, once
// the server announces peer links (`hello.limits.peers`) or at the first
// link, whichever comes first. A tab then holds it before a redeploy
// removes the chunk it was built with.
//
// A channel's message sent while no way is open is dropped, as a channel
// message is when the connection is backed up. A feed subscribes (`[4]`)
// each time a way opens; its seed (`[6]`, in chunks) replaces what it held,
// items (`[7]`) append, a refusal (`[8]`) shows its error, and a way that
// closes leaves its items until the next seed.
//
// React-free.

import type { HostMessage } from "../../protocol/envelope";
import type { WireError } from "../../protocol/errors";
import { isRecord } from "../../protocol/guards";
import { MAX_PEER_MESSAGE_BYTES } from "../../protocol/version";
import type { QuickdrawConnection } from "../connection";
import type { controlOf, LinkControl } from "../peer/core";
import type { PeerLink } from "../peer/types";
import { hostsOf, type HostDirectory } from "./hosts";
import type { createLocalLink } from "./local";
import type * as Remote from "./remote";

/** One feed of a host-served stream, as the stream store holds it. */
export interface HostFeed {
  readonly service: string;
  readonly stream: string;
  readonly scope: string;
  /** The seed, whole: what the feed shows from now on. */
  seeded(items: readonly unknown[]): void;
  item(item: unknown): void;
  refused(error: WireError): void;
  /** The way to the host closed: the next seed replaces what the feed holds. */
  lost(): void;
}

/** A connection's ways to its rooms' hosts. */
export interface HostLinks {
  /** Sends a host-served channel's message to the host of `room`; false when no way is open. */
  send(room: string, service: string, channel: string, payload: unknown): boolean;
  /** Holds a feed of a host-served stream in `room`, subscribed whenever a way opens; returns its release. */
  subscribe(room: string, feed: HostFeed): () => void;
}

/**
 * How a room's host served by this connection takes this client as a peer:
 * the host's end of their in-process link, open.
 */
export type LocalHost = (link: PeerLink) => void;

/**
 * What the serving hands in for its in-process link, so this module
 * imports no peer code: `createLocalLink`, and `controlOf` for its ends.
 */
export interface LocalLinks {
  readonly createLink: typeof createLocalLink;
  readonly controlOf: typeof controlOf;
}

/**
 * After a link to a room's host closed, the next to that host waits this
 * long, doubling while links keep closing unopened.
 */
export const HOST_LINK_RETRY_MS = 1000;

/** The longest wait before the next link to a room's host. */
export const HOST_LINK_MAX_RETRY_MS = 15_000;

/** The items a peer keeps of a seed in chunks, the latest: as many as a feed shows. */
export const MAX_SEED_ITEMS = 10_000;

interface Way {
  readonly send: LinkControl["send"];
  readonly close: () => void;
}

/** A room's host this connection serves, and what makes its in-process link. */
interface LocalServing extends LocalLinks {
  readonly host: LocalHost;
}

interface RoomState {
  readonly room: string;
  /** The host the way below goes to. */
  host: string | undefined;
  /** Open, and what sends on it. */
  way: Way | undefined;
  /** Made, not closed yet: a link connecting or open, the in-process way, or `./remote` loading for a link. */
  pending: (() => void) | undefined;
  readonly feeds: Map<string, { readonly feed: HostFeed; chunks: unknown[] | undefined }>;
  retry: ReturnType<typeof setTimeout> | undefined;
  retryMs: number;
  /** After a link closed: no link to `host` opens before `until` (`Date.now()`). */
  backoff: { readonly host: string; readonly until: number } | undefined;
}

interface LinksState {
  readonly connection: QuickdrawConnection;
  readonly directory: HostDirectory;
  readonly rooms: Map<string, RoomState>;
  readonly locals: Map<string, LocalServing>;
}

/** `./remote`, loading or loaded: `undefined` before the first load and after a failed one. */
let remote: Promise<typeof Remote> | undefined;

/** Loads `./remote` once, for every connection; a failed load is tried again by the next caller. */
function loadRemote(): Promise<typeof Remote> {
  remote ??= import("./remote").catch((error: unknown) => {
    remote = undefined;
    throw error;
  });
  return remote;
}

/**
 * Starts loading `./remote` once `connection`'s server announces peer
 * links (`hello.limits.peers`, from `createServer({ peers: true })`); a
 * server without them never has it loaded. A failed load waits for the
 * first link, which tries again.
 */
function loadWhenAnnounced(connection: QuickdrawConnection): void {
  const announced = (): boolean => {
    // As the server sent it: a hello without limits announces nothing.
    const limits: unknown = connection.getState().hello?.limits;
    return isRecord(limits) && limits.peers !== undefined;
  };
  const load = (): void => {
    loadRemote().catch(() => undefined);
  };
  if (announced()) {
    load();
    return;
  }
  const stop = connection.subscribe(() => {
    if (announced()) {
      stop();
      load();
    }
  });
}

const feedKey = (service: string, stream: string, scope: string): string =>
  `${service}\u0000${stream}\u0000${scope}`;

function onMessage(state: RoomState, message: HostMessage): void {
  if (message[0] !== 6 && message[0] !== 7 && message[0] !== 8) {
    return;
  }
  const entry = state.feeds.get(feedKey(message[1], message[2], message[3]));
  if (entry === undefined) {
    return;
  }
  if (message[0] === 6) {
    const chunks = [...(entry.chunks ?? []), ...message[4]].slice(-MAX_SEED_ITEMS);
    entry.chunks = message[5] ? undefined : chunks;
    if (message[5]) {
      entry.feed.seeded(chunks);
    }
  } else if (message[0] === 7) {
    entry.feed.item(message[4]);
  } else if (message[0] === 8) {
    entry.feed.refused(message[4]);
  }
}

function subscribeOn(way: Way, feed: HostFeed): void {
  way.send("rel", [4, feed.service, feed.stream, feed.scope]);
}

function opened(state: RoomState, way: Way): void {
  state.way = way;
  state.retryMs = HOST_LINK_RETRY_MS;
  state.backoff = undefined;
  for (const entry of state.feeds.values()) {
    entry.chunks = undefined;
    subscribeOn(way, entry.feed);
  }
}

/** Ends the room's way, if any; its feeds wait for the next seed. */
function disconnect(state: RoomState): void {
  const { pending } = state;
  state.pending = undefined;
  state.way = undefined;
  state.host = undefined;
  clearTimeout(state.retry);
  state.retry = undefined;
  pending?.();
  for (const entry of state.feeds.values()) {
    entry.chunks = undefined;
    entry.feed.lost();
  }
}

/**
 * Takes `link` to the room's host at `host`, whose control side is
 * `control`, as the room's way: open, it subscribes the feeds; closed, the
 * next link waits.
 */
function takeLink(
  links: LinksState,
  state: RoomState,
  host: string,
  link: PeerLink,
  control: LinkControl | undefined,
): void {
  if (control === undefined) {
    return;
  }
  const way: Way = {
    send: (label, message) => control.send(label, message),
    close: () => {
      link.close();
    },
  };
  state.pending = way.close;
  control.on((message) => {
    onMessage(state, message);
  });
  const open = (): void => {
    if (state.pending === way.close) {
      opened(state, way);
    }
  };
  link.on("open", open);
  link.on("close", () => {
    if (state.pending === way.close) {
      disconnect(state);
      retryLater(links, state, host);
    }
  });
  if (link.state === "open") {
    open();
  }
}

/** The in-process link to a host this connection serves, open at once. */
function connectLocal(
  links: LinksState,
  state: RoomState,
  local: LocalServing,
  self: string,
): void {
  const { connection } = links;
  const userId = connection.getState().hello?.userId ?? "";
  const [near, far] = local.createLink(
    state.room,
    self,
    userId,
    () => connection.getState().hello?.limits.peers?.maxMessageBytes ?? MAX_PEER_MESSAGE_BYTES,
  );
  local.host(far);
  takeLink(links, state, self, near, local.controlOf(near));
}

/**
 * A link to the room's host at `host`, once `./remote` has loaded: the way
 * is pending meanwhile, so `connect` makes no other. A load the room no
 * longer waits for (its way ended, or its host changed) is dropped, and a
 * load that failed is a link that closed: the next waits.
 */
function connectLink(links: LinksState, state: RoomState, host: string): void {
  const loading = (): void => undefined;
  state.pending = loading;
  void loadRemote().then(
    ({ createPeerLink, controlOf }) => {
      if (state.pending !== loading) {
        return;
      }
      state.pending = undefined;
      if (links.directory.of(state.room) !== host) {
        disconnect(state);
        return;
      }
      let link;
      try {
        link = createPeerLink(links.connection, { room: state.room, to: host, offerer: true });
      } catch {
        // A link the app opened itself to the host, in this room: host mode leaves it alone.
        return;
      }
      takeLink(links, state, host, link, controlOf(link));
    },
    () => {
      if (state.pending === loading) {
        disconnect(state);
        retryLater(links, state, host);
      }
    },
  );
}

/**
 * Opens a way to the room's host, unless one to it is open or being made,
 * or a link to it closed within the wait.
 */
function connect(links: LinksState, state: RoomState): void {
  const host = links.directory.of(state.room);
  if (host === undefined || (state.host === host && state.pending !== undefined)) {
    return;
  }
  if (state.backoff?.host === host && Date.now() < state.backoff.until) {
    return;
  }
  if (state.pending !== undefined) {
    disconnect(state);
  }
  state.host = host;
  const self = links.connection.socket.id;
  const local = links.locals.get(state.room);
  if (host === self) {
    if (local !== undefined && self !== undefined) {
      connectLocal(links, state, local, self);
    }
    return;
  }
  connectLink(links, state, host);
}

/**
 * A link to `host` closed: the next to it waits, and doubles the wait after
 * it. With feeds to serve then (a feed held during the wait included), links
 * again, while the room has a host.
 */
function retryLater(links: LinksState, state: RoomState, host: string): void {
  const wait = state.retryMs;
  state.backoff = { host, until: Date.now() + wait };
  state.retryMs = Math.min(HOST_LINK_MAX_RETRY_MS, wait * 2);
  if (links.directory.of(state.room) === undefined) {
    return;
  }
  clearTimeout(state.retry);
  state.retry = setTimeout(() => {
    state.retry = undefined;
    state.backoff = undefined;
    if (state.feeds.size > 0) {
      connect(links, state);
    }
  }, wait);
}

function roomOf(links: LinksState, room: string): RoomState {
  let state = links.rooms.get(room);
  if (state === undefined) {
    state = {
      room,
      host: undefined,
      way: undefined,
      pending: undefined,
      feeds: new Map(),
      retry: undefined,
      retryMs: HOST_LINK_RETRY_MS,
      backoff: undefined,
    };
    links.rooms.set(room, state);
  }
  return state;
}

function createLinks(connection: QuickdrawConnection): LinksState & HostLinks {
  const links: LinksState = {
    connection,
    directory: hostsOf(connection),
    rooms: new Map(),
    locals: new Map(),
  };
  loadWhenAnnounced(connection);
  links.directory.listen((room, host) => {
    const state = links.rooms.get(room);
    if (state === undefined) {
      return;
    }
    if (host === null) {
      disconnect(state);
      return;
    }
    // The server named the room's host again (another host, or this socket
    // joined again): its first link opens at once.
    state.backoff = undefined;
    state.retryMs = HOST_LINK_RETRY_MS;
    if (state.feeds.size > 0) {
      connect(links, state);
    }
  });
  return Object.freeze({
    ...links,
    send(room: string, service: string, channel: string, payload: unknown): boolean {
      const state = roomOf(links, room);
      connect(links, state);
      return state.way?.send("fast", [3, service, channel, payload]) ?? false;
    },
    subscribe(room: string, feed: HostFeed): () => void {
      const state = roomOf(links, room);
      const key = feedKey(feed.service, feed.stream, feed.scope);
      const entry = { feed, chunks: undefined };
      state.feeds.set(key, entry);
      const { way } = state;
      connect(links, state);
      // A way `connect` opened (the in-process link) subscribed every feed already.
      if (way !== undefined && state.way === way) {
        subscribeOn(way, feed);
      }
      return () => {
        if (state.feeds.get(key) === entry) {
          state.feeds.delete(key);
          state.way?.send("rel", [5, feed.service, feed.stream, feed.scope]);
        }
      };
    },
  });
}

const all = new WeakMap<QuickdrawConnection, LinksState & HostLinks>();

function linksStateOf(connection: QuickdrawConnection): LinksState & HostLinks {
  let links = all.get(connection);
  if (links === undefined) {
    links = createLinks(connection);
    all.set(connection, links);
  }
  return links;
}

/** The ways of `connection` to its rooms' hosts, made on first use. */
export function hostLinksOf(connection: QuickdrawConnection): HostLinks {
  return linksStateOf(connection);
}

/**
 * Registers the host this connection serves for `room`, so this client's
 * own channels and feeds of the room reach it in process, over the link
 * `local` makes (the serving hands it in, so this module imports no peer
 * code); returns its removal.
 */
export function registerLocalHost(
  connection: QuickdrawConnection,
  room: string,
  host: LocalHost,
  local: LocalLinks,
): () => void {
  const links = linksStateOf(connection);
  const serving: LocalServing = { host, ...local };
  links.locals.set(room, serving);
  const state = links.rooms.get(room);
  if (state !== undefined && state.feeds.size > 0) {
    connect(links, state);
  }
  return () => {
    if (links.locals.get(room) === serving) {
      links.locals.delete(room);
      const current = links.rooms.get(room);
      if (current !== undefined && current.host === connection.socket.id) {
        disconnect(current);
      }
    }
  };
}
