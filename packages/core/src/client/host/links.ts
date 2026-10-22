// A connection's ways to the hosts of its rooms (host mode, RFC 0003 section
// 12.5): one per room, to the host `qd:host` named (`hosts.ts`). A link
// (`createPeerLink`, `offerer: true`) is made when a host-served channel's
// message or a host-served stream's feed first needs one, and again when
// the room gets another host or the link closed while a feed still needs
// it (after a wait that doubles from 1 s to 15 s). When the host is this
// connection's own socket and it serves the room (`defineHost(...).serve`),
// the way is in process: the host hears this client as one of its peers.
//
// A channel's message sent while no way is open is dropped, as a channel
// message is when the connection is backed up. A feed subscribes (`[4]`)
// each time a way opens; its seed (`[6]`, in chunks) replaces what it held,
// items (`[7]`) append, a refusal (`[8]`) shows its error, and a way that
// closes leaves its items until the next seed.
//
// React-free.

import type { HostMessage, PeerLabel } from "../../protocol/envelope";
import type { WireError } from "../../protocol/errors";
import type { QuickdrawConnection } from "../connection";
import { controlOf } from "../peer/core";
import { createPeerLink } from "../peer/link";
import { hostsOf, type HostDirectory } from "./hosts";
import type { AttachedPeer, HostPeer, HostSend } from "./runtime";

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

/** How a room's host served by this connection takes this client as a peer, in process. */
export type LocalHost = (peer: HostPeer, send: HostSend) => AttachedPeer;

const RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;

interface Way {
  readonly send: HostSend;
  readonly close: () => void;
}

interface RoomState {
  readonly room: string;
  /** The host the way below goes to. */
  host: string | undefined;
  /** Open, and what sends on it. */
  way: Way | undefined;
  /** Made, not closed yet: a link connecting or open, or the in-process way. */
  pending: (() => void) | undefined;
  readonly feeds: Map<string, { readonly feed: HostFeed; chunks: unknown[] | undefined }>;
  retry: ReturnType<typeof setTimeout> | undefined;
  retryMs: number;
}

interface LinksState {
  readonly connection: QuickdrawConnection;
  readonly directory: HostDirectory;
  readonly rooms: Map<string, RoomState>;
  readonly locals: Map<string, LocalHost>;
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
    const chunks = [...(entry.chunks ?? []), ...message[4]];
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
  state.retryMs = RETRY_MS;
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

/** The in-process way to a host this connection serves. */
function connectLocal(links: LinksState, state: RoomState, local: LocalHost, self: string): void {
  const userId = links.connection.getState().hello?.userId ?? "";
  const attached = local({ socketId: self, userId }, (_label: PeerLabel, message: HostMessage) => {
    onMessage(state, message);
    return true;
  });
  state.pending = () => {
    attached.detach();
  };
  opened(state, {
    send: (_label, message) => {
      attached.receive(message);
      return true;
    },
    close: () => {
      attached.detach();
    },
  });
}

function connectLink(links: LinksState, state: RoomState, host: string): void {
  let link;
  try {
    link = createPeerLink(links.connection, { room: state.room, to: host, offerer: true });
  } catch {
    // A link the app opened itself to the host, in this room: host mode leaves it alone.
    return;
  }
  const control = controlOf(link);
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
  link.on("open", () => {
    if (state.pending === way.close) {
      opened(state, way);
    }
  });
  link.on("close", () => {
    if (state.pending === way.close) {
      disconnect(state);
      retryLater(links, state);
    }
  });
}

/** Opens a way to the room's host, unless one to it is open or being made. */
function connect(links: LinksState, state: RoomState): void {
  const host = links.directory.of(state.room);
  if (host === undefined || (state.host === host && state.pending !== undefined)) {
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

/** A closed link with feeds still to serve: tries again later, while the room has a host. */
function retryLater(links: LinksState, state: RoomState): void {
  if (state.feeds.size === 0 || links.directory.of(state.room) === undefined) {
    return;
  }
  clearTimeout(state.retry);
  state.retry = setTimeout(() => {
    state.retry = undefined;
    connect(links, state);
  }, state.retryMs);
  state.retryMs = Math.min(MAX_RETRY_MS, state.retryMs * 2);
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
      retryMs: RETRY_MS,
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
  links.directory.listen((room, host) => {
    const state = links.rooms.get(room);
    if (state === undefined) {
      return;
    }
    if (host === null) {
      disconnect(state);
    } else if (state.feeds.size > 0) {
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
      connect(links, state);
      if (state.way !== undefined) {
        subscribeOn(state.way, feed);
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
 * own channels and feeds of the room reach it in process; returns its
 * removal.
 */
export function registerLocalHost(
  connection: QuickdrawConnection,
  room: string,
  local: LocalHost,
): () => void {
  const links = linksStateOf(connection);
  links.locals.set(room, local);
  const state = links.rooms.get(room);
  if (state !== undefined && state.feeds.size > 0) {
    connect(links, state);
  }
  return () => {
    if (links.locals.get(room) === local) {
      links.locals.delete(room);
      const current = links.rooms.get(room);
      if (current !== undefined && current.host === connection.socket.id) {
        disconnect(current);
      }
    }
  };
}
