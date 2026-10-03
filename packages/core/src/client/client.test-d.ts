// Type tests for the typed client and the server caller (RFC 0003 section
// 11). `bun run typecheck` checks this file, and vitest's typecheck mode
// reports each block as a test; nothing here runs.

import type { QueryClient, UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { defineContract, mutation, type QuickdrawError } from "../index";
import { task, type TaskRow } from "../server/__tests__/fixtures";
import {
  createQuickdrawClient,
  createServerCaller,
  type MethodQueryKey,
  type QuickdrawProviderProps,
} from "./index";
import { counter } from "./__tests__/fixtures";

const misc = defineContract("miscService", {
  methods: { reset: mutation({ input: z.undefined(), output: z.null() }) },
});

const qd = createQuickdrawClient({ taskService: task, counter, misc });

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

  test("a service has its methods and nothing else until the live members arrive", () => {
    expectTypeOf<keyof typeof qd.taskService>().toEqualTypeOf<
      "get" | "find" | "list" | "count" | "rename"
    >();
  });

  test("the provider takes the client it serves", () => {
    type Props = QuickdrawProviderProps<{
      taskService: typeof task;
      counter: typeof counter;
      misc: typeof misc;
    }>;
    expectTypeOf<Props["client"]>().toEqualTypeOf<typeof qd>();
  });
});

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
