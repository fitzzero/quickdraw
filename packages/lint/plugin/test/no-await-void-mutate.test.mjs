import { COMPONENT, run } from "./tester.mjs";

run("no-await-void-mutate", {
  valid: [
    {
      name: "awaiting mutateAsync (the typed client's useMutation)",
      filename: COMPONENT,
      code: `
        export function RenameButton({ id }) {
          const rename = qd.task.rename.useMutation();
          const onClick = async () => {
            await rename.mutateAsync({ id, title: "Renamed" });
            close();
          };
          return <button onClick={onClick}>Rename</button>;
        }
      `,
    },
    {
      name: "mutate with callbacks, not awaited",
      filename: COMPONENT,
      code: `
        export function Save({ id }) {
          const update = qd.task.admin.adminUpdate.useMutation();
          return <button onClick={() => update.mutate({ id, data: { status: "done" } }, { onSuccess: close })}>Save</button>;
        }
      `,
    },
    {
      name: "an imperative call, and server code",
      filename: COMPONENT,
      code: `export const rename = async (input) => await qd.task.rename.call(input);`,
    },
    {
      name: "outside client code",
      filename: "apps/api/src/jobs/sync.ts",
      code: `await graph.mutate({ query });`,
    },
  ],
  invalid: [
    {
      name: "awaiting mutate",
      filename: COMPONENT,
      code: `
        export function RenameButton({ id }) {
          const rename = qd.task.rename.useMutation();
          return <button onClick={async () => { await rename.mutate({ id, title: "x" }); refresh(); }}>Rename</button>;
        }
      `,
      errors: [
        {
          message:
            "`mutate()` returns nothing: awaiting it resolves before the server answers, so the code after it runs before the write happened and cannot catch its failure. Use `await mutation.mutateAsync(input)` and handle the rejection, or pass `onSuccess`/`onError` to `mutate`.",
        },
      ],
    },
    {
      name: "an optional call, and a hook result used inline",
      filename: COMPONENT,
      code: `
        const save = async (input) => {
          await update.mutate?.(input);
          await qd.task.rename.useMutation().mutate(input);
        };
      `,
      errors: [{ messageId: "awaitMutate" }, { messageId: "awaitMutate" }],
    },
    {
      name: "a hook file of the web app",
      filename: "apps/web/src/hooks/useSave.ts",
      code: `export const useSave = (mutation) => async (input) => { await mutation.mutate(input); };`,
      errors: [{ messageId: "awaitMutate" }],
    },
  ],
});
