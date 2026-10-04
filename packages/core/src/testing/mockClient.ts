// `createMockClient(contracts)` (RFC 0003 section 13): a client of the same
// type as `createQuickdrawClient`'s whose members are stubs, for component
// tests and stories that do not care about the transport. Nothing connects:
// there is no socket and no server, and the members' hooks need no provider
// above them. 4.1's `createMockSocket` mocked the socket under the hooks instead
// (`legacy-src/client/testing.tsx:24-41`), which tested a fake transport.
//
// - A query member's `useQuery` is TanStack's own `useQuery`, on the mock's
//   `QueryClient` (retries off), fetching from the method's stub; `call`
//   and `prefetch` answer from the stub too. A mutation's `useMutation` is
//   TanStack's `useMutation` over the stub. Optimistic layers are not shown:
//   the test sets the rows a component reads.
// - Every method's member carries its stub (`mockResolvedValue`,
//   `mockRejectedValue`, `mockImplementation`, `mockReset`, `calls`). A
//   search kit method's `useSearch` asks its stub at once, with no debounce
//   and no collection cache (`mockSearch.ts`).
// - `useEntity`, `useEntities` and `useCollection` show what the test sets
//   with `mockRow`, `mockRemoved`, `mockError` and `mockScope`
//   (`mockLive.ts`).
// - `qd.<service>.admin` holds the same mocked members of the admin kit's
//   methods, and `useAdminServices` asks their `adminMeta` stubs
//   (`mockAdmin.ts`).
// - `qd.invalidate` invalidates the mock's cache through an invalidation
//   coordinator, as the real client does.
// - `$Provider` makes the mock the provider of what it renders: the real
//   `useQuickdraw()` and `usePresence(room)` read the mock's session
//   (`$session`) and rooms (`$presence`), with no server (`mockSession.tsx`).
// - Everything set is forgotten after each test, when the test runner has a
//   global `afterEach` (as Testing Library unmounts after each test), and by
//   `$reset()`.

import { QueryClient, useMutation, useQuery, type QueryKey } from "@tanstack/react-query";
import { createBinding, invalidateWith, registerQuery, type Binding } from "../client/binding";
import type { MethodMutationOptions, MethodQueryOptions } from "../client/hooks";
import { methodKey, methodKeyPrefix, type MethodQueryKey } from "../client/keys";
import { buildCaller, type MethodTarget } from "../client/members";
import type { ContractMap } from "../contract/infer";
import { createMockStore, mockLiveMembers } from "./mockLive";
import { mockSearchMember } from "./mockSearch";
import { mockSessionControls, startingSession } from "./mockSession";
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
  /** Forgets its answer and its calls without refetching anything: the test is over. */
  forget(): void;
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
    forget: () => {
      calls.length = 0;
      answer = PENDING;
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

function mockQueryMember(
  context: MockContext,
  target: MethodTarget,
  search: (invoke: Stub["invoke"]) => Readonly<Record<string, unknown>>,
): object {
  const stub = context.stub(target);
  const key = (input?: unknown): MethodQueryKey => methodKey(target.service, target.method, input);
  const member = withStub(
    {
      ...search(stub.invoke),
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
 * Forgets everything set on a mock: answers, calls, rows, scopes and cached
 * results. `quiet` tells no mounted hook, for the reset after a test, which
 * may run before Testing Library unmounts what the test rendered.
 */
function resetMock(
  queryClient: QueryClient,
  store: ReturnType<typeof createMockStore>,
  stubs: readonly Stub[],
  quiet: boolean,
): void {
  queryClient.clear();
  store.clear(quiet);
  for (const stub of stubs) {
    if (quiet) {
      stub.forget();
    } else {
      stub.mockReset();
    }
  }
}

/**
 * Runs `reset` after each test when the test runner has a global
 * `afterEach` (vitest with `globals: true`, jest), as Testing Library
 * registers its cleanup. A runner that takes no hook where the mock is made
 * (inside a test) leaves it to `$reset()`.
 */
function resetAfterEachTest(reset: () => void): void {
  const runnerAfterEach: unknown = (globalThis as { readonly afterEach?: unknown }).afterEach;
  if (typeof runnerAfterEach !== "function") {
    return;
  }
  try {
    (runnerAfterEach as (hook: () => void) => void)(reset);
  } catch {
    // No hook can be registered here; `$reset()` still forgets everything.
  }
}

/**
 * Creates a mock client of `contracts`: the type of
 * `createQuickdrawClient(contracts)`, with every member a stub and no
 * transport behind it, for component tests and stories. A call stays
 * pending until the test sets its answer; a row or a scope stays loading
 * until the test sets it. Its members need no provider; components that read
 * `useQuickdraw()` or `usePresence(room)` render inside `$Provider`, which
 * shows the mock's session (`$session`). Everything set is forgotten after
 * each test (see `resetAfterEach`).
 *
 * @example
 * const qd = createMockClient({ task }, { session: { userId: "ada" } });
 * vi.mock("../lib/qd", () => ({ qd }));
 * qd.task.get.mockResolvedValue({ id: "t1", title: "Write the spec" });
 * qd.task.useEntity.mockRow({ id: "t1", title: "Write the spec" });
 * qd.task.byProject.mockScope("p1", [{ id: "t1", title: "Write the spec" }]);
 * qd.$session({ serviceAccess: { taskService: "Admin" } });
 * render(<TaskCard id="t1" />, { wrapper: qd.$Provider });
 * expect(qd.task.get.calls).toEqual([{ id: "t1" }]);
 */
export function createMockClient<const Contracts extends ContractMap>(
  contracts: Contracts & { readonly invalidate?: never },
  options: MockClientOptions = {},
): MockClient<Contracts> {
  const queryClient = options.queryClient ?? createMockQueryClient();
  const base = startingSession(options);
  const store = createMockStore(base);
  const session = mockSessionControls(store, queryClient, base);
  const binding = createBinding();
  binding.coordinator = session.coordinator;
  const stubs: Stub[] = [];
  const context: MockContext = { queryClient, binding, stub: stubMaker(queryClient, stubs) };
  const client = buildCaller(
    "createMockClient",
    contracts,
    (target, definition, contract) =>
      target.kind === "query"
        ? mockQueryMember(context, target, (invoke) =>
            mockSearchMember(queryClient, invoke, target, definition, contract),
          )
        : mockMutationMember(context, target),
    ["invalidate"],
    mockLiveMembers(store, queryClient),
  );
  Object.defineProperties(client, {
    invalidate: { value: invalidateWith(binding) },
    $queryClient: { value: queryClient },
    $Provider: { value: session.Provider },
    $session: { value: session.setSession },
    $presence: { value: session.setPresence },
    $reset: {
      value: (): void => {
        resetMock(queryClient, store, stubs, false);
      },
    },
  });
  if (options.resetAfterEach !== false) {
    resetAfterEachTest(() => {
      resetMock(queryClient, store, stubs, true);
    });
  }
  return Object.freeze(client) as MockClient<Contracts>;
}
