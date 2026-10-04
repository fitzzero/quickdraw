// `createTestApp` and the socket helpers of `./testing`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickdrawError, type CallReply, type HelloFrame } from "../index";
import {
  alice,
  captureLogger,
  db,
  granted,
  qd,
  task,
  taskDefaults,
  taskRow,
} from "../server/__tests__/fixtures";
import { createProbe } from "../server/transports/__tests__/probe";
import { createTestApp, emitWithAck, waitForEvent, type TestApp } from "./index";

const apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

async function start() {
  const probe = createProbe();
  const app = await createTestApp({
    services: [qd.defineService(task, { methods: taskDefaults }), probe.service],
    db,
  });
  apps.push(app as unknown as TestApp);
  return { app, probe };
}

describe("createTestApp", () => {
  it("listens on a free port and calls in process as any principal", async () => {
    const { app } = await start();
    expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await app.as(alice).taskService.get({ id: "t1" })).toEqual(taskRow());
    await expect(app.as(null).probeService.wait({ key: "anonymous" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("connects a real v5 socket as a principal, with a typed call", async () => {
    const { app } = await start();
    const moderator = await app.connect(granted(alice, { probeService: "Moderate" }));
    expect(moderator.hello).toMatchObject({ protocol: 5, limits: { maxInFlightQueries: 16 } });
    expect(await moderator.call.taskService.get({ id: "t1" })).toEqual(taskRow());
    expect(await moderator.call.probeService.moderate({ value: 4 })).toBe(8);
    expect(await moderator.call.probeService.echo({ text: "hi" })).toEqual({
      text: "hi",
      userId: "alice",
      transport: "socket",
      grants: { probeService: "Moderate" },
    });
    const error: unknown = await moderator.call.taskService
      .rename({ id: "t1", title: "" })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(QuickdrawError);
    expect(error).toMatchObject({ code: "VALIDATION", data: { issues: [{ path: ["title"] }] } });
    const anonymous = await app.connect(null);
    await expect(anonymous.call.probeService.wait({ key: "k" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("cancels a socket call when its signal aborts", async () => {
    const { app, probe } = await start();
    const { call } = await app.connect(alice);
    const controller = new AbortController();
    const pending = call.probeService.wait({ key: "cancel" }, { signal: controller.signal });
    await vi.waitFor(() => expect(probe.signals.has("cancel")).toBe(true));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(probe.signals.get("cancel")?.aborted).toBe(true);
    const aborted = AbortSignal.abort();
    await expect(
      call.probeService.wait({ key: "early" }, { signal: aborted }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("uses the app's own authenticate when given, and rejects a refused connection", async () => {
    const app = await createTestApp({
      services: [qd.defineService(task, { methods: taskDefaults })],
      db,
      auth: {
        authenticate: () => {
          throw new Error("no sessions in this test");
        },
      },
      logger: captureLogger(),
    });
    apps.push(app as unknown as TestApp);
    await expect(app.connect(alice)).rejects.toThrow("Authentication failed");
  });

  it("disconnects its sockets and closes the server on close()", async () => {
    const { app } = await start();
    const { socket } = await app.connect(alice);
    const disconnected = waitForEvent(socket, "disconnect");
    await app.close();
    apps.splice(0);
    expect(await disconnected).toBe("io client disconnect");
    expect(app.server.httpServer.listening).toBe(false);
  });
});

describe("app.frames", () => {
  it("records every frame the server sends each socket, with the socket, its user and the time", async () => {
    const { app } = await start();
    const before = Date.now();
    const signedIn = await app.connect(alice);
    const anonymous = await app.connect(null);
    expect(
      app.frames({ event: "qd:hello" }).map((frame) => [frame.socketId, frame.userId]),
    ).toEqual([
      [signedIn.socket.id, "alice"],
      [anonymous.socket.id, null],
    ]);
    expect(app.frames({ event: "qd:hello", userId: "alice" })[0]?.data).toEqual(signedIn.hello);
    app.server.rotate({ withinMs: 100 });
    await app.frames.waitFor({ event: "qd:rotate", userId: null });
    await app.frames.waitFor({ event: "qd:rotate", userId: "alice" });
    const rotations = app.frames({ event: "qd:rotate" });
    expect(rotations.map((frame) => frame.data.withinMs)).toEqual([100, 100]);
    expect(rotations.map((frame) => frame.args)).toEqual([
      [{ withinMs: 100 }],
      [{ withinMs: 100 }],
    ]);
    expect(app.frames({ socketId: anonymous.socket.id }).map((frame) => frame.event)).toEqual([
      "qd:hello",
      "qd:rotate",
    ]);
    expect(app.frames((frame) => frame.at < before)).toEqual([]);
    expect(app.frames().every((frame) => frame.at <= Date.now())).toBe(true);
  });

  it("forgets on clear(), and waits for a frame recorded already or still to come", async () => {
    const { app } = await start();
    const { socket } = await app.connect(alice);
    expect(await app.frames.waitFor({ event: "qd:hello" })).toMatchObject({ userId: "alice" });
    app.frames.clear();
    expect(app.frames()).toEqual([]);
    const rotated = app.frames.waitFor((frame) => frame.event === "qd:rotate", 1000);
    app.server.rotate({ withinMs: 5 });
    expect(await rotated).toMatchObject({ socketId: socket.id, data: { withinMs: 5 } });
    expect(app.frames()).toHaveLength(1);
  });

  it("rejects a wait that nothing matches in time", async () => {
    const { app } = await start();
    await app.connect(alice);
    await expect(app.frames.waitFor({ event: "qd:revoked" }, 50)).rejects.toThrow(
      'No frame matched {"event":"qd:revoked"} within 50 ms',
    );
    await expect(app.frames.waitFor(() => false, 50)).rejects.toThrow(
      "No frame matched the predicate within 50 ms",
    );
  });
});

describe("emitWithAck and waitForEvent", () => {
  it("send a raw frame and wait for its acknowledgement, or for an event", async () => {
    const { app } = await start();
    const { socket } = await app.connect(alice);
    const reply = await emitWithAck<CallReply>(socket, "qd:call", {
      id: 1,
      s: "taskService",
      m: "get",
      i: { id: "t1" },
    });
    expect(reply).toEqual({ ok: true, d: taskRow() });
    const rotate = waitForEvent<{ withinMs: number }>(socket, "qd:rotate");
    app.server.rotate({ withinMs: 100 });
    expect(await rotate).toEqual({ withinMs: 100 });
  });

  it("reject after their timeout", async () => {
    const { app } = await start();
    const { socket } = await app.connect(alice);
    await expect(emitWithAck(socket, "nobody:listens", { x: 1 }, 50)).rejects.toThrow(
      "Timeout waiting for nobody:listens",
    );
    await expect(waitForEvent<HelloFrame>(socket, "qd:hello", 50)).rejects.toThrow(
      "Timeout waiting for event qd:hello",
    );
  });
});
