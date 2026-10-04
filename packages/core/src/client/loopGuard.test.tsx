// The client's loop warnings (`loopGuard.ts`): a component that mutates from
// an effect with no guard is named once, with its component; a query key an
// app invalidates more than 20 times within a second, or the coordinator
// refetches or marks stale that often, is named once, while a watched topic
// the coordinator coalesces is not; the stack parsing behind the component's
// name; and nothing outside development.

import { QueryClient, QueryObserver } from "@tanstack/react-query";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

/** Once its query has data, invalidates it from an effect its own run runs again (30 runs). */
function RunawayInvalidate() {
  const read = qd.counter.read.useQuery({ name: "loop" });
  const [runs, setRuns] = React.useState(0);
  const loaded = read.data !== undefined;
  React.useEffect(() => {
    if (loaded && runs < 30) {
      qd.invalidate(qd.counter.read, { name: "loop" });
      setRuns(runs + 1);
    }
  }, [loaded, runs]);
  return <p>{runs === 30 && read.data !== undefined ? "settled" : "looping"}</p>;
}

describe("a query invalidated from an effect that runs itself again", () => {
  it("is named once, though the coordinator reads it only a few times", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app, records } = await harness.start();
    const view = render(
      <QuickdrawProvider
        client={qd}
        url={app.url}
        auth={{ principal: alice }}
        transports={["websocket"]}
        queryClient={new QueryClient()}
      >
        <RunawayInvalidate />
      </QuickdrawProvider>,
    );
    await screen.findByText("settled");
    await sleep(300);
    view.unmount();
    expect(quickdrawWarnings(warn)).toEqual([
      "[quickdraw:repeated-invalidation] counterService.read: invalidated 21 times within a second: " +
        "an effect or a render that invalidates it on every run loops with the read it causes. " +
        "Invalidate from an event handler or once a mutation settles; a scope that changes this often reads better as a collection",
    ]);
    const reads = records.filter((record) => record.method === "read");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThan(6);
  });
});

describe("a watched topic that changes 25 times a second", () => {
  it("is not named: the coordinator refetches it a few times, and counts those", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const queryClient = new QueryClient();
    const key = qd.counter.read.key({ name: "busy" });
    let fetches = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => {
        fetches += 1;
        await sleep(5);
        return { name: "busy", value: fetches };
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await waitFor(() => expect(fetches).toBe(1));
    const coordinator = createInvalidationCoordinator(queryClient);
    // What useTopicWatch does for each qd:changed of the topic.
    for (let change = 0; change < 25; change += 1) {
      coordinator.invalidate(key, { exact: true });
      await sleep(38);
    }
    await sleep(400);
    expect(fetches - 1).toBeGreaterThan(1);
    expect(fetches - 1).toBeLessThan(10);
    expect(quickdrawWarnings(warn)).toEqual([]);
    unsubscribe();
    coordinator.dispose();
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

  it("names a query key the coordinator marks stale more than 20 times within a second, once", () => {
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

  it("counts invalidations per key, within the window, apart from the coordinator's refetches", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let now = 0;
    const guard = createLoopGuard(() => now);
    for (let round = 0; round < 40; round += 1) {
      const key = ["qd", "taskService", "m", "list", { round }];
      guard.asked(key, `list-${String(round % 2)}`);
      guard.issued(key, `list-${String(round % 2)}`);
      now += 60;
    }
    for (let round = 0; round < 20; round += 1) {
      guard.asked(["qd", "taskService", "m", "get", {}], "get");
      guard.issued(["qd", "taskService", "m", "get", {}], "get");
    }
    expect(quickdrawWarnings(warn)).toEqual([]);
    for (let round = 0; round < 21; round += 1) {
      guard.asked(["other", "key"], "other");
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
        guard.asked(["qd"], "qd");
        guard.issued(["qd"], "qd");
      }
      expect(quickdrawWarnings(warn)).toEqual([]);
    } finally {
      process.env.NODE_ENV = env;
    }
    expect(createMutationTrace().origin).toBeInstanceOf(Error);
  });
});
