import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "shared/index": "src/shared/index.ts",
    "server/index": "src/server/index.ts",
    "server/testing": "src/server/testing.ts",
    "client/index": "src/client/index.ts",
    "client/testing": "src/client/testing.tsx",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "react",
    "react-dom",
    "@tanstack/react-query",
    "socket.io",
    "socket.io-client",
    "@prisma/client",
    "express",
    // Optional peer dependencies for horizontal scaling
    "redis",
    "@socket.io/redis-adapter",
  ],
  treeshake: true,
  splitting: false,
});
