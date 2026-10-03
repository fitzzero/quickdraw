// Calls over the HTTP transport (RFC 0003 section 10), for code that has no
// socket: React server components prefetching for hydration, route handlers,
// scripts. `POST {url}/qd/{service}/{method}` with the input as the JSON body,
// answered `{ ok: true, d }` or `{ ok: false, e }` (`server/transports/http.ts`).
// Every request says `Content-Type: application/json`, even without a body:
// the server refuses any other, so a cross-site page cannot call a method
// with a user's session cookie without a CORS preflight.
//
// `prefetch` fills a TanStack `QueryClient` under the key the hooks read
// (`keys.ts`), so `dehydrate` and `HydrationBoundary` hand the result to the
// browser's `useQuery`.
//
// React-free and dependency-free (it uses the global `fetch`), so the
// isomorphic `./utils` entry exports it: a module that begins with
// "use client", as `./client` does, cannot be called from a server component.

import type { QueryClient } from "@tanstack/react-query";
import type { AnyContract } from "../contract/defineContract";
import type { ContractMap, InputOf, KindOf, MethodName, OutputOf } from "../contract/infer";
import { QuickdrawError, fromWire } from "../protocol/errors";
import { isRecord } from "../protocol/guards";
import { methodKey, type MethodQueryKey } from "./keys";
import { buildCaller, type MethodTarget } from "./members";

/** Headers sent with every call, or a function that returns them for each call. */
export type ServerCallerHeaders = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

/** Options of {@link createServerCaller}. */
export interface ServerCallerOptions {
  /** The server's URL: `"http://api:4000"`. */
  readonly url: string;
  /** The path the server serves calls under, as its `http.path`. Default `"/qd"`. */
  readonly path?: string;
  /**
   * Sent with every call: the credentials the server's `authenticate` reads,
   * such as the incoming request's `cookie` or an `authorization` bearer
   * token. `Content-Type` is always `application/json`.
   */
  readonly headers?: ServerCallerHeaders;
  /** The `fetch` to call with. Default: the global one. */
  readonly fetch?: typeof fetch;
}

/** Options of one HTTP call. */
export interface ServerCallOptions {
  /** Aborting it cancels the request; the call rejects with `CANCELLED`. */
  readonly signal?: AbortSignal;
}

type InputArgs<C extends AnyContract, M extends MethodName<C>, Rest extends unknown[]> =
  undefined extends InputOf<C, M>
    ? [input?: InputOf<C, M>, ...rest: Rest]
    : [input: InputOf<C, M>, ...rest: Rest];

/** A query of the server caller. */
export interface ServerQuery<C extends AnyContract, M extends MethodName<C>> {
  /** Calls the query; resolves with its data or rejects with its `QuickdrawError`. */
  call(...args: InputArgs<C, M, [options?: ServerCallOptions]>): Promise<OutputOf<C, M>>;
  /** The key the query's result is cached under, the one the client's hooks read. */
  key(...args: InputArgs<C, M, []>): MethodQueryKey<InputOf<C, M>>;
  /** Calls the query into `queryClient`, as `queryClient.prefetchQuery` does: it never rejects. */
  prefetch(queryClient: QueryClient, ...args: InputArgs<C, M, []>): Promise<void>;
}

/** A mutation of the server caller. */
export interface ServerMutation<C extends AnyContract, M extends MethodName<C>> {
  /** Calls the mutation; resolves with its data or rejects with its `QuickdrawError`. */
  call(...args: InputArgs<C, M, [options?: ServerCallOptions]>): Promise<OutputOf<C, M>>;
}

/** One method of the server caller, by its kind. */
export type ServerMethod<C extends AnyContract, M extends MethodName<C>> =
  KindOf<C, M> extends "query" ? ServerQuery<C, M> : ServerMutation<C, M>;

/** The server caller of a map of contracts: `caller.task.get.call(input)`. */
export type ServerCaller<Contracts extends ContractMap> = {
  readonly [Key in keyof Contracts]: {
    readonly [M in MethodName<Contracts[Key]>]: ServerMethod<Contracts[Key], M>;
  };
};

