// `createMockClient(contracts)` (RFC 0003 section 13): a client of the same
// type as `createQuickdrawClient`'s whose members are stubs, for component
// tests that do not care about the transport. Nothing connects: there is no
// provider, no socket and no server, and the hooks need no provider above
// them. 4.1's `createMockSocket` mocked the socket under the hooks instead
// (`legacy-src/client/testing.tsx:24-41`), which tested a fake transport.
//
// - A query member's `useQuery` is TanStack's own `useQuery`, on the mock's
//   `QueryClient` (retries off), fetching from the method's stub; `call`
//   and `prefetch` answer from the stub too. A mutation's `useMutation` is
//   TanStack's `useMutation` over the stub. Optimistic layers are not shown:
//   the test sets the rows a component reads.
// - Every method's member carries its stub (`mockResolvedValue`,
//   `mockRejectedValue`, `mockImplementation`, `mockReset`, `calls`).
// - `useEntity`, `useEntities` and `useCollection` show what the test sets
//   with `mockRow`, `mockRemoved`, `mockError` and `mockScope`
//   (`mockLive.ts`).
// - `qd.invalidate` invalidates the mock's cache through an invalidation
//   coordinator, as the real client does.

import { QueryClient, useMutation, useQuery, type QueryKey } from "@tanstack/react-query";
import { createBinding, invalidateWith, registerQuery, type Binding } from "../client/binding";
import { createInvalidationCoordinator } from "../client/coordinator";
import type { MethodMutationOptions, MethodQueryOptions } from "../client/hooks";
import { methodKey, methodKeyPrefix, type MethodQueryKey } from "../client/keys";
import { buildCaller, type MethodTarget } from "../client/members";
import type { ContractMap } from "../contract/infer";
import { createMockStore, mockLiveMembers } from "./mockLive";
import type { MethodStub, MockClient, MockClientOptions } from "./mockTypes";

/** How a stub answers its calls. */
type Answer =
  | { readonly kind: "pending" }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "implementation"; readonly run: (input: unknown) => unknown };

/** A method's stub: its controls, and the call that answers as they say. */
interface Stub extends MethodStub<unknown, unknown> {
  invoke(input: unknown): Promise<unknown>;
}

const PENDING: Answer = Object.freeze({ kind: "pending" });

/** The answer of a call no answer was set for: it never settles. */
const NEVER = new Promise<never>(() => {
  // Never settles, as a call the server never answers.
});

/** A stub that calls `changed` whenever its answer changes. */
function createStub(changed: () => void): Stub {
  let answer = PENDING;
  const calls: unknown[] = [];
  const answerWith = (next: Answer): void => {
    answer = next;
    changed();
  };
  return {
    invoke(input) {
      calls.push(input);
      const current = answer;
      switch (current.kind) {
        case "value":
          return Promise.resolve(current.value);
        case "error":
          return Promise.reject(current.error);
        case "implementation":
          return Promise.resolve().then(() => current.run(input));
        default:
          return NEVER;
      }
    },
    mockResolvedValue: (value) => {
      answerWith({ kind: "value", value });
    },
    mockRejectedValue: (error) => {
      answerWith({ kind: "error", error });
    },
    mockImplementation: (run) => {
      answerWith({ kind: "implementation", run });
    },
    mockReset: () => {
      calls.length = 0;
      answerWith(PENDING);
    },
    get calls() {
      return [...calls];
    },
  };
}

/** `member` with `stub`'s controls on it, frozen. */
function withStub<T extends object>(member: T, stub: Stub): T {
  return Object.freeze(
    Object.defineProperties(member, {
      mockResolvedValue: { value: stub.mockResolvedValue, enumerable: true },
      mockRejectedValue: { value: stub.mockRejectedValue, enumerable: true },
      mockImplementation: { value: stub.mockImplementation, enumerable: true },
      mockReset: { value: stub.mockReset, enumerable: true },
      calls: { get: () => stub.calls, enumerable: true },
    }),
  );
}

/** What the members of one mock client share. */
interface MockContext {
  readonly queryClient: QueryClient;
  readonly binding: Binding;
  /** A new stub for the method of `target`. */
  stub(target: MethodTarget): Stub;
}

function useMockQuery(
  queryClient: QueryClient,
  stub: Stub,
  queryKey: MethodQueryKey,
  input: unknown,
  options: MethodQueryOptions<unknown> = {},
) {
  return useQuery(
    { retry: false, ...options, queryKey, queryFn: () => stub.invoke(input) },
    queryClient,
  );
}

