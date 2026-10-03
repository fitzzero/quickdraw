// When live collections check their scopes without being told to (RFC 0003
// section 11.5). A scope stays current from its frames, but a frame can be
// missed: a tab a browser froze, a node of a cluster that interleaved
// flushes. So, while any scope is held:
//
// - when the page becomes visible after being hidden for at least 30 s, every
//   scope resumes from the revision it holds (a resume the server serves
//   from its recent deltas costs one small answer);
// - every 5 minutes, plus or minus 20% so clients spread out, the same
//   check runs: the idle convergence check.
//
// A resume after a reconnect is the store's own (`liveData.ts`). Nothing here
// needs a DOM: without `document` (React Native, Node) only the timer runs.
// Conveyor wrote both checks around 4.1's `useCollection` by hand.
//
// React-free.

/** How long the page must have been hidden for its scopes to be checked when it shows again. */
export const VISIBLE_AFTER_MS = 30_000;

/** How often held scopes are checked, before jitter. */
export const IDLE_CHECK_MS = 5 * 60 * 1000;

/** The share of {@link IDLE_CHECK_MS} the check moves by, either way, at random. */
export const IDLE_CHECK_JITTER = 0.2;

/** The checks of one set of live collections. */
export interface ResumeChecks {
  /** Starts them, unless they run. */
  start(): void;
  /** Stops them. */
  stop(): void;
}

/** The page's visibility, where there is a page. */
interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** The document, when the code runs in a browser; `undefined` elsewhere. */
function pageDocument(): VisibilitySource | undefined {
  const found: unknown = typeof document === "undefined" ? undefined : document;
  const usable =
    typeof found === "object" &&
    found !== null &&
    typeof (found as Partial<VisibilitySource>).addEventListener === "function";
  return usable ? (found as VisibilitySource) : undefined;
}

/** The next idle check's delay: 5 minutes, give or take 20%. */
function idleDelay(): number {
  return IDLE_CHECK_MS * (1 - IDLE_CHECK_JITTER + Math.random() * 2 * IDLE_CHECK_JITTER);
}

/** Creates the checks that call `check` when the page shows again after 30 s hidden, and every 5 minutes. */
export function createResumeChecks(check: () => void): ResumeChecks {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hiddenAt: number | undefined;
  let page: VisibilitySource | undefined;

  const arm = (): void => {
    timer = setTimeout(() => {
      arm();
      check();
    }, idleDelay());
  };

  const onVisibility = (): void => {
    if (page?.visibilityState === "hidden") {
      hiddenAt ??= Date.now();
      return;
    }
    const hiddenFor = hiddenAt === undefined ? 0 : Date.now() - hiddenAt;
    hiddenAt = undefined;
    if (hiddenFor >= VISIBLE_AFTER_MS) {
      check();
    }
  };

  return Object.freeze({
    start(): void {
      if (running) {
        return;
      }
      running = true;
      arm();
      page = pageDocument();
      hiddenAt = page?.visibilityState === "hidden" ? Date.now() : undefined;
      page?.addEventListener("visibilitychange", onVisibility);
    },
    stop(): void {
      running = false;
      clearTimeout(timer);
      timer = undefined;
      page?.removeEventListener("visibilitychange", onVisibility);
      page = undefined;
    },
  });
}
