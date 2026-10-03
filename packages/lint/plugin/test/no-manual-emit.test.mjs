import { JOB, ROUTE, SERVICE, run } from "./tester.mjs";

run("no-manual-emit", {
  valid: [
    {
      name: "the realtime API (the README's presence, streams and channels example)",
      filename: SERVICE,
      code: `
        export const taskService = qd.defineService(task, {
          model: "task",
          access: inherit({ from: project, via: "projectId" }),
          methods: {
            enterBoard: {
              access: { scope: "Read", of: project, id: "projectId" },
              handler: ({ input, ctx }) => ctx.rooms.join(\`board:\${input.projectId}\`),
            },
          },
          channels: {
            cursor: (payload, ctx) => {
              ctx.rooms.emit(\`board:\${payload.projectId}\`, task, "cursorMoved", payload);
            },
          },
        });
      `,
    },
    {
      name: "streams and user events from a job",
      filename: JOB,
      code: `
        qd.stream(task, "logs").push(taskId, { line: "build started" });
        export const notify = (ctx, userId, payload) => ctx.rooms.emitToUser(userId, task, "assigned", payload);
      `,
    },
    {
      name: "an Express response and an event emitter are not sockets",
      filename: ROUTE,
      code: `
        router.post("/hooks/paid", (req, res) => {
          events.emit("paid", req.body);
          res.send({ ok: true });
        });
      `,
    },
    {
      name: "names that only look like the prefix, and a type naming a frame",
      filename: SERVICE,
      code: `
        type Frame = "qd:e";
        const labels = ["qd", "qdrant:collection", "Q:"];
      `,
    },
    {
      name: "client code is not server code",
      filename: "apps/web/src/lib/socket.ts",
      code: `socket.emit("qd:call", frame);`,
    },
  ],
  invalid: [
    {
      name: "emitting to a room by hand",
      filename: SERVICE,
      code: `io.to(\`project:\${projectId}\`).emit("task:updated", row);`,
      errors: [
        {
          message:
            "`io.to(`project:${projectId}`).emit()` sends a socket frame by hand. Entity frames and collection deltas follow tracked writes (`db.<model>`, or `ctx.touch(model, ids)` for writes the client cannot see); custom events are declared in the contract's `events` and sent with `ctx.rooms.emit(room, contract, event, payload)`; feeds use `qd.stream(contract, name).push(...)`.",
        },
      ],
    },
    {
      name: "sockets and servers reached through members",
      filename: JOB,
      code: `
        socket.broadcast.emit("refresh", ids);
        this.io.emit("refresh");
        server.io.in(room).emit("tick", n);
      `,
      errors: [
        { messageId: "manualEmit", data: { callee: "socket.broadcast.emit" } },
        { messageId: "manualEmit", data: { callee: "this.io.emit" } },
        { messageId: "manualEmit", data: { callee: "server.io.in(room).emit" } },
      ],
    },
    {
      name: "a framework frame name, sent by hand",
      filename: SERVICE,
      code: `socket.emit("qd:e", { t: "u", s: "taskService", id, rev, d: row });`,
      errors: [{ messageId: "manualEmit" }, { messageId: "protocolName", data: { value: "qd:e" } }],
    },
    {
      name: "joining a framework room by hand",
      filename: SERVICE,
      code: `
        ctx.rooms.join("qd:e:taskService:t1@Read");
        const room = \`qd:c:\${service}:\${collection}:\${scope}\`;
      `,
      errors: [
        { messageId: "protocolName", data: { value: "qd:e:taskService:t1@Read" } },
        { messageId: "protocolName", data: { value: "qd:c:" } },
      ],
    },
  ],
});
