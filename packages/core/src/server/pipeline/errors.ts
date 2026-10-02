// How the pipeline turns whatever a stage or handler threw into the error the
// caller receives (RFC 0003 section 3). A `QuickdrawError` passes through.
// Prisma's two known request errors that callers can act on become
// `CONFLICT` and `NOT_FOUND`. Everything else becomes `INTERNAL` with the
// generic message, keeping the original as `cause` for the log and for
// in-process callers; `toWire` never sends it.

import { INTERNAL_MESSAGE, QuickdrawError } from "../../protocol/errors";

/** The error a cancelled call settles with. */
export function cancelledError(): QuickdrawError {
  return new QuickdrawError("CANCELLED", "The call was cancelled");
}

/** The error a call settles with when its handler runs past the time limit. */
export function timeoutError(timeoutMs: number): QuickdrawError {
  return new QuickdrawError("TIMEOUT", `The call ran past its time limit of ${timeoutMs} ms`);
}

/** Throws `CANCELLED` when `signal` has aborted. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw cancelledError();
  }
}

function prismaError(error: unknown): QuickdrawError | undefined {
  if (!(error instanceof Error) || error.name !== "PrismaClientKnownRequestError") {
    return undefined;
  }
  const { code } = error as Error & { readonly code?: unknown };
  if (code === "P2002") {
    return new QuickdrawError("CONFLICT", "A unique constraint failed");
  }
  if (code === "P2025") {
    return new QuickdrawError("NOT_FOUND", "Record not found");
  }
  return undefined;
}

/**
 * The `QuickdrawError` a caller receives for `error`. Anything but a
 * `QuickdrawError` keeps the original as `cause`, so it can be logged in full.
 */
export function toQuickdrawError(error: unknown): QuickdrawError {
  if (error instanceof QuickdrawError) {
    return error;
  }
  const mapped = prismaError(error) ?? new QuickdrawError("INTERNAL", INTERNAL_MESSAGE);
  mapped.cause = error;
  return mapped;
}
