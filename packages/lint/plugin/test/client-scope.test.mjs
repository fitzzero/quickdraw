// Which files the client rules check (`inClientScope` in ../lib/files.mjs):
// a file importing TanStack Query, the Socket.IO client or quickdraw's client
// is client code wherever oxlint runs from; the path globs (`files`, default
// `**/*.tsx`, `**/*.jsx`, `**/apps/web/**`) add files on top. The review's
// case, a hook in `apps/web/src/hooks/useTask.ts` linted from the app root and
// from `apps/web`, runs under the oxlint CLI in oxlint.test.mjs.

import { fileURLToPath } from "node:url";
import { run } from "./tester.mjs";

/** Linting from `apps/web`, as a package's own lint script does: `**\/apps/web/**` matches nothing. */
const WEB = fileURLToPath(new URL("apps/web/", import.meta.url));
const HOOK = fileURLToPath(new URL("apps/web/src/hooks/useTask.ts", import.meta.url));
const UTIL = "packages/shared/src/refresh.ts";

// Each rule's example. `no-untyped-client` reports TanStack Query's own hooks,
// which a file must import from TanStack Query, so its files are client code by
// import already; the other three report calls a file makes without importing
// anything.
const rules = {
  "no-await-void-mutate": {
    code: `export const save = async (rename) => { await rename.mutate({ id }); };`,
    messageId: "awaitMutate",
  },
  "no-manual-refetch": {
    code: `export const reset = (queryClient) => queryClient.invalidateQueries({ queryKey: ["qd", "taskService"] });`,
    messageId: "invalidateKey",
  },
  "no-raw-socket": {
    code: `export const send = (socket) => socket.emit("taskService:get", { id });`,
    messageId: "rawSocket",
  },
};

const IMPORTS = [
  `import { useQueryClient } from "@tanstack/react-query";`,
  `import { io } from "socket.io-client";`,
  `import { useQuickdraw } from "@fitzzero/quickdraw-core/client";`,
  `import type { QueryClient } from "@tanstack/react-query/build/modern";`,
];

for (const [rule, { code, messageId }] of Object.entries(rules)) {
  run(rule, {
    valid: [
      {
        name: "a file outside the path globs that imports no client module",
        cwd: WEB,
        filename: HOOK,
        code: `import { qd } from "../lib/quickdraw";\n${code}`,
      },
      {
        name: "a client import in a file the ignore globs skip",
        filename: UTIL,
        options: [{ ignore: ["**/packages/shared/**"] }],
        code: `${IMPORTS[0]}\n${code}`,
      },
    ],
    invalid: [
      ...IMPORTS.map((line) => ({
        name: `a file importing a client module, linted from apps/web: ${line}`,
        cwd: WEB,
        filename: HOOK,
        code: `${line}\n${code}`,
        errors: [{ messageId }],
      })),
      {
        name: "a re-export from a client module makes a shared file client code",
        filename: UTIL,
        code: `export { useQueryClient } from "@tanstack/react-query";\n${code}`,
        errors: [{ messageId }],
      },
      {
        name: "the path globs add files that import no client module",
        cwd: WEB,
        filename: HOOK,
        options: [{ files: ["**/src/hooks/**"] }],
        code,
        errors: [{ messageId }],
      },
    ],
  });
}

run("no-untyped-client", {
  valid: [
    {
      name: "a client import in a file the ignore globs skip",
      filename: UTIL,
      options: [{ ignore: ["**/packages/shared/**"] }],
      code: `import { useQuery } from "@tanstack/react-query";\nuseQuery({ queryKey: ["t", id], queryFn: () => qd.task.get.call({ id }) });`,
    },
  ],
  invalid: [
    {
      name: "a hook in a .ts file, linted from apps/web",
      cwd: WEB,
      filename: HOOK,
      code: `import { useQuery } from "@tanstack/react-query";\nuseQuery({ queryKey: ["t", id], queryFn: () => qd.task.get.call({ id }) });`,
      errors: [{ messageId: "untypedClient" }],
    },
  ],
});