function mockQueryMember(context: MockContext, target: MethodTarget): object {
  const stub = context.stub(target);
  const key = (input?: unknown): MethodQueryKey => methodKey(target.service, target.method, input);
  const member = withStub(
    {
      useQuery: (input?: unknown, options?: MethodQueryOptions<unknown>) =>
        useMockQuery(context.queryClient, stub, key(input), input, options),
      call: (input?: unknown): Promise<unknown> => stub.invoke(input),
      key,
      prefetch: (queryClient: QueryClient, input?: unknown): Promise<void> =>
        queryClient.prefetchQuery({ queryKey: key(input), queryFn: () => stub.invoke(input) }),
    },
    stub,
  );
  registerQuery(context.binding, member, target);
  return member;
}

function useMockMutation(
  queryClient: QueryClient,
  target: MethodTarget,
  stub: Stub,
  options: MethodMutationOptions<unknown, unknown> = {},
) {
  return useMutation(
    {
      mutationKey: methodKeyPrefix(target.service, target.method),
      ...options,
      mutationFn: (input: unknown) => stub.invoke(input),
    },
    queryClient,
  );
}

function mockMutationMember(context: MockContext, target: MethodTarget): object {
  const stub = context.stub(target);
  return withStub(
    {
      useMutation: (options?: MethodMutationOptions<unknown, unknown>) =>
        useMockMutation(context.queryClient, target, stub, options),
      call: (input?: unknown): Promise<unknown> => stub.invoke(input),
    },
    stub,
  );
}

/** The cache of a mock client: retries off, results kept fresh. */
function createMockQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

/**
 * Fetches the cached results of a query again with its new answer. Reads
 * still waiting on the old one are cancelled first: TanStack keeps a read
 * in flight for a query that has no data yet, and an unanswered read never
 * ends.
 */
async function refetchWithNewAnswer(queryClient: QueryClient, queryKey: QueryKey): Promise<void> {
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}

/** A new stub per method, fetching a query's cached results again when its answer changes. */
function stubMaker(queryClient: QueryClient, stubs: Stub[]): (target: MethodTarget) => Stub {
  return (target) => {
    const queryKey: QueryKey = methodKeyPrefix(target.service, target.method);
    const stub = createStub(() => {
      if (target.kind === "query") {
        void refetchWithNewAnswer(queryClient, queryKey);
      }
    });
    stubs.push(stub);
    return stub;
  };
}

/**
 * Creates a mock client of `contracts`: the type of
 * `createQuickdrawClient(contracts)`, with every member a stub and no
 * transport behind it, for component tests. A call stays pending until the
 * test sets its answer; a row or a scope stays loading until the test sets
 * it. No provider is needed above the components.
 *
 * @example
 * const qd = createMockClient({ task });
 * vi.mock("../lib/qd", () => ({ qd }));
 * qd.task.get.mockResolvedValue({ id: "t1", title: "Write the spec" });
 * qd.task.useEntity.mockRow({ id: "t1", title: "Write the spec" });
 * qd.task.byProject.mockScope("p1", [{ id: "t1", title: "Write the spec" }]);
 * render(<TaskCard id="t1" />);
 * expect(qd.task.get.calls).toEqual([{ id: "t1" }]);
 */
export function createMockClient<const Contracts extends ContractMap>(
  contracts: Contracts & { readonly invalidate?: never },
  options: MockClientOptions = {},
): MockClient<Contracts> {
  const queryClient = options.queryClient ?? createMockQueryClient();
  const binding = createBinding();
  binding.coordinator = createInvalidationCoordinator(queryClient);
  const store = createMockStore();
  const stubs: Stub[] = [];
  const context: MockContext = { queryClient, binding, stub: stubMaker(queryClient, stubs) };
  const client = buildCaller(
    "createMockClient",
    contracts,
    (target) =>
      target.kind === "query"
        ? mockQueryMember(context, target)
        : mockMutationMember(context, target),
    ["invalidate"],
    mockLiveMembers(store, { userId: options.userId ?? "" }),
  );
  Object.defineProperties(client, {
    invalidate: { value: invalidateWith(binding) },
    $queryClient: { value: queryClient },
    $reset: {
      value: (): void => {
        queryClient.clear();
        store.clear();
        for (const stub of stubs) {
          stub.mockReset();
        }
      },
    },
  });
  return Object.freeze(client) as MockClient<Contracts>;
}