interface Settings {
  readonly endpoint: string;
  readonly headers: ServerCallerHeaders | undefined;
  readonly fetch: typeof fetch;
}

function settingsOf(options: ServerCallerOptions): Settings {
  if (typeof options.url !== "string" || options.url === "") {
    throw new TypeError("createServerCaller: url must be the server's URL");
  }
  const path = (options.path ?? "/qd").replace(/^\/+|\/+$/g, "");
  const base = options.url.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createServerCaller: there is no global fetch; pass options.fetch");
  }
  return {
    endpoint: path === "" ? base : `${base}/${path}`,
    headers: options.headers,
    fetch: fetchImpl,
  };
}

async function headersOf(settings: Settings): Promise<Headers> {
  const given =
    typeof settings.headers === "function" ? await settings.headers() : settings.headers;
  const headers = new Headers(given);
  headers.set("content-type", "application/json");
  return headers;
}

function withCause(error: QuickdrawError, cause: unknown): QuickdrawError {
  error.cause = cause;
  return error;
}

async function readReply(response: Response, target: MethodTarget): Promise<unknown> {
  const name = `${target.service}.${target.method}`;
  let reply: unknown;
  try {
    reply = await response.json();
  } catch (error) {
    const message = `${name} answered HTTP ${response.status} without a JSON reply`;
    throw withCause(new QuickdrawError("INTERNAL", message), error);
  }
  if (isRecord(reply) && reply.ok === true) {
    return reply.d;
  }
  if (isRecord(reply) && reply.ok === false) {
    throw fromWire(reply.e);
  }
  throw new QuickdrawError(
    "INTERNAL",
    `${name} answered HTTP ${response.status} with no call reply`,
  );
}

async function post(
  settings: Settings,
  target: MethodTarget,
  input: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const url = `${settings.endpoint}/${encodeURIComponent(target.service)}/${encodeURIComponent(target.method)}`;
  let response: Response;
  try {
    response = await settings.fetch(url, {
      method: "POST",
      headers: await headersOf(settings),
      body: input === undefined ? undefined : JSON.stringify(input),
      signal,
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw withCause(new QuickdrawError("CANCELLED", "The call was cancelled"), error);
    }
    const message = `${target.service}.${target.method}: the HTTP request failed`;
    throw withCause(new QuickdrawError("INTERNAL", message), error);
  }
  return readReply(response, target);
}

function memberOf(settings: Settings, target: MethodTarget): object {
  const callMethod = (input?: unknown, options?: ServerCallOptions): Promise<unknown> =>
    post(settings, target, input, options?.signal);
  if (target.kind !== "query") {
    return Object.freeze({ call: callMethod });
  }
  const key = (input?: unknown): MethodQueryKey => methodKey(target.service, target.method, input);
  return Object.freeze({
    call: callMethod,
    key,
    prefetch: (queryClient: QueryClient, input?: unknown): Promise<void> =>
      queryClient.prefetchQuery({
        queryKey: key(input),
        queryFn: ({ signal }) => post(settings, target, input, signal),
      }),
  });
}

/**
 * Creates a caller that calls the server's methods over HTTP:
 * `caller.task.get.call(input)`, and for queries `key(input)` and
 * `prefetch(queryClient, input)`. Use it where there is no socket, such as a
 * React server component; import it from `@fitzzero/quickdraw-core/utils`
 * there, since `./client` is client code.
 *
 * @example
 * const server = createServerCaller({ task }, {
 *   url: process.env.API_URL,
 *   headers: { cookie: (await cookies()).toString() },
 * });
 * const queryClient = new QueryClient();
 * await server.task.get.prefetch(queryClient, { id });
 * return <HydrationBoundary state={dehydrate(queryClient)}><Task id={id} /></HydrationBoundary>;
 */
export function createServerCaller<const Contracts extends ContractMap>(
  contracts: Contracts,
  options: ServerCallerOptions,
): ServerCaller<Contracts> {
  const settings = settingsOf(options);
  return buildCaller("createServerCaller", contracts, (target) =>
    memberOf(settings, target),
  ) as ServerCaller<Contracts>;
}
