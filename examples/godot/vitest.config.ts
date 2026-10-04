import { defineConfig } from "vitest/config";

// The Node wire test: it speaks the GDScript client's frames to a real server
// over a raw WebSocket. The Godot check (`bun run check:godot`) is a script.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
