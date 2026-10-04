// The three files every migrated app needs and a 4.x app has none of, in the
// template's places (the README's quick start writes the same ones):
// `apps/api/src/db.ts` (the tracked Prisma client), `apps/api/src/quickdraw.ts`
// (`initQuickdraw` with the app's types) and `apps/web/src/lib/quickdraw.ts`
// (the typed client). A file that already exists is left alone.

import { join } from "node:path";
import type { RunContext } from "../context";
import { quote } from "../text";

/** Where the generated files live. */
export interface InfraPaths {
  readonly db: string;
  readonly quickdraw: string;
  readonly client: string | undefined;
}

export function infraPaths(ctx: RunContext): InfraPaths {
  return {
    db: join(ctx.layout.api.src, "db.ts"),
    quickdraw: join(ctx.layout.api.src, "quickdraw.ts"),
    client:
      ctx.layout.web === undefined ? undefined : join(ctx.layout.web.src, "lib", "quickdraw.ts"),
  };
}

function create(ctx: RunContext, path: string, lines: readonly string[]): void {
  if (ctx.project.getSourceFile(path) !== undefined) {
    return;
  }
  ctx.project.createSourceFile(path, `${lines.join("\n")}\n`);
  ctx.created.add(path);
}

/** Writes the api's `db.ts` and `quickdraw.ts`. */
export function writeServerInfra(ctx: RunContext): void {
  const paths = infraPaths(ctx);
  const local = (name: string): string => (ctx.js.api ? `./${name}.js` : `./${name}`);
  create(ctx, paths.db, [
    'import { trackPrisma } from "@fitzzero/quickdraw-core/prisma";',
    `import { prisma } from ${quote(ctx.layout.dbPackage)};`,
    "",
    "// Written by @fitzzero/quickdraw-codemod. Every write through `db` is tracked,",
    "// so subscribers see it. Apply trackPrisma last, after any other client extension.",
    "export const db = trackPrisma(prisma);",
  ]);
  create(ctx, paths.quickdraw, [
    'import type { AnyContract, MethodName } from "@fitzzero/quickdraw-core";',
    'import { initQuickdraw, type MethodAccess, type MethodImplementation } from "@fitzzero/quickdraw-core/server";',
    `import type { contracts } from ${quote(ctx.layout.shared.name)};`,
    `import type { db } from ${quote(local("db"))};`,
    "",
    "// Written by @fitzzero/quickdraw-codemod: the app's types, stated once. Every",
    "// service, handler and caller is typed from them.",
    "export type AppTypes = { readonly db: typeof db; readonly contracts: typeof contracts };",
    "",
    "export const qd = initQuickdraw<AppTypes>();",
    "",
    "/**",
    " * A method written in a module of its own, outside `qd.defineService`, which",
    " * lists it in `methods`: `export const rename = { access, handler } satisfies",
    ' * MethodOf<typeof taskContract, "rename">`.',
    " */",
    "export type MethodOf<C extends AnyContract, M extends MethodName<C>> = MethodImplementation<",
    "  AppTypes,",
    "  C,",
    "  M,",
    '  Exclude<MethodAccess<AppTypes, C, M>, "public">',
    ">;",
    "",
    '/** {@link MethodOf} for a method with `"public"` access, whose principal may be null. */',
    "export type PublicMethodOf<C extends AnyContract, M extends MethodName<C>> = MethodImplementation<",
    "  AppTypes,",
    "  C,",
    "  M,",
    '  "public"',
    ">;",
  ]);
}

/** Writes the web app's typed client, `lib/quickdraw.ts`. */
export function writeClientInfra(ctx: RunContext): void {
  const path = infraPaths(ctx).client;
  if (path === undefined) {
    return;
  }
  create(ctx, path, [
    'import { createQuickdrawClient } from "@fitzzero/quickdraw-core/client";',
    `import { contracts } from ${quote(ctx.layout.shared.name)};`,
    "",
    "// Written by @fitzzero/quickdraw-codemod: one typed client for the app, from the",
    "// contracts. Pass it to <QuickdrawProvider client={qd} url={...}>.",
    "export const qd = createQuickdrawClient(contracts);",
  ]);
}
