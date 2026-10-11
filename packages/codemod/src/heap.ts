// The heap the command runs with. The codemod holds one TypeScript program
// over the whole app, and Node's default heap (about 2 GiB to 4 GiB) is too
// small for an app of thousands of files. On a large app, bin/cli.mjs starts
// the command again in a Node with a larger heap: three quarters of the
// memory the process may use, at most 16 GiB. `--heap <MiB>` names the heap,
// and a `--max-old-space-size` the user passed (in NODE_OPTIONS or to node)
// is kept. Bun ignores V8's heap flags, so nothing changes under Bun.

/** Set in the relaunched process, so it never relaunches again. */
export const RELAUNCHED_ENV = "QUICKDRAW_CODEMOD_RELAUNCHED";

/** Above this many source files, the command sizes its heap itself. */
export const LARGE_APP = 1500;

/** The largest heap the command picks on its own, in MiB. */
export const MAX_HEAP = 16_384;

const MIB = 1024 * 1024;

/** What the heap decision reads from the process and the app. */
export interface HeapFacts {
  /** The app's source files, counted as the codemod loads them. */
  readonly files: number;
  /** The current heap limit (`v8.getHeapStatistics().heap_size_limit`), in MiB. */
  readonly limit: number;
  /** `process.constrainedMemory()`: the cgroup's limit, 0 (or a huge number) without one, in bytes. */
  readonly constrained: number;
  /** `os.totalmem()`, in bytes. */
  readonly total: number;
  /** `--heap`, in MiB. */
  readonly requested: number | undefined;
  /** Whether the user passed `--max-old-space-size` (in NODE_OPTIONS or to node). */
  readonly explicit: boolean;
  readonly bun: boolean;
  /** Whether this process is the relaunched one. */
  readonly relaunched: boolean;
}

/** The memory the process may use, in bytes: the cgroup's limit when there is one, else the machine's. */
export function availableMemory(constrained: number, total: number): number {
  return constrained > 0 && constrained < total ? constrained : total;
}

/** The heap the command picks for a large app, in MiB: 75% of `memory`, at most `MAX_HEAP`. */
export function targetHeap(memory: number): number {
  return Math.min(MAX_HEAP, Math.floor((memory * 0.75) / MIB));
}

/** Whether Node's options name a heap: `--max-old-space-size=N` or `--max-old-space-size N`. */
export function namesHeap(options: readonly string[]): boolean {
  return options.some((option) => /^--max[-_]old[-_]space[-_]size(?:=|$)/u.test(option));
}

/** The heap (MiB) to start the command again with, or `undefined` to run it in this process. */
export function heapToUse(facts: HeapFacts): number | undefined {
  if (facts.bun || facts.relaunched) {
    return undefined;
  }
  if (facts.requested !== undefined) {
    return facts.requested;
  }
  if (facts.explicit || facts.files <= LARGE_APP) {
    return undefined;
  }
  const target = targetHeap(availableMemory(facts.constrained, facts.total));
  return facts.limit < target ? target : undefined;
}

/** What to say when the relaunched command ends on a signal or out of heap, else `undefined`. */
export function exitNote(
  heap: number,
  status: number | null,
  signal: string | null,
): string | undefined {
  if (signal === "SIGKILL") {
    return `quickdraw-codemod: the system stopped the command (SIGKILL) with a ${String(heap)} MiB heap, most likely because the machine ran out of memory: pass a smaller --heap, or run it where more memory is free`;
  }
  if (signal === "SIGABRT" || status === 134) {
    return `quickdraw-codemod: the command stopped, most likely because it ran out of its ${String(heap)} MiB heap: pass a larger --heap`;
  }
  return undefined;
}

/** The exit code that passes the relaunched command's on: its own, else 128 plus its signal's number. */
export function exitCode(status: number | null, signalNumber: number | undefined): number {
  return status ?? 128 + (signalNumber ?? 0);
}
