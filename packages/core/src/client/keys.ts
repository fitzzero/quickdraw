// TanStack Query keys of method calls (RFC 0003 section 11.5):
// `["qd", service, "m", method, input]`, with the service's wire name (the
// contract's `name`) and the input as the caller passed it. TanStack hashes a
// key with sorted object keys, so two inputs with the same fields share one
// cache entry whatever their key order. 4.1 put `JSON.stringify(payload)` in
// the key (`legacy-src/client/useServiceQuery.ts:88-91`), which made the
// cache depend on key order and hid the input from `queryKey` filters.
//
// React-free: the hooks, the server-side caller and non-React code build the
// same keys from here, so a query prefetched on the server is the one the
// hook reads.

/** The first element of every key the client caches under. */
export const KEY_ROOT = "qd";

/** The key of one method call's result: `["qd", service, "m", method, input]`. */
export type MethodQueryKey<Input = unknown> = readonly [
  root: typeof KEY_ROOT,
  service: string,
  kind: "m",
  method: string,
  input: Input,
];

/** The prefix of every key of one method: matches all its inputs in a `queryKey` filter. */
export type MethodKeyPrefix = readonly [
  root: typeof KEY_ROOT,
  service: string,
  kind: "m",
  method: string,
];

/** The prefix of every key of one service: its method calls, and later its entities and collections. */
export type ServiceKeyPrefix = readonly [root: typeof KEY_ROOT, service: string];

/** The key a call of `service.method` with `input` is cached under. */
export function methodKey<Input>(
  service: string,
  method: string,
  input: Input,
): MethodQueryKey<Input> {
  return [KEY_ROOT, service, "m", method, input];
}

/** The prefix of the keys of every call of `service.method`, for `invalidateQueries` and the like. */
export function methodKeyPrefix(service: string, method: string): MethodKeyPrefix {
  return [KEY_ROOT, service, "m", method];
}

/** The prefix of every key of `service`. */
export function serviceKeyPrefix(service: string): ServiceKeyPrefix {
  return [KEY_ROOT, service];
}
