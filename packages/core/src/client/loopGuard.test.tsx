// The client's loop warnings (`loopGuard.ts`): a component that mutates from
// an effect with no guard is named once, with its component; a query key
// invalidated more than 20 times within a second is named once; the stack
// parsing behind the component's name; and nothing outside development.

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInvalidationCoordinator } from "./coordinator";
import { createQuickdrawClient } from "./createClient";
import {
  componentOf,
  createLoopGuard,
  createMutationTrace,
  isDevelopment,
  loopGuardOf,
} from "./loopGuard";
import { QuickdrawProvider } from "./provider";
import { alice, clientHarness, counter } from "./__tests__/fixtures";

const harness = clientHarness();
const qd = createQuickdrawClient({ counter });

/** The quickdraw warnings `console.warn` received (the root's `consoleLogger` prefixes `[WARN] `). */
function quickdrawWarnings(spy: {
  readonly mock: { readonly calls: readonly unknown[][] };
}): string[] {
  return spy.mock.calls
    .map((args: readonly unknown[]) => String(args[0]))
    .filter((message: string) => message.startsWith("[WARN] [quickdraw:"))
    .map((message: string) => message.slice("[WARN] ".length));
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mutates after every render, with no guard: each mutation re-renders it, so it never stops. */
function RunawayBump() {
  const bump = qd.counter.bump.useMutation();
  React.useEffect(() => {
    bump.mutate({ name: "runaway" });
  });
  return <p>{bump.data === undefined ? "bumping" : `at ${String(bump.data.value)}`}</p>;
}

describe("a mutation fired from an effect with no guard", () => {
  it("is named once, with the member and the component that holds the hook", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = await harness.start();
    const view = render(
      <QuickdrawProvider
        client={qd}
        url={app.url}
        auth={{ principal: alice }}
        transports={["websocket"]}
        queryClient={new QueryClient()}
      >
        <RunawayBump />
      </QuickdrawProvider>,
    );
    await waitFor(() =>
      expect(quickdrawWarnings(warn).some((m) => m.includes("repeated-mutation"))).toBe(true),
    );
    await screen.findByText(/^at \d+$/u);
    view.unmount();
    const named = quickdrawWarnings(warn).filter((m) => m.includes("repeated-mutation"));
    expect(named).toEqual([
      "[quickdraw:repeated-mutation] counterService.bump: mutated 6 times within a second by one useMutation (in RunawayBump): " +
        "a mutation fired from an effect or from render repeats like this, and each one writes. " +
        "Fire it from an event handler, or guard the effect so it runs once per change",
    ]);
  });
});

describe("the loop guard", () => {
  const trace = () => ({ times: [], origin: undefined });

  it("names a hook instance that mutates more than 5 times within a second, once per member", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let now = 0;
    const guard = createLoopGuard(() => now);
    const slow = trace();
    for (let round = 0; round < 20; round += 1) {
      guard.mutated(slow, "taskService", "rename");
      now += 250;
    }
    expect(quickdrawWarnings(warn)).toEqual([]);
    const [first, second] = [trace(), trace()];
    for (let round = 0; round < 6; round += 1) {
      guard.mutated(first, "taskService", "rename");
      guard.mutated(second, "taskService", "rename");
    }
    expect(quickdrawWarnings(warn)).toHaveLength(1);
    expect(quickdrawWarnings(warn)[0]).toMatch(
      /^\[quickdraw:repeated-mutation\] taskService\.rename: mutated 6 times within a second by one useMutation: /u,
    );
  });

  it("names a query key invalidated more than 20 times within a second through the coordinator, once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const queryClient = new QueryClient();
    const key = qd.counter.read.key({ name: "a" });
    queryClient.setQueryData(key, { name: "a", value: 0 });
    const coordinator = createInvalidationCoordinator(queryClient);
    for (let round = 0; round < 30; round += 1) {
      coordinator.invalidate(key, { exact: true });
    }
    expect(quickdrawWarnings(warn)).toEqual([
      "[quickdraw:repeated-invalidation] counterService.read: invalidated 21 times within a second: " +
        "an effect or a render that invalidates it on every run loops with the read it causes. " +
        "Invalidate from an event handler or once a mutation settles; a scope that changes this often reads better as a collection",
    ]);
    expect(loopGuardOf(queryClient)).toBe(loopGuardOf(queryClient));
    coordinator.dispose();
  });

  it("counts invalidations per key, within the window", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let now = 0;
    const guard = createLoopGuard(() => now);
    for (let round = 0; round < 40; round += 1) {
      guard.invalidated(["qd", "taskService", "m", "list", { round }], `list-${String(round % 2)}`);
      now += 60;
    }
    expect(quickdrawWarnings(warn)).toEqual([]);
    for (let round = 0; round < 21; round += 1) {
      guard.invalidated(["other", "key"], "other");
    }
    expect(quickdrawWarnings(warn)).toEqual([
      expect.stringMatching(
        /^\[quickdraw:repeated-invalidation\] \["other","key"\]: invalidated 21 times/u,
      ),
    ]);
  });

  it("finds the component in a trace's stack, from V8 and from Firefox", () => {
    const stack = (frames: readonly string[]) =>
      Object.assign(new Error("x"), { stack: ["Error: x", ...frames].join("\n") });
    expect(
      componentOf(
        stack([
          "    at createMutationTrace (loopGuard.ts:1:1)",
          "    at useMethodMutation (hooks.ts:1:1)",
          "    at TaskEditor (TaskEditor.tsx:12:3)",
          "    at Object.react_stack_bottom_frame (react-dom-client.development.js:1:1)",
        ]),
      ),
    ).toBe("TaskEditor");
    expect(
      componentOf(
        stack([
          "useMethodMutation@hooks.ts:1:1",
          "Object.Board@Board.tsx:3:1",
          "react-stack-bottom-frame@react-dom.js:1:1",
        ]),
      ),
    ).toBe("Board");
    expect(componentOf(stack(["    at useMethodMutation (hooks.ts:1:1)"]))).toBeUndefined();
    expect(
      componentOf(stack(["    at <anonymous>", "    at react_stack_bottom_frame (x.js:1:1)"])),
    ).toBeUndefined();
    expect(componentOf(undefined)).toBeUndefined();
  });

  it("keeps no trace, and warns about nothing, outside development", () => {
    expect(isDevelopment()).toBe(true);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(isDevelopment()).toBe(false);
      expect(createMutationTrace().origin).toBeUndefined();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const guard = loopGuardOf(new QueryClient());
      const quiet = createMutationTrace();
      for (let round = 0; round < 30; round += 1) {
        guard.mutated(quiet, "taskService", "rename");
        guard.invalidated(["qd"], "qd");
      }
      expect(quickdrawWarnings(warn)).toEqual([]);
    } finally {
      process.env.NODE_ENV = env;
    }
    expect(createMutationTrace().origin).toBeInstanceOf(Error);
  });
});
