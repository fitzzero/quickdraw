// The realtime tests' services, on the access tests' board
// (`../../access/__tests__/board.ts`): a task service with streams, channels
// and an event, inheriting its rows' access from the project service, and a
// service without a model for presence and rooms. Handlers record what they
// receive, so a test asserts on what reached the server.
//
//            owner   access list    members              level on T1
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   T1 in P1                                             ada Admin, bo Moderate, cy Read, di Read
//   T2 in P2 (owner ed)                                  ed Admin

import { expect } from "vitest";
import { z } from "zod";
import { settleCluster } from "../../../../test/cluster/mode";
import { QuickdrawError, defineContract, mutation, query } from "../../../index";
import { emitWithAck, type TestConnection } from "../../../testing/index";
import { projectContract, qd } from "../../access/__tests__/board";
import { inherit, type RoomLeaveHandler } from "../../index";

const taskRow = z.object({ id: z.string(), projectId: z.string(), title: z.string() });
const roomInput = z.object({ room: z.string() });

/** The app room the `shout` channel requires its sender to be in. */
export const LOBBY = "lobby:main";

export const inputSchema = z.object({
  taskId: z.string(),
  seq: z.number().int(),
  dx: z.number(),
  dy: z.number(),
});

export const liveContract = defineContract("taskService", {
  entity: taskRow,
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    enter: mutation({ input: roomInput, output: z.boolean() }),
    /** Joins a room with public access, so an anonymous socket can be in one. */
    enterAnyone: mutation({ input: roomInput, output: z.boolean() }),
    exit: mutation({ input: roomInput, output: z.boolean() }),
    /** Takes every socket of a user out of a room: `ctx.rooms.leave(room, { userId })`. */
    kick: mutation({
      input: z.object({ room: z.string(), userId: z.string() }),
      output: z.null(),
    }),
    celebrate: mutation({
      input: z.object({ room: z.string(), taskId: z.string() }),
      output: z.null(),
    }),
    celebrateUser: mutation({
      input: z.object({ userId: z.string(), taskId: z.string() }),
      output: z.null(),
    }),
    celebrateBadly: mutation({ input: roomInput, output: z.null() }),
    /** The calling socket's id (`ctx.socketId`), and how many sockets are in a room on this node. */
    whereAmI: query({
      input: roomInput,
      output: z.object({ socketId: z.string().nullable(), size: z.number() }),
    }),
  },
  collections: {
    byProject: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
  },
  streams: {
    logs: {
      item: z.object({ line: z.string() }),
      scope: "taskId",
      seed: 3,
      access: { entry: "Read" },
    },
    projectFeed: {
      item: z.object({ n: z.number() }),
      scope: "projectId",
      seed: 2,
      access: { scope: "Moderate", of: projectContract },
    },
    status: { item: z.string(), seed: 2, access: "authenticated" },
    ticks: { item: z.number(), volatile: true, access: "public" },
    adminFeed: { item: z.number(), access: { service: "Admin" } },
    rooms: { item: z.number(), scope: "room", access: "public" },
    closed: { item: z.number(), scope: "taskId", seed: 5 },
    /** Only for sockets in the app room `lobby:main`, signed in or not. */
    lobbyFeed: { item: z.number(), access: { room: LOBBY } },
    /** One feed per world, for the sockets in that world's room. */
    worldFeed: { item: z.number(), scope: "worldId", access: { room: (id) => `world:${id}` } },
    /** For sockets in any world's room. */
    anyWorld: { item: z.number(), access: { room: { prefix: "world:" } } },
  },
  channels: {
    input: { payload: inputSchema, ratePerSecond: 30, burst: 60, requires: { entity: "taskId" } },
    typing: {
      payload: z.object({ projectId: z.string(), on: z.boolean() }),
      requires: { collection: "byProject", scope: (payload) => payload.projectId },
    },
    adminPing: { payload: z.object({ note: z.string() }) },
    tight: { payload: z.object({ n: z.number() }), ratePerSecond: 1, burst: 1 },
    relay: { payload: z.object({ room: z.string(), taskId: z.string() }) },
    /** Only from a socket in the app room `lobby:main` (a game's one world). */
    shout: { payload: z.object({ n: z.number() }), requires: { room: LOBBY } },
    /** Only from a socket in the app room the payload names. */
    move: {
      payload: z.object({ room: z.string(), n: z.number() }),
      requires: { room: (payload) => payload.room },
    },
    /** Only from a socket in an app room whose name starts with `world:` (a game of many worlds). */
    steer: { payload: z.object({ n: z.number() }), requires: { room: { prefix: "world:" } } },
  },
  events: { celebrated: { payload: z.object({ taskId: z.string() }) } },
});

/** What the channel handlers received. */
export interface Received {
  readonly input: { readonly userId: string; readonly socketId: string; readonly seq: number }[];
  readonly typing: { readonly userId: string; readonly projectId: string }[];
  readonly adminPings: string[];
  readonly tight: number[];
  readonly shout: {
    readonly userId: string;
    readonly socketId: string;
    readonly room: string;
    readonly n: number;
  }[];
  readonly move: { readonly room: string; readonly matched: string; readonly n: number }[];
  /** `steer` messages, with the room the prefix matched (`ctx.room`). */
  readonly steer: { readonly room: string; readonly n: number }[];
  /** `ctx.room` of the channels that require no room (`input`, `typing`): always undefined. */
  readonly roomless: (string | undefined)[];
  handlerErrors: number;
}

export function received(): Received {
  return {
    input: [],
    typing: [],
    adminPings: [],
    tight: [],
    shout: [],
    move: [],
    steer: [],
    roomless: [],
    handlerErrors: 0,
  };
}

