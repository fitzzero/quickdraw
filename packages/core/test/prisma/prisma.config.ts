import { defineConfig } from "prisma/config";

// The Prisma CLI's configuration for core's test schema, used by the
// `db:generate` and `db:migration` scripts. Paths are relative to this file.
// Neither script connects to a database: the tests run on in-memory PGlite
// (setup.ts). Prisma's schema engine still requires a datasource URL to
// render a migration, so this one is a placeholder.
export default defineConfig({
  schema: "schema.prisma",
  migrations: { path: "migrations" },
  datasource: {
    url:
      process.env.DATABASE_URL ?? "postgresql://quickdraw:quickdraw@localhost:5432/quickdraw_test",
  },
});
