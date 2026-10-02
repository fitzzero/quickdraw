"use client";

// Client exports for @fitzzero/quickdraw-core/client
//
// The directive above must stay the first statement: esbuild keeps an entry
// point's directives, so it opens dist/client/index.js and marks the whole
// entry as client code for React Server Components
// (scripts/dist-smoke.mjs checks it). For now this entry carries only the 4.1
// client utilities 5.0 keeps unchanged.

export * from "./utils";