/** The live task service: channel handlers record into `into`; `onRoomLeave` is the service's own hook. */
export function defineLiveService(
  into: Received,
  options: { readonly onRoomLeave?: RoomLeaveHandler } = {},
) {
  return qd.defineService(liveContract, {
    ...(options.onRoomLeave === undefined ? {} : { onRoomLeave: options.onRoomLeave }),
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    collections: { byProject: { anchor: projectContract } },
    methods: {
      get: {
        access: { entry: "Read" },
        handler: ({ input, db }) => db.task.findUniqueOrThrow({ where: { id: input.id } }),
      },
      enter: { access: "authenticated", handler: ({ input, ctx }) => ctx.rooms.join(input.room) },
      enterAnyone: { access: "public", handler: ({ input, ctx }) => ctx.rooms.join(input.room) },
      exit: { access: "authenticated", handler: ({ input, ctx }) => ctx.rooms.leave(input.room) },
      kick: {
        access: "authenticated",
        handler: async ({ input, ctx }) => {
          await ctx.rooms.leave(input.room, { userId: input.userId });
          return null;
        },
      },
      celebrate: {
        access: "authenticated",
        handler: ({ input, ctx }) => {
          ctx.rooms.emit(input.room, liveContract, "celebrated", { taskId: input.taskId });
          return null;
        },
      },
      celebrateUser: {
        access: "authenticated",
        handler: ({ input, ctx }) => {
          ctx.rooms.emitToUser(input.userId, liveContract, "celebrated", { taskId: input.taskId });
          return null;
        },
      },
      celebrateBadly: {
        access: "authenticated",
        handler: ({ input, ctx }) => {
          const bad = { taskId: 42 } as unknown as { taskId: string };
          ctx.rooms.emit(input.room, liveContract, "celebrated", bad);
          return null;
        },
      },
      whereAmI: {
        access: "public",
        handler: ({ input, ctx }) => ({
          socketId: ctx.socketId ?? null,
          size: ctx.rooms.size(input.room),
        }),
      },
    },
    channels: {
      input: (payload, ctx) => {
        if (payload.seq === -999) {
          into.handlerErrors += 1;
          throw new Error("handler boom");
        }
        if (payload.seq === -998) {
          into.handlerErrors += 1;
          return Promise.reject(new QuickdrawError("CONFLICT", "async boom"));
        }
        if (payload.seq === -997) {
          into.handlerErrors += 1;
          throw new QuickdrawError("FORBIDDEN", "not yours");
        }
        into.input.push({ userId: ctx.principal.userId, socketId: ctx.socketId, seq: payload.seq });
        into.roomless.push(ctx.room);
        return undefined;
      },
      typing: (payload, ctx) => {
        into.typing.push({ userId: ctx.principal.userId, projectId: payload.projectId });
        into.roomless.push(ctx.room);
      },
      adminPing: {
        access: { service: "Admin" },
        handler: (payload) => {
          into.adminPings.push(payload.note);
        },
      },
      tight: (payload) => {
        into.tight.push(payload.n);
      },
      relay: (payload, ctx) => {
        ctx.rooms.emit(payload.room, liveContract, "celebrated", { taskId: payload.taskId });
      },
      shout: (payload, ctx) => {
        into.shout.push({
          userId: ctx.principal.userId,
          socketId: ctx.socketId,
          room: ctx.room,
          n: payload.n,
        });
      },
      move: (payload, ctx) => {
        into.move.push({ room: payload.room, matched: ctx.room, n: payload.n });
      },
      steer: (payload, ctx) => {
        into.steer.push({ room: ctx.room, n: payload.n });
      },
    },
  });
}

type Connected = Pick<TestConnection, "socket">;

/**
 * Sends a channel message, unacknowledged. The client sends volatile, which
 * Socket.IO may drop on the client while a write is pending; the tests send
 * plainly so every message they count reaches the server.
 */
export function send(connection: Connected, channel: string, payload: unknown, s = "taskService") {
  connection.socket.emit("qd:ch", [s, channel, payload]);
}

/**
 * Waits until the server has handled every event the socket sent before now:
 * Socket.IO handles one socket's packets in order, so the acknowledgement of
 * an event sent after them arrives once they ran. In the cluster projects it
 * first waits for what the writer node pushed to reach the socket's node.
 */
export async function settle(connection: Connected): Promise<void> {
  await settleCluster();
  await emitWithAck(connection.socket, "qd:unsub", { s: "noService", ids: [] });
}

/** Sends `qd:stream:sub` and resolves with the acknowledgement. */
export function streamSub(
  connection: Connected,
  stream: string,
  scope?: string,
  s = "taskService",
): Promise<Record<string, unknown>> {
  const frame = scope === undefined ? { s, stream } : { s, stream, scope };
  return emitWithAck(connection.socket, "qd:stream:sub", frame);
}

/** Sends `qd:stream:unsub` and resolves with the acknowledgement. */
export function streamUnsub(
  connection: Connected,
  stream: string,
  scope?: string,
  s = "taskService",
): Promise<unknown> {
  const frame = scope === undefined ? { s, stream } : { s, stream, scope };
  return emitWithAck(connection.socket, "qd:stream:unsub", frame);
}

/** The frames of one event a connection receives, in order. */
export function frames<T = unknown>(connection: Connected, event: string): T[] {
  const into: T[] = [];
  connection.socket.on(event, (frame: T) => into.push(frame));
  return into;
}

/** A refusal acknowledgement with `code`. */
export function refused(code: string): { ok: false; e: { code: string } } {
  return { ok: false, e: expect.objectContaining({ code }) as { code: string } };
}
