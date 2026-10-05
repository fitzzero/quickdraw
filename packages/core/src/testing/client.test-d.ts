// Type tests for `./testing/client` (and `./testing/mock`, which it
// re-exports) and the test app's frame recorder.
// `bun run typecheck` checks this file, and vitest's typecheck mode reports
// each block as a test; nothing here runs.

import type { QueryClient } from "@tanstack/react-query";
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createQuickdrawClient, type QuickdrawClient } from "../client/index";
import {
  defineContract,
  mutation,
  query,
  type ChangedFrame,
  type EntityFrame,
  type EntityOf,
  type ItemOf,
  type QuickdrawError,
} from "../index";
import { counter, probe } from "../client/__tests__/fixtures";
import type { AppPrincipal } from "../server/__tests__/fixtures";
import type { createProbe } from "../server/transports/__tests__/probe";
import {
  createMockClient,
  renderWithQuickdraw,
  type QuickdrawRenderResult,
  type RenderWithQuickdrawOptions,
} from "./client";
import type { RecordedFrame, TestApp } from "./index";
import { createMockClient as createMockFromMockEntry, type MockSession } from "./mock";
import type { AccessLevel } from "../index";
import type { ReactElement, ReactNode } from "react";

const card = z.object({ id: z.string(), projectId: z.string(), title: z.string() });

const task = defineContract("taskService", {
  entity: card,
  projections: { card },
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: "entity" }),
  },
  collections: { byProject: { scope: "projectId", item: "card", order: [["id", "asc"]] } },
});

const mock = createMockClient({ task, counter });

describe("createMockClient", () => {
  test("is a client of the same contracts", () => {
    expectTypeOf(mock).toMatchTypeOf<
      QuickdrawClient<{ task: typeof task; counter: typeof counter }>
    >();
    expectTypeOf(mock.$queryClient).toEqualTypeOf<QueryClient>();
  });

  test("its stubs take the method's input and output", () => {
    expectTypeOf(mock.task.get.mockResolvedValue)
      .parameter(0)
      .toEqualTypeOf<EntityOf<typeof task>>();
    expectTypeOf(mock.task.rename.mockRejectedValue).parameter(0).toEqualTypeOf<QuickdrawError>();
    expectTypeOf(mock.task.get.calls).toEqualTypeOf<readonly { id: string }[]>();
    expectTypeOf(mock.counter.bump.mockImplementation)
      .parameter(0)
      .parameter(0)
      .toEqualTypeOf<{ name: string }>();
    // @ts-expect-error a title is not a task
    mock.task.get.mockResolvedValue({ title: "no id" });
  });

  test("its session takes who it acts for, and its provider is a wrapper component", () => {
    expectTypeOf(mock.$session).parameter(0).toEqualTypeOf<MockSession>();
    expectTypeOf<MockSession["userId"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<NonNullable<MockSession["serviceAccess"]>>().toEqualTypeOf<
      Readonly<Record<string, AccessLevel>>
    >();
    expectTypeOf(mock.$presence).parameters.toEqualTypeOf<[string, readonly string[]]>();
    expectTypeOf(mock.$Provider).parameter(0).toEqualTypeOf<{
      readonly children?: ReactNode;
      readonly session?: MockSession;
    }>();
    expectTypeOf(mock.$Provider).returns.toEqualTypeOf<ReactElement>();
    // @ts-expect-error a grant is an access level
    mock.$session({ serviceAccess: { taskService: "Owner" } });
    // The mock entry gives the same function, without Testing Library.
    expectTypeOf(createMockFromMockEntry).toEqualTypeOf(createMockClient);
  });

  test("the live controls take the contract's rows and items", () => {
    expectTypeOf(mock.task.useEntity.mockRow).parameter(0).toEqualTypeOf<EntityOf<typeof task>>();
    expectTypeOf(mock.task.useEntities.mockRemoved).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(mock.task.byProject.mockScope)
      .parameter(1)
      .toEqualTypeOf<readonly ItemOf<typeof task, "byProject">[]>();
    // @ts-expect-error the counter has no entity, so no useEntity
    void mock.counter.useEntity;
  });
});

describe("renderWithQuickdraw", () => {
  /** An app whose services take the fixtures' principal: a user or an agent, by `kind`. */
  type Services = readonly [ReturnType<typeof createProbe>["service"]];
  type Contracts = { probe: typeof probe };

  test("acts as the app's principal type, for the client given", () => {
    const qd = createQuickdrawClient({ probe });
    // `as` is the principal type of the app's services, or null for an anonymous socket.
    expectTypeOf<
      RenderWithQuickdrawOptions<Services, Contracts>["as"]
    >().toEqualTypeOf<AppPrincipal | null>();
    expectTypeOf(renderWithQuickdraw<Services, Contracts>)
      .parameter(1)
      .toHaveProperty("as")
      .toEqualTypeOf<AppPrincipal | null>();
    const render = (app: TestApp<Services>) =>
      renderWithQuickdraw(null as unknown as React.ReactElement, {
        app,
        as: { userId: "ada", kind: "agent" },
        client: qd,
      });
    expectTypeOf(render).parameter(0).toEqualTypeOf<TestApp<Services>>();
    expectTypeOf(render).returns.toEqualTypeOf<Promise<QuickdrawRenderResult>>();
    const anonymous = (app: TestApp<Services>) =>
      renderWithQuickdraw(null as unknown as React.ReactElement, { app, as: null, client: qd });
    expectTypeOf(anonymous).returns.toEqualTypeOf<Promise<QuickdrawRenderResult>>();
    const untyped = (app: TestApp<Services>) =>
      renderWithQuickdraw(null as unknown as React.ReactElement, {
        app,
        // @ts-expect-error the app's principals carry a `kind`
        as: { userId: "ada" },
        client: qd,
      });
    void untyped;
  });
});

describe("app.frames", () => {
  test("types the data of a v5 event it is asked for by name", () => {
    const frames = null as unknown as TestApp["frames"];
    expectTypeOf(frames({ event: "qd:e" })).toEqualTypeOf<RecordedFrame<EntityFrame>[]>();
    expectTypeOf(frames.waitFor({ event: "qd:changed", userId: "ada" })).resolves.toEqualTypeOf<
      RecordedFrame<ChangedFrame>
    >();
    expectTypeOf(frames({ userId: null })).toEqualTypeOf<RecordedFrame[]>();
    expectTypeOf(frames((frame) => frame.at > 0)).toEqualTypeOf<RecordedFrame[]>();
  });
});
