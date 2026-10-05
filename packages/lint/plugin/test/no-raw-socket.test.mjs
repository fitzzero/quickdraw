import { COMPONENT, run } from "./tester.mjs";

run("no-raw-socket", {
  valid: [
    {
      name: "the typed client and its live hooks (README presence and streams example)",
      filename: COMPONENT,
      code: `
        export function Board({ taskId, projectId }) {
          const { items } = qd.task.logs.useStream(taskId, { max: 200 });
          const { send } = qd.task.cursor.useChannel();
          qd.task.cursorMoved.useEvent((cursor) => drawCursor(cursor));
          const here = usePresence(\`board:\${projectId}\`);
          const { status } = useQuickdraw();
          return <Canvas items={items} here={here} status={status} onMove={send} />;
        }
      `,
    },
    {
      name: "events an app allows, by name or prefix",
      filename: COMPONENT,
      options: [{ allowedEvents: ["presence:ping"], allowedPrefixes: ["agentRunner:"] }],
      code: `
        socket.emit("presence:ping");
        socket.on("agentRunner:output", onOutput);
      `,
    },
    {
      name: "emitters and listeners that are not a socket",
      filename: COMPONENT,
      code: `
        emitter.on("change", onChange);
        window.addEventListener("focus", onFocus);
      `,
    },
    {
      name: "a test drives the socket on purpose",
      filename: "apps/web/src/components/__tests__/Board.test.tsx",
      code: `socket.emit("qd:sub", { s: "taskService", ids: [id] });`,
    },
    {
      name: "an io() of another module, and values that only share a name with socket.io-client's",
      filename: "apps/web/src/lib/feed.ts",
      code: `
        import { io } from "./my-io";
        import { connect } from "./db";
        const feed = io("/feed");
        feed.on("tick", onTick);
        const pool = connect();
        pool.on("error", onError);
      `,
    },
  ],
  invalid: [
    {
      name: "a 4.x-style call",
      filename: COMPONENT,
      code: `socket.emit("taskService:get", { id }, (response) => setTask(response.data));`,
      errors: [
        {
          message:
            "Raw `socket.emit()` bypasses the typed client: no input or access checks on the way, no revisions, no reconnect handling. Call methods through `qd.<service>.<method>` (`useQuery`, `useMutation`, `call`), read live data with `useEntity`, `useCollection`, `useStream` or `useEvent`, send with `useChannel`, and read the connection's state with `useQuickdraw()`.",
        },
      ],
    },
    {
      name: "listeners, including through the provider's connection",
      filename: COMPONENT,
      code: `
        useEffect(() => {
          socket.on("task:updated", onUpdate);
          useQuickdraw().connection.socket.off("qd:e", onFrame);
          socket.onAny(log);
        }, []);
      `,
      errors: [
        { messageId: "rawSocket", data: { method: "on" } },
        { messageId: "rawSocket", data: { method: "off" } },
        { messageId: "rawSocket", data: { method: "onAny" } },
      ],
    },
    {
      name: "a dynamic event name in a web app hook",
      filename: "apps/web/src/hooks/useLegacy.ts",
      code: `export const call = (event, payload) => socket.timeout(5000).emitWithAck(event, payload);`,
      errors: [{ messageId: "rawSocket", data: { method: "emitWithAck" } }],
    },
    {
      name: "what socket.io-client's io() made, whatever its name (finding F7.7)",
      filename: "apps/web/src/lib/raw.ts",
      code: `
        import { io } from "socket.io-client";
        const raw = io("http://localhost:4000", { auth: { token } });
        raw.emit("qd:call", { id: 1, s: "noteService", m: "getNote", i: { id } });
        raw.on("connect", onConnect);
        raw.timeout(5000).emitWithAck("hello");
      `,
      errors: [
        { messageId: "rawSocket", data: { method: "emit" } },
        { messageId: "rawSocket", data: { method: "on" } },
        { messageId: "rawSocket", data: { method: "emitWithAck" } },
      ],
    },
    {
      name: "a default or namespace import, a Manager and its sockets, assigned later or kept in a field",
      filename: "apps/web/src/lib/client.ts",
      code: `
        import connectTo, { Manager } from "socket.io-client";
        import * as sio from "socket.io-client";
        let late;
        function send() { late.emit("ping"); }
        late = connectTo(url);
        const manager = new Manager(url);
        const admin = manager.socket("/admin");
        admin.on("stats", show);
        sio.io(url).emit("hello");
        class Feed {
          start() { this.link = new sio.Manager(url).socket("/"); }
          stop() { this.link.off("tick"); }
        }
      `,
      errors: [
        { messageId: "rawSocket", data: { method: "emit" } },
        { messageId: "rawSocket", data: { method: "on" } },
        { messageId: "rawSocket", data: { method: "emit" } },
        { messageId: "rawSocket", data: { method: "off" } },
      ],
    },
    {
      name: "the framework's own qd: events on any receiver",
      filename: COMPONENT,
      code: `
        transport.emit("qd:call", frame);
        bus.on(\`qd:\${kind}\`, onFrame);
      `,
      errors: [
        { messageId: "rawSocket", data: { method: "emit" } },
        { messageId: "rawSocket", data: { method: "on" } },
      ],
    },
  ],
});
