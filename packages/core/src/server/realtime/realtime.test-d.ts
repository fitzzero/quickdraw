// Type tests for streams, channels, typed events and presence (RFC 0003
// section 12.5), on the server and the client: `push` takes `(scope, item)`
// for a scoped stream and `(item)` for a global one; a channel handler gets
// the parsed payload and an authenticated `ctx`; `defineService` needs one
// handler per channel; `ctx.rooms`, `qd.rooms`, `onRoomLeave` and `ctx.presence`
// are typed; the client's
// members follow the contract, and so do a mock client's. `bun run
// typecheck` checks this file, and each `@ts-expect-error` sits on the line
// the compiler reports.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  createQuickdrawClient,
  usePresence,
  type UseChannelResult,
  type UseStreamResult,
} from "../../client/index";
import { defineContract, mutation, type ChannelRequires, type QuickdrawError } from "../../index";
import { createMockClient } from "../../testing/client";
import {
  createDispatcher,
  initQuickdraw,
  type ChannelContext,
  type ContextRooms,
  type Presence,
  type Principal,
  type RoomLeave,
  type RoomLeft,
  type RunContext,
  type ServerRooms,
  type StreamHandle,
  type StreamSeedContext,
} from "../index";

interface AppPrincipal extends Principal {
  readonly team: string;
}

const qd = initQuickdraw<{ principal: AppPrincipal }>();

const cursor = z.object({ x: z.number(), y: z.number().default(0) });

const lobby = defineContract("lobbyService", {
  methods: { enter: mutation({ input: z.object({ room: z.string() }), output: z.boolean() }) },
  streams: {
    logs: {
      item: z.object({ line: z.string() }),
      scope: "room",
      seed: 10,
      access: "authenticated",
    },
    load: { item: z.number(), access: "public" },
  },
  channels: { cursor: { payload: cursor } },
  events: { moved: { payload: cursor } },
});

