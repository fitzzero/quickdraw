// Whether a test runs in the cluster projects (`bun run test:cluster`), where
// every test app is two servers behind Valkey (`setup.ts`): the reader node
// every client connects to and the writer node every in-process write goes
// through. The few single-server assertions a cluster answers differently by
// design ask it, and assert the cluster's answer instead:
//
// - frames go out whole (`u`, `updated`) where one server sends a patch:
//   frames from two nodes can reach a client out of revision order;
// - the writer node reads every touched row and scope, since other nodes'
//   rooms are invisible to it;
// - a resume (`qd:col:sub` with `since`) reads a page: a process's buffer
//   sees its own flushes only;
// - what reaches a client through Valkey arrives after a write's own
//   acknowledgement, so "eventually" assertions poll.

/** True in the cluster projects. */
export function inCluster(): boolean {
  return process.env.QD_CLUSTER === "1";
}

let barrier: (() => Promise<void>) | undefined;

/** Registers the barrier of the test cluster booted last (`nodes.ts`). */
export function registerBarrier(next: () => Promise<void>): void {
  barrier = next;
}

/** Forgets `old`, a closed cluster's barrier, unless a later cluster's replaced it. */
export function dropBarrier(old: () => Promise<void>): void {
  if (barrier === old) {
    barrier = undefined;
  }
}

/**
 * In the cluster projects, waits until everything the writer node of the
 * cluster booted last published (frames, stream items, broadcasts) has
 * reached the reader node; elsewhere, nothing. The test helpers that wait
 * for "every frame the server sent before now" call it first: a push or a
 * reset made on the writer node is not a call they could wait for.
 */
export async function settleCluster(): Promise<void> {
  await barrier?.();
}
