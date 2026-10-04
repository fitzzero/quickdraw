// quickdraw-migrate: review [v4-api] 4.x API ServiceMethodContext (removed): lint's no-v4-api names each replacement
import type { ServiceMethodContext } from "@fitzzero/quickdraw-core";

/** Assert the caller is authenticated and narrow `ctx.userId` to string. */
export function requireAuth(
  ctx: ServiceMethodContext,
): asserts ctx is ServiceMethodContext & { userId: string } {
  if (!ctx.userId) {
    throw new Error("Authentication required");
  }
}