describe("the server", () => {
  test("a channel handler gets the parsed payload and an authenticated context", () => {
    qd.defineService(lobby, {
      methods: {
        enter: {
          access: "authenticated",
          handler: ({ ctx, input }) => {
            expectTypeOf(ctx.rooms).toEqualTypeOf<ContextRooms>();
            expectTypeOf(ctx.presence).toEqualTypeOf<Presence>();
            expectTypeOf(ctx.presence.isOnline).returns.resolves.toEqualTypeOf<boolean>();
            expectTypeOf(ctx.presence.lastSeen).returns.resolves.toEqualTypeOf<number | null>();
            ctx.rooms.emit(input.room, lobby, "moved", { x: 1, y: 2 });
            ctx.rooms.emitToUser(ctx.principal.userId, lobby, "moved", { x: 1, y: 2 });
            // @ts-expect-error -- moved's y is a number after its schema ran
            ctx.rooms.emit(input.room, lobby, "moved", { x: 1 });
            return ctx.rooms.join(input.room);
          },
        },
      },
      channels: {
        cursor: (payload, ctx) => {
          expectTypeOf(payload).toEqualTypeOf<{ x: number; y: number }>();
          // cursor requires no room: ctx.room is undefined
          expectTypeOf(ctx).toEqualTypeOf<ChannelContext<AppPrincipal, undefined>>();
          expectTypeOf(ctx.room).toEqualTypeOf<undefined>();
          expectTypeOf(ctx.principal.team).toBeString();
        },
      },
    });
  });

  test("a channel takes { access, handler }, with a service grant or any principal", () => {
    qd.defineService(lobby, {
      methods: { enter: { access: "authenticated", handler: () => true } },
      channels: { cursor: { access: { service: "Moderate" }, handler: () => undefined } },
    });
    qd.defineService(lobby, {
      methods: { enter: { access: "authenticated", handler: () => true } },
      // @ts-expect-error -- a channel's access is "authenticated" or { service }
      channels: { cursor: { access: { entry: "Read" }, handler: () => undefined } },
    });
  });

  test("a channel that requires an app room is handled like any other", () => {
    const world = defineContract("worldService", {
      methods: { enter: mutation({ input: z.object({}), output: z.boolean() }) },
      channels: {
        move: { payload: cursor, requires: { room: "world" } },
        wave: { payload: z.object({ lobby: z.string() }), requires: { room: (p) => p.lobby } },
        steer: { payload: cursor, requires: { room: { prefix: "world:" } } },
      },
    });
    expectTypeOf(world.channels.move.requires).toExtend<ChannelRequires>();
    const service = qd.defineService(world, {
      methods: {
        enter: { access: "authenticated", handler: ({ ctx }) => ctx.rooms.join("world") },
      },
      channels: {
        move: (payload, ctx) => {
          expectTypeOf(payload).toEqualTypeOf<{ x: number; y: number }>();
          expectTypeOf(ctx.principal.team).toBeString();
          // the room the requirement matched
          expectTypeOf(ctx.room).toEqualTypeOf<string>();
        },
        wave: {
          access: { service: "Read" },
          handler: (payload, ctx) => {
            expectTypeOf(payload).toEqualTypeOf<{ lobby: string }>();
            expectTypeOf(ctx.room).toEqualTypeOf<string>();
          },
        },
        steer: (_payload, ctx) => {
          expectTypeOf(ctx).toEqualTypeOf<ChannelContext<AppPrincipal, string>>();
        },
      },
    });
    expectTypeOf(service.contract).toEqualTypeOf<typeof world>();
    const useMove = () => createQuickdrawClient({ world }).world.move.useChannel();
    expectTypeOf<ReturnType<typeof useMove>>().toEqualTypeOf<
      UseChannelResult<{ x: number; y?: number | undefined }>
    >();
  });

  test("a contract with channels needs one handler per channel", () => {
    // @ts-expect-error -- channels is required: the contract declares cursor
    qd.defineService(lobby, {
      methods: { enter: { access: "authenticated", handler: () => true } },
    });
    qd.defineService(lobby, {
      methods: { enter: { access: "authenticated", handler: () => true } },
      // @ts-expect-error -- cursor has no handler
      channels: {},
    });
  });

  test("push takes (scope, item) for a scoped stream, (item) for a global one", () => {
    const service = qd.defineService(lobby, {
      methods: { enter: { access: "authenticated", handler: () => true } },
      channels: { cursor: () => undefined },
    });
    const dispatcher = createDispatcher({ services: [service] });
    const logs = dispatcher.stream(lobby, "logs");
    expectTypeOf(logs).toEqualTypeOf<StreamHandle<typeof lobby, "logs">>();
    logs.push("room1", { line: "hello" });
    // @ts-expect-error -- a scoped stream needs its scope
    logs.push({ line: "hello" });
    // @ts-expect-error -- the item is { line }
    logs.push("room1", "hello");
    qd.stream(lobby, "load").push(3);
    // @ts-expect-error -- a global stream takes no scope
    qd.stream(lobby, "load").push("room1", 3);
    logs.pushMany("room1", [{ line: "one" }, { line: "two" }]);
    // @ts-expect-error -- pushMany takes a list of items
    logs.pushMany("room1", { line: "one" });
    qd.stream(lobby, "load").pushMany([1, 2, 3]);
    // @ts-expect-error -- a global stream takes no scope
    qd.stream(lobby, "load").pushMany("room1", [1]);
    // @ts-expect-error -- lobbyService has no stream "nope"
    qd.stream(lobby, "nope");
    expectTypeOf(dispatcher.presence).toEqualTypeOf<Presence>();
  });

  test("a stream's seed function gets its scope and the subscriber, and returns its items", () => {
    const world = defineContract("worldService", {
      streams: {
        snaps: { item: cursor, scope: "worldId", access: "public" },
        news: { item: z.string(), access: "authenticated" },
      },
    });
    qd.defineService(world, {
      methods: {},
      streams: {
        snaps: {
          seed: (worldId, ctx) => {
            expectTypeOf(worldId).toEqualTypeOf<string>();
            expectTypeOf(ctx).toEqualTypeOf<StreamSeedContext<AppPrincipal>>();
            expectTypeOf(ctx.principal).toEqualTypeOf<AppPrincipal | null>();
            return [{ x: 1, y: 2 }];
          },
        },
        news: {
          seed: async (scope) => {
            expectTypeOf(scope).toEqualTypeOf<undefined>();
            return await Promise.resolve(["hello"]);
          },
        },
      },
    });
    qd.defineService(world, {
      methods: {},
      // @ts-expect-error -- a snapshot's y is a number
      streams: { snaps: { seed: () => [{ x: 1 }] } },
    });
    qd.defineService(world, {
      methods: {},
      // @ts-expect-error -- worldService has no stream "nope"
      streams: { nope: { seed: () => [] } },
    });
    qd.defineService(world, {
      methods: {},
      streams: { snaps: { validate: "development" } },
    });
    qd.defineService(world, {
      methods: {},
      // @ts-expect-error -- validate is "always" or "development"
      streams: { snaps: { validate: "never" } },
    });
  });

  test("a stream's access may be an app room: its name, a prefix, or computed from the scope", () => {
    defineContract("roomStreamService", {
      streams: {
        lobby: { item: z.number(), access: { room: "lobby" } },
        anyWorld: { item: z.number(), access: { room: { prefix: "world:" } } },
        world: { item: z.number(), scope: "worldId", access: { room: (id) => `world:${id}` } },
      },
    });
    defineContract("mixedRoomStreamService", {
      streams: {
        // @ts-expect-error -- a room form is { room } and nothing else
        lobby: { item: z.number(), access: { room: "lobby", service: "Read" } },
      },
    });
  });

  test("rooms outside a handler: typed events, and a user taken out of a room", () => {
    expectTypeOf(qd.rooms).toEqualTypeOf<ServerRooms>();
    qd.rooms.emit("world", lobby, "moved", { x: 1, y: 2 });
    qd.rooms.emitToUser("user-1", lobby, "moved", { x: 1, y: 2 });
    // @ts-expect-error -- lobbyService declares no event "jumped"
    qd.rooms.emit("world", lobby, "jumped", { x: 1, y: 2 });
    // @ts-expect-error -- moved's y is a number after its schema ran
    qd.rooms.emit("world", lobby, "moved", { x: 1 });
    expectTypeOf(qd.rooms.leave("world", { userId: "user-1" })).toEqualTypeOf<Promise<void>>();
    // @ts-expect-error -- outside a handler there is no calling socket to take out
    void qd.rooms.leave("world");
    qd.defineService(lobby, {
      methods: {
        enter: {
          access: "authenticated",
          handler: async ({ ctx, input }) => {
            expectTypeOf(ctx.rooms.leave(input.room)).toEqualTypeOf<boolean>();
            expectTypeOf(ctx.rooms.leave(input.room, { userId: "user-1" })).toEqualTypeOf<
              Promise<void>
            >();
            await ctx.rooms.leave(input.room, { userId: ctx.principal.userId });
            return true;
          },
        },
      },
      channels: { cursor: () => undefined },
    });
  });

  test("onRoomLeave hears the app's principal, the rooms left and a run context", () => {
    const service = qd.defineService(lobby, {
      methods: { enter: { access: "authenticated", handler: () => true } },
      channels: { cursor: () => undefined },
    });
    qd.createServer({
      services: [service],
      http: false,
      onRoomLeave: (leave, ctx) => {
        expectTypeOf(leave).toEqualTypeOf<RoomLeave<AppPrincipal>>();
        expectTypeOf(leave.principal).toEqualTypeOf<AppPrincipal | null>();
        expectTypeOf(leave.reason).toEqualTypeOf<"leave" | "removed" | "disconnect">();
        expectTypeOf(leave.rooms).toEqualTypeOf<readonly RoomLeft[]>();
        expectTypeOf(ctx).toEqualTypeOf<RunContext>();
      },
    });
  });

  test("a service declares its own onRoomLeave, typed alike", () => {
    qd.defineService(lobby, {
      methods: { enter: { access: "authenticated", handler: () => true } },
      channels: { cursor: () => undefined },
      onRoomLeave: async (leave, ctx) => {
        expectTypeOf(leave).toEqualTypeOf<RoomLeave<AppPrincipal>>();
        expectTypeOf(leave.principal?.team).toEqualTypeOf<string | undefined>();
        expectTypeOf(ctx).toEqualTypeOf<RunContext>();
        await Promise.resolve();
      },
    });
    qd.defineService(lobby, {
      methods: { enter: { access: "authenticated", handler: () => true } },
      channels: { cursor: () => undefined },
      // @ts-expect-error -- a hook is a function of the leave and a run context
      onRoomLeave: { onLeave: () => undefined },
    });
  });
});

