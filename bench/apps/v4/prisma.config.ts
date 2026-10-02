import { defineConfig } from "prisma/config";

// The runner passes DATABASE_URL; the fallback is the benchmark's own
// Postgres from bench/docker-compose.yml (host port 5544).
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://bench:bench@127.0.0.1:5544/quickdraw_bench",
  },
});
