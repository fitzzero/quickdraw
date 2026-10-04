// The default unit of work: it records no writes, but it already has the
// shape tracked writes need. `run` awaits the handler's result inside its
// own frame (RFC 0003 section 5.1), so swapping in the tracked implementation
// changes no call site.

import type { UnitOfWork, UnitOfWorkFactory } from "./types";

const UNTRACKED: UnitOfWork = Object.freeze({
  sqlStatements: undefined,
  async run<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    return await fn();
  },
  flush: (): Promise<void> => Promise.resolve(),
});

/** Units of work that record nothing. The dispatcher's default until writes are tracked. */
export const untrackedUnitOfWork: UnitOfWorkFactory = Object.freeze({
  begin: (): UnitOfWork => UNTRACKED,
});
