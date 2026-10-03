// The types of `createMockClient` (`mockClient.ts`): the typed client of the
// same contracts (`QuickdrawClient`), with a stub's controls on every
// member. A mock client is assignable to the real client's type, so a test
// can put it where the app's client goes (a module mock, a prop, a context).
//
// The controls sit where they cannot collide with what a contract names: on
// a method's member (whose own keys are `useQuery`, `call`, `key`,
// `prefetch` or `useMutation`), on the `useEntity` and `useEntities` hooks
// (names a contract may not take), on a collection's member, and as `$`-named
// members of the client (a contract map may not use `$` names).

import type { QueryClient } from "@tanstack/react-query";
import type {
  CollectionMember,
  EntityMembers,
  MethodMember,
  QuickdrawInvalidate,
} from "../client/clientTypes";
import type { AnyContract } from "../contract/defineContract";
import type {
  CollectionName,
  ContractMap,
  EntityOf,
  InputOf,
  ItemOf,
  MethodName,
  OutputOf,
  ScopeOf,
} from "../contract/infer";
import type { QuickdrawError } from "../protocol/errors";

/**
 * How a mocked method answers. Until one of the `mock*` setters runs, every
 * call stays pending: a query shows its loading state, and a mutation stays
 * pending. Each setter applies to every call from then on, and the method's
 * cached query results are fetched again, so a mounted component shows the
 * new answer.
 */
export interface MethodStub<Input, Output> {
  /** Every call resolves with `output`. */
  mockResolvedValue(output: Output): void;
  /** Every call rejects with `error`. */
  mockRejectedValue(error: QuickdrawError): void;
  /** Every call runs `implementation` with its input; a throw rejects the call. */
  mockImplementation(implementation: (input: Input) => Output | PromiseLike<Output>): void;
  /** Back to the start: calls stay pending, and `calls` is empty. */
  mockReset(): void;
  /** The input of every call so far, oldest first. */
  readonly calls: readonly Input[];
}

/**
 * The rows a mocked service's `useEntity` and `useEntities` show. A row the
 * test has not set is loading, as it is until the server's first answer.
 */
export interface EntityMock<Row> {
  /** Shows `row` under its `id`. */
  mockRow(row: Row): void;
  /** Shows row `id` as removed (`isRemoved`). */
  mockRemoved(id: string): void;
  /** Shows row `id` as failed with `error` (`FORBIDDEN` for a row the user may not read). */
  mockError(id: string, error: QuickdrawError): void;
}

/** What one mocked scope holds besides its items. */
export interface MockScope {
  /** How many members the scope has. Default: the number of items. */
  readonly totalCount?: number;
  /** Whether a page follows the items. Default `false`. */
  readonly hasMore?: boolean;
}

/** `qd.<service>.<collection>` of a mock client: `useCollection`, and what it shows. */
export interface MockCollectionMember<
  C extends AnyContract,
  K extends CollectionName<C>,
> extends CollectionMember<C, K> {
  /**
   * Shows `items` as scope `scope`'s members, in the order given. For a
   * collection with an index, the index rows are made from the items, and a
   * view filters them for the mock client's `userId`. A scope the test has
   * not set is loading.
   */
  mockScope(scope: ScopeOf<C, K>, items: readonly ItemOf<C, K>[], options?: MockScope): void;
  /** Shows scope `scope` as failed with `error`. */
  mockError(scope: ScopeOf<C, K>, error: QuickdrawError): void;
}

/** One method's member of a mock client: the real member's type, and its stub. */
export type MockMethodMember<C extends AnyContract, M extends MethodName<C>> = MethodMember<C, M> &
  MethodStub<InputOf<C, M>, OutputOf<C, M>>;

/** The entity hooks of a mocked service, each carrying the controls of the rows they show. */
export interface MockEntityMembers<C extends AnyContract> {
  readonly useEntity: EntityMembers<C>["useEntity"] & EntityMock<EntityOf<C>>;
  readonly useEntities: EntityMembers<C>["useEntities"] & EntityMock<EntityOf<C>>;
}

/** `qd.<key>` of a mock client. */
export type MockServiceClient<C extends AnyContract> = {
  readonly [M in MethodName<C>]: MockMethodMember<C, M>;
} & ([EntityOf<C>] extends [never] ? unknown : MockEntityMembers<C>) & {
    readonly [K in CollectionName<C>]: MockCollectionMember<C, K>;
  };

/** What `createMockClient` returns: the typed client of `Contracts`, with stubs. */
export type MockClient<Contracts extends ContractMap> = {
  readonly [Key in keyof Contracts]: MockServiceClient<Contracts[Key]>;
} & {
  /** Invalidates the mock's cached query results, as `qd.invalidate` does the real ones. */
  readonly invalidate: QuickdrawInvalidate;
  /** The cache the mock's query and mutation hooks use. */
  readonly $queryClient: QueryClient;
  /**
   * Forgets every answer set, call recorded, row, scope and cached result;
   * for a `beforeEach`, while nothing is mounted.
   */
  $reset(): void;
};

/** Options of `createMockClient`. */
export interface MockClientOptions {
  /** The cache the mock's hooks use. Default: a fresh one with retries off. */
  readonly queryClient?: QueryClient;
  /** The user views select members for (`who.userId`), as a connection's hello names it. Default `""`. */
  readonly userId?: string;
}