describe("the client", () => {
  const client = createQuickdrawClient({ lobby });

  test("a stream's member takes a scope when the stream is scoped", () => {
    const useLogs = () => client.lobby.logs.useStream("room1", { max: 10 });
    expectTypeOf<ReturnType<typeof useLogs>>().toEqualTypeOf<UseStreamResult<{ line: string }>>();
    const useLoad = () => client.lobby.load.useStream({ max: 5 });
    expectTypeOf<ReturnType<typeof useLoad>>().toEqualTypeOf<UseStreamResult<number>>();
    expectTypeOf<UseStreamResult<number>["error"]>().toEqualTypeOf<QuickdrawError | null>();
    // @ts-expect-error -- a global stream takes no scope
    client.lobby.load.useStream("room1");
  });

  test("a channel sends its payload's input type; an event hands its handler the payload", () => {
    const useCursor = () => client.lobby.cursor.useChannel();
    expectTypeOf<ReturnType<typeof useCursor>>().toEqualTypeOf<
      UseChannelResult<{ x: number; y?: number | undefined }>
    >();
    client.lobby.moved.useEvent((payload) => {
      expectTypeOf(payload).toEqualTypeOf<{ x: number; y: number }>();
    });
    expectTypeOf(usePresence).returns.toEqualTypeOf<readonly string[]>();
  });

  test("a mock client's members carry their controls", () => {
    const mock = createMockClient({ lobby });
    mock.lobby.logs.mockItems("room1", [{ line: "a" }]);
    mock.lobby.load.mockItems([1, 2]);
    // @ts-expect-error -- a global stream's items need no scope
    mock.lobby.load.mockItems("room1", [1]);
    mock.lobby.moved.mockEmit({ x: 1, y: 2 });
    expectTypeOf(mock.lobby.cursor.sent).toEqualTypeOf<
      readonly { x: number; y?: number | undefined }[]
    >();
  });
});
