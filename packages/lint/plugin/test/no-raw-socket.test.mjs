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
  ],
});
