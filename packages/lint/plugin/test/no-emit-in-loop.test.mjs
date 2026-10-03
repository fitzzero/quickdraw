import { JOB, SERVICE, run } from "./tester.mjs";

run("no-emit-in-loop", {
  valid: [
    {
      name: "fan-out: a different room or user per item",
      filename: SERVICE,
      code: `
        const handler = ({ input, ctx }) => {
          for (const projectId of input.projectIds) {
            ctx.rooms.emit(\`board:\${projectId}\`, task, "moved", input.payload);
          }
          input.userIds.forEach((userId) => ctx.rooms.emitToUser(userId, task, "assigned", input.payload));
          for (const item of input.items) {
            const room = roomOf(item);
            ctx.rooms.emit(room, task, "changed", item);
          }
        };
      `,
    },
    {
      name: "one emit with the batch (the README's channel relay), and a stream push outside a loop",
      filename: SERVICE,
      code: `
        const channels = {
          cursor: (payload, ctx) => {
            ctx.rooms.emit(\`board:\${payload.projectId}\`, task, "cursorMoved", payload);
          },
        };
        qd.stream(task, "logs").push(taskId, { line: "build started" });
      `,
    },
    {
      name: "the batch form: pushMany after the loop, or once per chunk",
      filename: JOB,
      code: `
        export function relay(taskId, lines) {
          qd.stream(task, "logs").pushMany(taskId, lines.map((line) => ({ line })));
          for (const chunk of chunks(lines, 100)) qd.stream(task, "logs").pushMany(taskId, chunk);
        }
      `,
    },
    {
      name: "arrays are not streams, and while loops are not per-item loops",
      filename: JOB,
      code: `
        const lines = [];
        for (const row of rows) lines.push(row.line);
        const logs = qd.stream(task, "logs");
        while (queue.length > 0) logs.push(taskId, queue.shift());
      `,
    },
  ],
  invalid: [
    {
      name: "the same stream scope once per line",
      filename: JOB,
      code: `
        export function relay(taskId, lines) {
          for (const line of lines) {
            qd.stream(task, "logs").push(taskId, { line });
          }
        }
      `,
      errors: [
        {
          message:
            '`qd.stream(task, "logs").push()` inside a for...of loop pushes one item at a time to the same stream scope. Collect the items and push them together after the loop with `pushMany` (`pushMany(scope, items)`, or `pushMany(items)` for a global stream).',
        },
      ],
    },
    {
      name: "a handle held in a const, and a global stream",
      filename: SERVICE,
      code: `
        const logs = qd.stream(task, "logs");
        const load = qd.stream(metrics, "load");
        export function flush(input) {
          for (const line of input.lines) logs.push(input.taskId, line);
          for (let index = 0; index < samples.length; index += 1) load.push(samples[index]);
        }
      `,
      errors: [
        {
          messageId: "pushInLoop",
          data: { emit: "logs.push", loop: "a for...of loop", what: "stream scope" },
        },
        {
          messageId: "pushInLoop",
          data: { emit: "load.push", loop: "a for loop", what: "stream" },
        },
      ],
    },
    {
      name: "the same room or user every iteration",
      filename: SERVICE,
      code: `
        const handler = ({ input, ctx }) => {
          input.rows.forEach((row) => {
            ctx.rooms.emit(\`board:\${input.projectId}\`, task, "moved", row);
          });
          for (const step of input.steps) ctx.rooms.emitToUser(ctx.principal.userId, task, "progress", step);
        };
      `,
      errors: [
        {
          messageId: "emitInLoop",
          data: { emit: "ctx.rooms.emit", loop: "a .forEach() callback", what: "room" },
        },
        {
          messageId: "emitInLoop",
          data: { emit: "ctx.rooms.emitToUser", loop: "a for...of loop", what: "user" },
        },
      ],
    },
  ],
});
