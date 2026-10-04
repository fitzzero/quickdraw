// The invalidation coordinator (RFC 0003 section 11.3) on a real TanStack
// `QueryClient` and real `QueryObserver`s, with fake timers and reads the
// test answers by hand: an invalidation never cancels a read in flight, a
// dirty key gets exactly one follow-up after its read settles, a window
// serves a burst as one refetch, unobserved keys are only marked stale, and
// refetches after a reconnect are spread over the jitter window.

import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvalidationCoordinator } from "./coordinator";

/** One read the test answers by hand. */
interface Read {
  readonly key: QueryKey;
  readonly signal: AbortSignal;
  resolve(data: unknown): void;
  reject(error: unknown): void;
}

function setup(options: { readonly maxKeys?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const coordinator = createInvalidationCoordinator(client, options);
  const reads: Read[] = [];
  const readsOf = (key: QueryKey): Read[] =>
    reads.filter((read) => JSON.stringify(read.key) === JSON.stringify(key));
  /** Observes `key` as a mounted hook would; returns the unmount. */
  function observe(key: QueryKey, staleTime = Number.POSITIVE_INFINITY): () => void {
    const observer = new QueryObserver(client, {
      queryKey: key,
      staleTime,
      queryFn: ({ queryKey, signal }) =>
        new Promise((resolve, reject) => {
          reads.push({ key: queryKey, signal, resolve, reject });
        }),
    });
    return observer.subscribe(() => undefined);
  }
  return { client, coordinator, reads, readsOf, observe };
}

/** Lets every settled read, and every timer due now, run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function fetching(client: QueryClient, key: QueryKey): boolean {
  return client.getQueryState(key)?.fetchStatus === "fetching";
}

const key = ["qd", "taskService", "m", "get", { id: "t1" }] as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an invalidation during a read", () => {
  it("does not cancel it, and causes exactly one refetch after it settles", async () => {
    const { client, coordinator, reads, observe } = setup();
    observe(key);
    expect(reads).toHaveLength(1);
    coordinator.invalidate(key, { exact: true });
    await settle();
    expect(reads).toHaveLength(1);
    expect(reads[0]?.signal.aborted).toBe(false);
    reads[0]?.resolve({ title: "first" });
    await settle();
    expect(reads).toHaveLength(2);
    expect(client.getQueryData(key)).toEqual({ title: "first" });
    reads[1]?.resolve({ title: "second" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toHaveLength(2);
    expect(client.getQueryData(key)).toEqual({ title: "second" });
  });

  it("is lost with TanStack's cancelRefetch: false alone, which is why the coordinator follows up", async () => {
    const { client, reads, observe } = setup();
    observe(key);
    void client.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    reads[0]?.resolve({ title: "read before the change" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toHaveLength(1);
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  });

  it("in a burst still causes one follow-up", async () => {
    const { coordinator, reads, observe } = setup();
    observe(key);
    for (let change = 0; change < 10; change += 1) {
      coordinator.invalidate(key, { exact: true });
    }
    reads[0]?.resolve({ title: "first" });
    await settle();
    expect(reads).toHaveLength(2);
    reads[1]?.resolve({ title: "after the burst" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toHaveLength(2);
  });

  it("from two hooks on one key causes one follow-up in total", async () => {
    const { coordinator, reads, observe } = setup();
    observe(key);
    observe(key);
    expect(reads).toHaveLength(1);
    coordinator.invalidate(key, { exact: true });
    coordinator.invalidate(key, { exact: true });
    reads[0]?.resolve({ title: "first" });
    await settle();
    reads[1]?.resolve({ title: "second" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toHaveLength(2);
  });

  it("follows up after a read that failed too", async () => {
    const { client, coordinator, reads, observe } = setup();
    observe(key);
    coordinator.invalidate(key, { exact: true });
    reads[0]?.reject(new Error("the read failed"));
    await settle();
    expect(reads).toHaveLength(2);
    reads[1]?.resolve({ title: "second" });
    await settle();
    expect(client.getQueryData(key)).toEqual({ title: "second" });
  });

  it("of a read nobody observes (a prefetch) leaves the key stale once it settles", async () => {
    const { client, coordinator, reads, observe } = setup();
    const prefetch = client.prefetchQuery({
      queryKey: key,
      staleTime: Number.POSITIVE_INFINITY,
      queryFn: ({ queryKey, signal }) =>
        new Promise((resolve, reject) => {
          reads.push({ key: queryKey, signal, resolve, reject });
        }),
    });
    expect(reads).toHaveLength(1);
    // A write lands after the read was taken.
    coordinator.invalidate(key, { exact: true });
    reads[0]?.resolve({ title: "read before the write" });
    await prefetch;
    await settle();
    expect(reads).toHaveLength(1);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryCache().hasListeners()).toBe(false);
    // A component mounting now reads it again rather than trusting it for 5 minutes.
    observe(key);
    expect(reads).toHaveLength(2);
    reads[1]?.resolve({ title: "after the write" });
    await settle();
    expect(client.getQueryData(key)).toEqual({ title: "after the write" });
  });

  it("of a key unmounted mid-flight causes no follow-up, and leaves the key stale", async () => {
    const { client, coordinator, reads, observe } = setup();
    const unmount = observe(key);
    coordinator.invalidate(key, { exact: true });
    unmount();
    expect(reads[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toHaveLength(1);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryCache().hasListeners()).toBe(false);
  });
});

describe("an invalidation while idle", () => {
  it("refetches immediately", async () => {
    const { client, coordinator, reads, observe } = setup();
    observe(key);
    reads[0]?.resolve({ title: "first" });
    await settle();
    expect(fetching(client, key)).toBe(false);
    coordinator.invalidate(key, { exact: true });
    expect(reads).toHaveLength(2);
    expect(fetching(client, key)).toBe(true);
  });

  it("opens a window: later ones are served together, once, when it ends", async () => {
    const { coordinator, reads, observe } = setup();
    observe(key);
    reads[0]?.resolve({ title: "first" });
    await settle();
    coordinator.invalidate(key, { exact: true });
    reads[1]?.resolve({ title: "second" });
    await settle();
    coordinator.invalidate(key, { exact: true });
    coordinator.invalidate(key, { exact: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(reads).toHaveLength(3);
    reads[2]?.resolve({ title: "third" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toHaveLength(3);
  });

  it("takes a window of its own length", async () => {
    const { coordinator, reads, observe } = setup();
    observe(key);
    reads[0]?.resolve({ title: "first" });
    await settle();
    coordinator.invalidate(key, { exact: true, windowMs: 1000 });
    reads[1]?.resolve({ title: "second" });
    await settle();
    coordinator.invalidate(key, { exact: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveLength(3);
  });

  it("of an unobserved key only marks it stale, and its next observer refetches it", async () => {
    const { client, coordinator, reads, observe } = setup();
    client.setQueryData(key, { title: "cached" });
    coordinator.invalidate(key, { exact: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toHaveLength(0);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    observe(key);
    expect(reads).toHaveLength(1);
  });
});

describe("keys", () => {
  it("are matched as a prefix unless exact, and each match is refetched once", async () => {
    const { coordinator, reads, readsOf, observe } = setup();
    const other = ["qd", "taskService", "m", "get", { id: "t2" }] as const;
    const list = ["qd", "taskService", "m", "list", { projectId: "p1" }] as const;
    observe(key);
    observe(other);
    observe(list);
    for (const read of [...reads]) {
      read.resolve({ title: "first" });
    }
    await settle();
    coordinator.invalidate(["qd", "taskService", "m", "get"]);
    expect(readsOf(key)).toHaveLength(2);
    expect(readsOf(other)).toHaveLength(2);
    expect(readsOf(list)).toHaveLength(1);
    coordinator.invalidate(["qd", "taskService", "m", "list"], { exact: true });
    expect(readsOf(list)).toHaveLength(1);
  });

  it("are looked after only while they owe work, at most maxKeys at once", async () => {
    const { client, coordinator, reads, readsOf, observe } = setup({ maxKeys: 1 });
    const other = ["qd", "taskService", "m", "get", { id: "t2" }] as const;
    observe(key);
    observe(other);
    coordinator.invalidate(key, { exact: true });
    // The second key finds no room: it is invalidated without a follow-up.
    coordinator.invalidate(other, { exact: true });
    expect(client.getQueryCache().hasListeners()).toBe(true);
    for (const read of [...reads]) {
      read.resolve({ title: "first" });
    }
    await settle();
    expect(readsOf(key)).toHaveLength(2);
    expect(readsOf(other)).toHaveLength(1);
    readsOf(key)[1]?.resolve({ title: "second" });
    await vi.advanceTimersByTimeAsync(250);
    expect(client.getQueryCache().hasListeners()).toBe(false);
    coordinator.invalidate(other, { exact: true });
    expect(readsOf(other)).toHaveLength(2);
  });
});

describe("createInvalidationCoordinator", () => {
  it("makes one coordinator per QueryClient until it is disposed", async () => {
    const { client, coordinator, reads, observe } = setup();
    expect(createInvalidationCoordinator(client)).toBe(coordinator);
    expect(createInvalidationCoordinator(new QueryClient())).not.toBe(coordinator);
    observe(key);
    coordinator.invalidate(key, { exact: true });
    coordinator.dispose();
    expect(client.getQueryCache().hasListeners()).toBe(false);
    reads[0]?.resolve({ title: "first" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toHaveLength(1);
    expect(createInvalidationCoordinator(client)).not.toBe(coordinator);
  });

  it("is disposed a tick after its last release, leaving no timer, unless retained again first", async () => {
    const { client, coordinator, reads, observe } = setup();
    const release = coordinator.retain();
    observe(key);
    reads[0]?.resolve({ title: "first" });
    await settle();
    coordinator.invalidate(key, { exact: true });
    coordinator.refetchAfterReconnect({ watched: () => true });
    // The window, and the refetch after the reconnect.
    expect(vi.getTimerCount()).toBe(2);
    // React's strict mode lets go and takes it again within one tick.
    release();
    const again = coordinator.retain();
    await settle();
    expect(createInvalidationCoordinator(client)).toBe(coordinator);
    expect(vi.getTimerCount()).toBe(2);
    again();
    again();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(createInvalidationCoordinator(client)).not.toBe(coordinator);
    // Retained again, a disposed coordinator is taken up again only where none replaced it.
    const revived = coordinator.retain();
    expect(createInvalidationCoordinator(client)).not.toBe(coordinator);
    revived();
  });

  it("refuses a window or a bound that is not a count", () => {
    expect(() => createInvalidationCoordinator(new QueryClient(), { windowMs: -1 })).toThrow(
      "windowMs must be a number, 0 or more",
    );
    expect(() => createInvalidationCoordinator(new QueryClient(), { maxKeys: Number.NaN })).toThrow(
      "maxKeys must be a number, 0 or more",
    );
  });
});

describe("refetchAfterReconnect", () => {
  async function connected() {
    const harness = setup();
    const watched = ["qd", "taskService", "m", "count", { projectId: "p1" }] as const;
    const fresh = ["qd", "taskService", "m", "get", { id: "fresh" }] as const;
    const stale = ["qd", "taskService", "m", "get", { id: "stale" }] as const;
    const elsewhere = ["rest", "users"] as const;
    harness.observe(watched);
    harness.observe(fresh);
    harness.observe(stale, 0);
    harness.observe(elsewhere, 0);
    for (const read of [...harness.reads]) {
      read.resolve({ title: "first" });
    }
    await settle();
    const isWatched = (queryKey: QueryKey): boolean =>
      JSON.stringify(queryKey) === JSON.stringify(watched);
    return { ...harness, watched, fresh, stale, elsewhere, isWatched };
  }

  it("spreads the refetches of watched and stale queries over the jitter window, and leaves fresh ones", async () => {
    const { coordinator, readsOf, watched, fresh, stale, elsewhere, isWatched } = await connected();
    vi.spyOn(Math, "random").mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
    coordinator.refetchAfterReconnect({ watched: (query) => isWatched(query.queryKey) });
    await settle();
    expect(readsOf(watched)).toHaveLength(1);
    expect(readsOf(stale)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(readsOf(watched)).toHaveLength(2);
    expect(readsOf(stale)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(readsOf(stale)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(readsOf(fresh)).toHaveLength(1);
    expect(readsOf(elsewhere)).toHaveLength(1);
  });

  it("refetches the watched and stale queries at once with jitterMs 0, and leaves fresh ones", async () => {
    const { coordinator, readsOf, watched, fresh, stale, elsewhere, isWatched } = await connected();
    const random = vi.spyOn(Math, "random");
    coordinator.refetchAfterReconnect({
      watched: (query) => isWatched(query.queryKey),
      jitterMs: 0,
    });
    // Sent before any timer runs.
    expect(readsOf(watched)).toHaveLength(2);
    expect(readsOf(stale)).toHaveLength(2);
    expect(random).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(readsOf(fresh)).toHaveLength(1);
    expect(readsOf(elsewhere)).toHaveLength(1);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a jitterMs of %s",
    async (jitterMs) => {
      const { coordinator, isWatched } = await connected();
      expect(() =>
        coordinator.refetchAfterReconnect({
          watched: (query) => isWatched(query.queryKey),
          jitterMs,
        }),
      ).toThrow("refetchAfterReconnect: jitterMs must be a number of milliseconds, 0 or more");
    },
  );

  it("skips a query read since the reconnect, or reading when its turn comes", async () => {
    const { client, coordinator, readsOf, watched, stale, isWatched } = await connected();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    coordinator.refetchAfterReconnect({ watched: (query) => isWatched(query.queryKey) });
    await vi.advanceTimersByTimeAsync(10);
    void client.refetchQueries({ queryKey: watched });
    readsOf(watched)[1]?.resolve({ title: "read after the reconnect" });
    void client.refetchQueries({ queryKey: stale });
    await vi.advanceTimersByTimeAsync(5000);
    expect(readsOf(watched)).toHaveLength(2);
    expect(readsOf(stale)).toHaveLength(2);
  });

  it("is cancelled by dispose", async () => {
    const { coordinator, readsOf, watched, isWatched } = await connected();
    coordinator.refetchAfterReconnect({ watched: (query) => isWatched(query.queryKey) });
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(readsOf(watched)).toHaveLength(1);
  });
});
