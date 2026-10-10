// The app scripts/scale.mjs runs the codemod on: a quickdraw 4.1 app in the
// template's layout, with services in the three shapes 4.x apps write (the
// methods in the class, in modules taking the class, and in modules taking a
// port type) and api and web filler files that use zod and react-query. It
// typechecks against 4.1's types, the zod 3 the template used, and core's
// test Prisma client, all linked from this package.

import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(PACKAGE, "test/fixtures/v4-app");
const CORE = join(PACKAGE, "../core");

/** The app being written: `{ app, services, methods, api, web }`. */
let config;
/** Its services' indexes. */
let services = [];

const MODELS = [
  { type: "Task", delegate: "task", text: "title" },
  { type: "Project", delegate: "project", text: "name" },
  { type: "Label", delegate: "label", text: "name" },
  { type: "User", delegate: "user", text: "email" },
];

function write(path, text) {
  const file = join(config.app, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function link(path, target) {
  const file = join(config.app, path);
  mkdirSync(dirname(file), { recursive: true });
  symlinkSync(target, file);
}

const name = (index) => `svc${String(index)}`;
const className = (index) => `Svc${String(index)}Service`;
const modelOf = (index) => MODELS[index % MODELS.length];
/** Every third service is a class, a class with method modules, or a class with port-typed modules. */
const shapeOf = (index) => ["class", "module", "port"][index % 3];
const methodName = (index, method) =>
  `${method % 2 === 0 ? "get" : "update"}S${String(index)}M${String(method)}`;

function sharedTypes(index) {
  const pascal = `Svc${String(index)}`;
  const entries = Array.from({ length: config.methods }, (_, method) =>
    [
      `  ${methodName(index, method)}: {`,
      `    payload: { id: string; name: string; page?: number };`,
      `    response: { id: string; ok: boolean; count: number } | null;`,
      `  };`,
    ].join("\n"),
  );
  return [
    `export interface ${pascal}DTO {`,
    `  id: string;`,
    `}`,
    ``,
    `export interface ${pascal}ServiceMethods {`,
    ...entries,
    `}`,
    ``,
  ].join("\n");
}

function handler(index, method, self) {
  const model = modelOf(index);
  const access = method % 4 === 3 ? "Moderate" : "Read";
  return [
    `  ${self}.defineMethod(`,
    `    "${methodName(index, method)}",`,
    `    "${access}",`,
    `    async (payload, ctx) => {`,
    `      if (!ctx.userId) throw new Error("Authentication required");`,
    `      const row = await ${self}.prisma.${model.delegate}.findUnique({ where: { id: payload.id } });`,
    `      const count = await ${self}.prisma.${model.delegate}.count({ where: { ${model.text}: { contains: payload.name } } });`,
    `      return row === null ? null : { id: row.id, ok: true, count: count + (payload.page ?? 0) };`,
    `    },`,
    `    { schema: z.object({ id: z.string().min(1), name: z.string().max(100), page: z.number().int().optional() }) },`,
    `  );`,
  ].join("\n");
}

function baseClass(index, extra) {
  const model = modelOf(index);
  const pascal = `Svc${String(index)}`;
  return [
    `export class ${className(index)} extends BaseService<`,
    `  ${model.type},`,
    `  Prisma.${model.type}UncheckedCreateInput,`,
    `  Prisma.${model.type}UpdateInput,`,
    `  ${pascal}ServiceMethods,`,
    `  Record<string, never>,`,
    `  ${pascal}DTO`,
    `> {`,
    `  constructor(public readonly prisma: PrismaClient) {`,
    `    super({ serviceName: "${name(index)}Service", hasEntryACL: true });`,
    `    this.setDelegate(prisma.${model.delegate});`,
    ...extra,
    `  }`,
    ``,
    `  protected override toDto(row: ${model.type}): ${pascal}DTO {`,
    `    return { id: row.id };`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}

function serviceImports(index) {
  const model = modelOf(index);
  const pascal = `Svc${String(index)}`;
  return [
    `import type { Prisma, PrismaClient, ${model.type} } from "@project/db";`,
    `import type { ${pascal}DTO, ${pascal}ServiceMethods } from "@project/shared";`,
    `import { BaseService } from "@fitzzero/quickdraw-core/server";`,
  ];
}

/** Writes service `index` in its shape; returns its module, relative to apps/api/src/services. */
function writeService(index) {
  const shape = shapeOf(index);
  const methods = Array.from({ length: config.methods }, (_, method) => method);
  if (shape === "class") {
    const body = methods.map((method) =>
      handler(index, method, "this").replaceAll(/^ {2}/gmu, "    "),
    );
    write(
      `apps/api/src/services/${name(index)}.ts`,
      [...serviceImports(index), `import { z } from "zod";`, ``, baseClass(index, body)].join("\n"),
    );
    return `./services/${name(index)}.js`;
  }
  const halves = [methods.slice(0, config.methods / 2), methods.slice(config.methods / 2)];
  const registers = halves.map((_, half) => `register${className(index)}${String(half)}`);
  halves.forEach((half, part) => {
    const model = modelOf(index);
    const pascal = `Svc${String(index)}`;
    const parameter =
      shape === "module"
        ? [`import type { ${className(index)} } from "../index.js";`]
        : [
            `import type { BaseService } from "@fitzzero/quickdraw-core/server";`,
            `import type { Prisma, PrismaClient, ${model.type} } from "@project/db";`,
            `import type { ${pascal}DTO, ${pascal}ServiceMethods } from "@project/shared";`,
            ``,
            `type Port = Pick<`,
            `  BaseService<${model.type}, Prisma.${model.type}UncheckedCreateInput, Prisma.${model.type}UpdateInput, ${pascal}ServiceMethods, Record<string, never>, ${pascal}DTO>,`,
            `  "defineMethod"`,
            `> & { readonly prisma: PrismaClient };`,
          ];
    write(
      `apps/api/src/services/${name(index)}/methods/part${String(part)}.ts`,
      [
        `import { z } from "zod";`,
        ...parameter,
        ``,
        `export function ${registers[part]}(service: ${shape === "module" ? className(index) : "Port"}): void {`,
        ...half.map((method) => handler(index, method, "service")),
        `}`,
        ``,
      ].join("\n"),
    );
  });
  write(
    `apps/api/src/services/${name(index)}/index.ts`,
    [
      ...serviceImports(index),
      ...registers.map(
        (register, part) => `import { ${register} } from "./methods/part${String(part)}.js";`,
      ),
      ``,
      baseClass(
        index,
        registers.map((register) => `    ${register}(this);`),
      ),
    ].join("\n"),
  );
  return `./services/${name(index)}/index.js`;
}

/** An api file of zod schemas and Prisma queries; every tenth uses a service instance. */
function apiFiller(index) {
  const model = modelOf(index);
  const service = index % config.services;
  const previous =
    index % 20 === 0
      ? []
      : [`import { f${String(index - 1)}Schema } from "./f${String(index - 1)}.js";`];
  const usesService = index % 10 === 5;
  const servicePath =
    shapeOf(service) === "class"
      ? `../services/${name(service)}.js`
      : `../services/${name(service)}/index.js`;
  return [
    `import { z } from "zod";`,
    `import type { Prisma, ${model.type} } from "@project/db";`,
    `import type { Svc${String(service)}DTO } from "@project/shared";`,
    ...previous,
    ...(usesService ? [`import type { ${className(service)} } from "${servicePath}";`] : []),
    ``,
    `export const f${String(index)}Schema = z.object({`,
    `  id: z.string().min(1),`,
    `  title: z.string().min(1).max(200),`,
    `  count: z.number().int().nonnegative(),`,
    `  tags: z.array(z.string()).max(10),`,
    `  status: z.enum(["open", "doing", "done", "archived"]),`,
    `  owner: z.object({ id: z.string(), name: z.string().nullable() }).optional(),`,
    `  createdAt: z.coerce.date(),`,
    `  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),`,
    ...(previous.length > 0 ? [`  parent: f${String(index - 1)}Schema.partial().optional(),`] : []),
    `});`,
    ``,
    `export type F${String(index)} = z.infer<typeof f${String(index)}Schema>;`,
    ``,
    `export function parseF${String(index)}(input: unknown): F${String(index)} {`,
    `  return f${String(index)}Schema.parse(input);`,
    `}`,
    ``,
    `export function whereF${String(index)}(input: F${String(index)}): Prisma.${model.type}WhereInput {`,
    `  return { id: input.id, ${model.text}: { contains: input.title, mode: "insensitive" } };`,
    `}`,
    ``,
    `export function summarizeF${String(index)}(row: ${model.type}, dto: Svc${String(service)}DTO, input: F${String(index)}): string {`,
    `  const tags = input.tags.filter((tag) => tag.length > 0).map((tag) => tag.toUpperCase());`,
    `  const meta = Object.entries(input.meta).map(([key, value]) => \`\${key}=\${String(value)}\`);`,
    `  return [row.id, dto.id, input.status, ...tags, ...meta].join(" ");`,
    `}`,
    ``,
    `export function groupF${String(index)}(rows: readonly F${String(index)}[]): Map<F${String(index)}["status"], F${String(index)}[]> {`,
    `  const groups = new Map<F${String(index)}["status"], F${String(index)}[]>();`,
    `  for (const row of rows) {`,
    `    groups.set(row.status, [...(groups.get(row.status) ?? []), row]);`,
    `  }`,
    `  return groups;`,
    `}`,
    ``,
    `export function totalF${String(index)}(rows: readonly F${String(index)}[]): number {`,
    `  return rows.reduce((sum, row) => sum + row.count, 0);`,
    `}`,
    ...(usesService
      ? [
          ``,
          `export async function countF${String(index)}(service: ${className(service)}): Promise<number> {`,
          `  return await service.prisma.${modelOf(service).delegate}.count();`,
          `}`,
        ]
      : []),
    ``,
  ].join("\n");
}

/** A web component over react-query and zod; every fifth also calls the app's 4.x hooks. */
function webFiller(index) {
  const service = index % config.services;
  const usesHooks = index % 5 === 0;
  const id = String(index);
  return [
    `"use client";`,
    ``,
    `import { useMemo, useState } from "react";`,
    `import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";`,
    `import { z } from "zod";`,
    `import type { Svc${String(service)}DTO } from "@project/shared";`,
    ...(usesHooks ? [`import { useService, useServiceQuery } from "../hooks";`] : []),
    ``,
    `const row${id}Schema = z.object({`,
    `  id: z.string(),`,
    `  title: z.string(),`,
    `  count: z.number(),`,
    `  status: z.enum(["open", "doing", "done"]),`,
    `  tags: z.array(z.string()),`,
    `});`,
    ``,
    `type Row${id} = z.infer<typeof row${id}Schema>;`,
    ``,
    `async function fetchRows${id}(page: number): Promise<Row${id}[]> {`,
    `  const response = await fetch(\`/api/c${id}?page=\${String(page)}\`);`,
    `  return z.array(row${id}Schema).parse(await response.json());`,
    `}`,
    ``,
    `async function saveRow${id}(row: Row${id}): Promise<Row${id}> {`,
    `  const response = await fetch(\`/api/c${id}/\${row.id}\`, { method: "PUT", body: JSON.stringify(row) });`,
    `  return row${id}Schema.parse(await response.json());`,
    `}`,
    ``,
    `export function C${id}({ dto }: { dto: Svc${String(service)}DTO }) {`,
    `  const [page, setPage] = useState(1);`,
    `  const client = useQueryClient();`,
    `  const { data, isLoading } = useQuery({ queryKey: ["c${id}", dto.id, page], queryFn: () => fetchRows${id}(page) });`,
    `  const save = useMutation({`,
    `    mutationFn: saveRow${id},`,
    `    onSuccess: async () => {`,
    `      await client.invalidateQueries({ queryKey: ["c${id}"] });`,
    `    },`,
    `  });`,
    `  const total = useMemo(() => (data ?? []).reduce((sum, row) => sum + row.count, 0), [data]);`,
    `  const done = useMemo(() => (data ?? []).filter((row) => row.status === "done"), [data]);`,
    ...(usesHooks
      ? [
          `  const { data: remote } = useServiceQuery("${name(service)}Service", "${methodName(service, 0)}", { id: dto.id, name: "" });`,
          `  const update = useService("${name(service)}Service", "${methodName(service, 1)}");`,
        ]
      : []),
    `  if (isLoading) return <p>Loading</p>;`,
    `  return (`,
    `    <section>`,
    `      <h2>{\`\${String(total)} in \${String(done.length)} done\`}</h2>`,
    ...(usesHooks
      ? [
          `      <p>{remote?.count ?? 0}</p>`,
          `      <button type="button" onClick={() => update.mutate({ id: dto.id, name: "x" })}>Update</button>`,
        ]
      : []),
    `      <ul>`,
    `        {(data ?? []).map((row) => (`,
    `          <li key={row.id}>`,
    `            <button type="button" onClick={() => save.mutate({ ...row, count: row.count + 1 })}>`,
    `              {row.title} {row.tags.join(", ")}`,
    `            </button>`,
    `          </li>`,
    `        ))}`,
    `      </ul>`,
    `      <button type="button" onClick={() => setPage((current) => current + 1)}>More</button>`,
    `    </section>`,
    `  );`,
    `}`,
    ``,
  ].join("\n");
}

/** Writes the app: `options` holds its directory and its numbers of services, methods and api and web files. */
export function generateApp(options) {
  config = options;
  services = Array.from({ length: options.services }, (_, index) => index);
  rmSync(config.app, { recursive: true, force: true });
  const manifest = (pkg, dependencies) =>
    `${JSON.stringify({ name: pkg, private: true, type: "module", main: "./src/index.ts", dependencies }, null, 2)}\n`;
  write(
    "package.json",
    `${JSON.stringify({ name: "scale-app", private: true, workspaces: ["apps/*", "packages/*"] }, null, 2)}\n`,
  );
  const core = { "@fitzzero/quickdraw-core": "^4.1.0" };
  write("packages/shared/package.json", manifest("@project/shared", core));
  write(
    "apps/api/package.json",
    manifest("@project/api", { ...core, "@project/db": "workspace:*" }),
  );
  write("apps/web/package.json", manifest("@project/web", core));
  // The database package has no quickdraw dependency, so it is not a source: it resolves through node_modules
  write("packages/db/package.json", manifest("@project/db", {}));
  write(
    "packages/db/src/index.ts",
    [
      `import type { PrismaClient } from "${join(CORE, "test/prisma/generated/client.ts")}";`,
      `export * from "${join(CORE, "test/prisma/generated/client.ts")}";`,
      `export declare const prisma: PrismaClient;`,
      ``,
    ].join("\n"),
  );
  // 4.1's types, the zod 3 the template used, and the app's own packages
  link("node_modules/@fitzzero/quickdraw-core", join(PACKAGE, "node_modules/quickdraw-core-v4"));
  link("node_modules/zod", join(PACKAGE, "node_modules/zod3"));
  link("node_modules/@project/db", join(config.app, "packages/db"));
  link("node_modules/@project/shared", join(config.app, "packages/shared"));
  generateShared();
  generateApi();
  generateWeb();
}

function generateShared() {
  for (const index of services) {
    write(`packages/shared/src/types/${name(index)}.ts`, sharedTypes(index));
  }
  write(
    "packages/shared/src/types/service-methods.ts",
    [
      ...services.map(
        (index) =>
          `import type { Svc${String(index)}DTO, Svc${String(index)}ServiceMethods } from "./${name(index)}.js";`,
      ),
      ``,
      `export interface ServiceMethodsMap {`,
      ...services.map((index) => `  ${name(index)}Service: Svc${String(index)}ServiceMethods;`),
      `}`,
      ``,
      `export interface SubscriptionDataMap {`,
      ...services.map((index) => `  ${name(index)}Service: Svc${String(index)}DTO;`),
      `}`,
      ``,
    ].join("\n"),
  );
  write(
    "packages/shared/src/types/index.ts",
    [
      ...services.map((index) => `export type * from "./${name(index)}.js";`),
      `export type * from "./service-methods.js";`,
      ``,
    ].join("\n"),
  );
  write("packages/shared/src/index.ts", `export type * from "./types/index.js";\n`);
}

function generateApi() {
  const modules = services.map((index) => writeService(index));
  write(
    "apps/api/src/index.ts",
    [
      `import { createServer } from "node:http";`,
      `import { Server as SocketIOServer } from "socket.io";`,
      `import { ServiceRegistry } from "@fitzzero/quickdraw-core/server";`,
      `import { prisma } from "@project/db";`,
      ...services.map((index) => `import { ${className(index)} } from "${modules[index]}";`),
      ``,
      `const httpServer = createServer();`,
      `const io = new SocketIOServer(httpServer);`,
      `const serviceRegistry = new ServiceRegistry(io);`,
      ...services.map(
        (index) =>
          `serviceRegistry.registerService("${name(index)}Service", new ${className(index)}(prisma));`,
      ),
      ``,
      `httpServer.listen(4000);`,
      ``,
    ].join("\n"),
  );
  for (let index = 0; index < config.api; index += 1) {
    write(`apps/api/src/lib/f${String(index)}.ts`, apiFiller(index));
  }
}

function generateWeb() {
  // The template's typed wrapper hooks, from the fixture app
  for (const file of [
    "useService.ts",
    "useServiceQuery.ts",
    "useSubscription.ts",
    "service-types.ts",
  ]) {
    write(
      `apps/web/src/hooks/${file}`,
      readFileSync(join(FIXTURE, "apps/web/src/hooks", file), "utf8"),
    );
  }
  write(
    "apps/web/src/hooks/index.ts",
    [
      `export { useService } from "./useService";`,
      `export { useServiceQuery } from "./useServiceQuery";`,
      `export { useSubscription } from "./useSubscription";`,
      ``,
    ].join("\n"),
  );
  write(
    "apps/web/src/providers.tsx",
    readFileSync(join(FIXTURE, "apps/web/src/providers.tsx"), "utf8"),
  );
  for (let index = 0; index < config.web; index += 1) {
    write(`apps/web/src/components/C${String(index)}.tsx`, webFiller(index));
  }
}
