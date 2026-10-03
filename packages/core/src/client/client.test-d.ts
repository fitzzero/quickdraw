// Type tests for the typed client and the server caller (RFC 0003 section
// 11). `bun run typecheck` checks this file, and vitest's typecheck mode
// reports each block as a test; nothing here runs.

import type {
  QueryClient,
  QueryKey,
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  defineContract,
  mutation,
  type EntityOf,
  type ItemOf,
  type QuickdrawError,
} from "../index";
import { taskContract as indexedTasks } from "../server/collections/__tests__/fixture";
import { task, type TaskRow } from "../server/__tests__/fixtures";
import {
  createInvalidationCoordinator,
  createQuickdrawClient,
  createServerCaller,
  overlaysOf,
  useQuickdraw,
  type InvalidationCoordinator,
  type MethodQueryKey,
  type OverlayStore,
  type QuickdrawProviderProps,
  type UseEntityResult,
} from "./index";
import { counter } from "./__tests__/fixtures";
import { taskContract as board } from "./__tests__/live";

const misc = defineContract("miscService", {
  methods: { reset: mutation({ input: z.undefined(), output: z.null() }) },
});

const qd = createQuickdrawClient({ taskService: task, counter, misc, board });

type Card = { id: string; title: string };

describe("the typed client", () => {
  test("useMutation infers its input and output from the contract", () => {
    const useRename = () => qd.taskService.rename.useMutation();
    type Rename = ReturnType<typeof useRename>;
    expectTypeOf<Rename>().toEqualTypeOf<
      UseMutationResult<TaskRow, QuickdrawError, { id: string; title: string }, unknown>
    >();
    expectTypeOf<Rename["mutateAsync"]>()
      .parameter(0)
      .toEqualTypeOf<{ id: string; title: string }>();
    expectTypeOf<Rename["mutateAsync"]>().returns.resolves.toEqualTypeOf<TaskRow>();
    expectTypeOf<Rename["error"]>().toEqualTypeOf<QuickdrawError | null>();
  });

  test("a misspelled method is a compile error", () => {
    // @ts-expect-error renmae is not a method of the task contract
    void qd.taskService.renmae;
    // @ts-expect-error tasks is not a key of the contract map
    void qd.tasks;
  });

  test("a mutation has no useQuery, and a query has no useMutation", () => {
    // @ts-expect-error a mutation has no useQuery
    void qd.taskService.rename.useQuery;
    // @ts-expect-error a mutation has no key
    void qd.taskService.rename.key;
    // @ts-expect-error a query has no useMutation
    void qd.taskService.get.useMutation;
    expectTypeOf<keyof typeof qd.taskService.get>().toEqualTypeOf<
      "useQuery" | "call" | "key" | "prefetch"
    >();
    expectTypeOf<keyof typeof qd.taskService.rename>().toEqualTypeOf<"useMutation" | "call">();
  });

  test("useQuery's data and error come from the contract, and select picks the data", () => {
    const useGet = () => qd.taskService.get.useQuery({ id: "t1" });
    expectTypeOf<ReturnType<typeof useGet>>().toEqualTypeOf<
      UseQueryResult<TaskRow, QuickdrawError>
    >();
    const useTitle = () =>
      qd.taskService.get.useQuery({ id: "t1" }, { select: (row) => row.title, staleTime: 0 });
    expectTypeOf<ReturnType<typeof useTitle>>().toEqualTypeOf<
      UseQueryResult<string, QuickdrawError>
    >();
    const useFind = () => qd.taskService.find.useQuery({ id: "t1" });
    expectTypeOf<ReturnType<typeof useFind>["data"]>().toEqualTypeOf<TaskRow | null | undefined>();
    const useList = () => qd.taskService.list.useQuery({ projectId: "p1" });
    expectTypeOf<ReturnType<typeof useList>["data"]>().toEqualTypeOf<Card[] | undefined>();
  });

  test("the input is checked, and may be left out only where the method accepts undefined", () => {
    const useTotal = () => qd.counter.total.useQuery();
    expectTypeOf<ReturnType<typeof useTotal>["data"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf(qd.taskService.get.call).toBeCallableWith({ id: "t1" });
    expectTypeOf(qd.taskService.get.call).toBeCallableWith({ id: "t1" }, { timeoutMs: 5 });
    // @ts-expect-error get needs its input
    void qd.taskService.get.key();
    // @ts-expect-error the input is checked against the contract's schema
    void qd.taskService.get.key({ id: 1 });
    const useReset = () => qd.misc.reset.useMutation();
    type Reset = ReturnType<typeof useReset>;
    expectTypeOf<Reset["mutate"]>().toBeCallableWith();
    expectTypeOf<Reset["data"]>().toEqualTypeOf<null | undefined>();
  });

  test("call, key and prefetch are typed from the contract", () => {
    expectTypeOf(qd.taskService.get.call).returns.resolves.toEqualTypeOf<TaskRow>();
    expectTypeOf(qd.taskService.list.call).returns.resolves.toEqualTypeOf<Card[]>();
    expectTypeOf(qd.taskService.rename.call).returns.resolves.toEqualTypeOf<TaskRow>();
    expectTypeOf(qd.taskService.get.key({ id: "t1" })).toEqualTypeOf<
      MethodQueryKey<{ id: string }>
    >();
    expectTypeOf(qd.taskService.get.prefetch).parameter(0).toEqualTypeOf<QueryClient>();
    expectTypeOf(qd.taskService.get.prefetch).returns.toEqualTypeOf<Promise<void>>();
    // @ts-expect-error a mutation's call takes no signal: the server finishes it anyway
    void qd.taskService.rename.call({ id: "t1", title: "x" }, { signal: AbortSignal.abort() });
  });

  test("a service has its methods, useEntity and useEntities, and a member per collection", () => {
    expectTypeOf<keyof typeof qd.board>().toEqualTypeOf<
      | "get"
      | "countOnBoard"
      | "cards"
      | "rename"
      | "renameTenTimes"
      | "useEntity"
      | "useEntities"
      | "board"
      | "open"
    >();
    expectTypeOf<keyof typeof qd.taskService>().toEqualTypeOf<
      "get" | "find" | "list" | "count" | "rename" | "useEntity" | "useEntities"
    >();
    expectTypeOf<keyof typeof qd.board.board>().toEqualTypeOf<"useCollection">();
    // A contract without an entity has no live entity members.
    expectTypeOf<keyof typeof qd.counter>().toEqualTypeOf<"read" | "bump" | "total">();
  });

  test("the provider takes the client it serves", () => {
    type Props = QuickdrawProviderProps<{
      taskService: typeof task;
      counter: typeof counter;
      misc: typeof misc;
      board: typeof board;
    }>;
    expectTypeOf<Props["client"]>().toEqualTypeOf<typeof qd>();
  });

  test("useQuickdraw names the user the hello said", () => {
    expectTypeOf<ReturnType<typeof useQuickdraw>["userId"]>().toEqualTypeOf<string | null>();
  });
});

describe("qd.invalidate", () => {
  test("takes a query member with that query's input, or a key", () => {
    expectTypeOf(qd).toHaveProperty("invalidate");
    expectTypeOf<keyof typeof qd>().toEqualTypeOf<
      "taskService" | "counter" | "misc" | "board" | "invalidate"
    >();
    qd.invalidate(qd.taskService.get, { id: "t1" });
    qd.invalidate(qd.taskService.get);
    qd.invalidate(qd.counter.total);
    qd.invalidate(["qd", "taskService"]);
    qd.invalidate(qd.taskService.list.key({ projectId: "p1" }));
    expectTypeOf(qd.invalidate).returns.toBeVoid();
    // @ts-expect-error the input is the member's own
    qd.invalidate(qd.taskService.get, { projectId: "p1" });
    // @ts-expect-error a mutation caches nothing to invalidate
    qd.invalidate(qd.taskService.rename);
    // @ts-expect-error a key is an array
    qd.invalidate("taskService");
  });

  test("reserves the key invalidate in the contract map", () => {
    // @ts-expect-error invalidate is the client's own
    createQuickdrawClient({ invalidate: counter });
  });
});

describe("optimistic mutations", () => {
  test("take false or a function typed by the contract's entity and collections", () => {
    const useQuiet = () => qd.taskService.rename.useMutation({ optimistic: false });
    expectTypeOf<ReturnType<typeof useQuiet>["data"]>().toEqualTypeOf<TaskRow | undefined>();
    const useCustom = () =>
      qd.board.rename.useMutation({
        optimistic: (input, cache) => {
          expectTypeOf(input).toEqualTypeOf<{ id: string; title: string }>();
          cache.patchEntity(input.id, { title: input.title, ordinal: 2 });
          cache.patchItem("board", input.id, { title: input.title });
          cache.removeEntity(input.id);
          // @ts-expect-error not a field of the entity
          cache.patchEntity(input.id, { name: "x" });
          // @ts-expect-error a card has no status
          cache.patchItem("board", input.id, { status: "done" });
          // @ts-expect-error not a collection of the contract
          cache.patchItem("mine", input.id, {});
        },
      });
    void useCustom;
    // @ts-expect-error true is the default; only false or a function may be given
    void (() => qd.taskService.rename.useMutation({ optimistic: true }));
  });

  test("mutate returns nothing and mutateAsync the output's promise", () => {
    const useRename = () => qd.taskService.rename.useMutation();
    type Rename = ReturnType<typeof useRename>;
    expectTypeOf<Rename["mutate"]>().returns.toBeVoid();
    expectTypeOf<Rename["mutateAsync"]>().returns.toEqualTypeOf<Promise<TaskRow>>();
  });
});

describe("live members", () => {
  const live = createQuickdrawClient({ task: indexedTasks });
  type Entity = EntityOf<typeof indexedTasks>;
  type Tile = ItemOf<typeof indexedTasks, "board">;

  test("useEntity and useEntities are typed by the contract's entity", () => {
    const useOne = () => live.task.useEntity("t1");
    expectTypeOf<ReturnType<typeof useOne>>().toEqualTypeOf<UseEntityResult<Entity>>();
    expectTypeOf<ReturnType<typeof useOne>["data"]>().toEqualTypeOf<Entity | undefined>();
    const useMany = () => live.task.useEntities(["t1", "t2"], { enabled: false });
    expectTypeOf<ReturnType<typeof useMany>["data"]>().toEqualTypeOf<
      readonly (Entity | undefined)[]
    >();
    expectTypeOf(live.task.useEntity).toBeCallableWith(null);
    // @ts-expect-error an id is a string
    void (() => live.task.useEntity(1));
  });

  test("useCollection is typed by the scope, the item, the index fields and the views", () => {
    const useBoard = () => live.task.board.useCollection("p1", { view: "mine", load: "all" });
    type Board = ReturnType<typeof useBoard>;
    expectTypeOf<Board["items"]>().toEqualTypeOf<readonly Tile[]>();
    expectTypeOf<Board["index"]>().toEqualTypeOf<
      readonly Pick<Tile, "id" | "status" | "ordinal" | "assigneeId">[] | undefined
    >();
    expectTypeOf<Board["byId"]>().toEqualTypeOf<ReadonlyMap<string, Tile>>();
    expectTypeOf<Board["loadItems"]>().toEqualTypeOf<(ids: readonly string[]) => Promise<void>>();
    // @ts-expect-error not a view of the board
    void (() => live.task.board.useCollection("p1", { view: "theirs" }));
    // @ts-expect-error byProject declares no views
    void (() => live.task.byProject.useCollection("p1", { view: "mine" }));
    // @ts-expect-error only "all" may be asked for
    void (() => live.task.board.useCollection("p1", { load: "some" }));
    expectTypeOf(live.task.board.useCollection).toBeCallableWith(null);
  });

  test("a contract without an entity has no entity members", () => {
    // @ts-expect-error the counter has no entity
    void qd.counter.useEntity;
  });
});

describe("the React-free pieces", () => {
  test("a coordinator and an overlay store come from a QueryClient", () => {
    expectTypeOf(createInvalidationCoordinator).parameter(0).toEqualTypeOf<QueryClient>();
    expectTypeOf(createInvalidationCoordinator).returns.toEqualTypeOf<InvalidationCoordinator>();
    expectTypeOf<InvalidationCoordinator["invalidate"]>().parameter(0).toEqualTypeOf<QueryKey>();
    expectTypeOf(overlaysOf).returns.toEqualTypeOf<OverlayStore>();
    expectTypeOf<OverlayStore["applyOverlay"]>().toBeCallableWith("taskService", taskRowOf());
  });
});

function taskRowOf(): TaskRow {
  return { id: "t1", projectId: "p1", title: "T1", done: false };
}

describe("the server caller", () => {
  const server = createServerCaller({ taskService: task }, { url: "http://localhost:4000" });

  test("has call, key and prefetch on a query and call on a mutation, typed from the contract", () => {
    expectTypeOf(server.taskService.get.call).returns.resolves.toEqualTypeOf<TaskRow>();
    expectTypeOf(server.taskService.get.key).returns.toEqualTypeOf<
      MethodQueryKey<{ id: string }>
    >();
    expectTypeOf(server.taskService.rename.call).returns.resolves.toEqualTypeOf<TaskRow>();
    // @ts-expect-error the server caller has no hooks
    void server.taskService.get.useQuery;
    // @ts-expect-error a mutation has no key
    void server.taskService.rename.key;
  });
});
