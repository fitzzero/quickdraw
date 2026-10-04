// Loads the Redis helper's optional peers, `@socket.io/redis-adapter` and
// `redis`. A module of its own so a test can stand in for a missing peer: an
// import that fails inside `vi.mock`'s factory reaches the caller wrapped in
// vitest's own error, without the original's `code`.

/** The two functions the Redis helper takes from its optional peers, untyped. */
export interface RedisPeers {
  readonly createAdapter: unknown;
  readonly createClient: unknown;
}

/** Imports both optional peers; rejects with the import error when either is missing. */
export async function loadRedisPeers(): Promise<RedisPeers> {
  // The build keeps both external because package.json declares them as peers.
  const [adapterModule, redisModule] = await Promise.all([
    import("@socket.io/redis-adapter") as Promise<{ readonly createAdapter: unknown }>,
    import("redis") as Promise<{ readonly createClient: unknown }>,
  ]);
  return { createAdapter: adapterModule.createAdapter, createClient: redisModule.createClient };
}

/**
 * True when `error` says a module could not be found. Node 24 and Bun throw
 * `ERR_MODULE_NOT_FOUND` from `import()` with the message "Cannot find
 * package ...", which 4.1 matched by message only and so logged as a failure
 * instead of a missing peer. The code is checked first; the 4.1 message checks
 * stay as a fallback for loaders that set no code.
 */
export function isModuleNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { readonly code?: unknown; readonly message?: unknown };
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return true;
  }
  return (
    typeof message === "string" &&
    (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND"))
  );
}
