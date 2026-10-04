import type { User } from "@project/db";
import type { UserDTO } from "@project/shared";
import type { AccessLevel } from "@fitzzero/quickdraw-core";
// quickdraw-migrate: review [v4-api] 4.x API QuickdrawSocket (moved): lint's no-v4-api names each replacement
import { type QuickdrawSocket, resolver } from "@fitzzero/quickdraw-core/server";
import { qd } from "../quickdraw.js";
import { userContract } from "@project/shared";

// quickdraw-migrate: review [projection] 4.x toDto: subscribers now receive the contract entity's keys, projected from the row (dates as ISO strings); fold computed fields into a projection's select and map, then delete this function
function toDto(user: User): UserDTO {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    serviceAccess: user.serviceAccess as Record<string, AccessLevel> | null,
  };
}

// Any signed-in user may read a profile; only its owner may change it
// quickdraw-migrate: review [access-override] 4.x access override: port it to the service's access policy (owner, jsonAcl, members, inherit, anyOf or resolver), then delete this function
function checkAccess(userId: string, entryId: string, requiredLevel: AccessLevel, _socket: QuickdrawSocket): boolean {
  if (requiredLevel === "Read") {
    return true;
  }
  return userId === entryId;
}

// Protected fields non-elevated subscribers never receive
// quickdraw-migrate: review [projection] protected fields: declare them in the contract's fields with the level that may read each one (fields: { email: "Admin" }), then delete this function
function getProtectedFields(): (keyof UserDTO)[] {
  return ["email", "serviceAccess"];
}

export const userService = qd.defineService(userContract, {
  model: "user",
  // quickdraw-migrate: review [access-override] 4.x decided row access in checkAccess (now functions in this file): port them to a policy (owner, jsonAcl, members, inherit, anyOf or resolver). Until then this policy grants no row, so only service grants pass
  access: resolver({ levelsFor: () => ({}) }),
  methods: {
    getMe: {
      // quickdraw-migrate: review [access] "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
      access: "authenticated",
      handler: async ({ ctx, db }) => {
        if (!ctx.principal.userId) return null;
        const user = await db.user.findUnique({ where: { id: ctx.principal.userId } });
        return user ? toDto(user) : null;
      },
    },
    updateUser: {
      access: { service: "Read", entry: "Read", id: "id" },
      handler: async ({ input, ctx, db }) => {
        // Users can only update themselves unless they have service-level access
        if (input.id !== ctx.principal.userId && !(ctx.principal.serviceAccess ?? {}).userService) {
          throw new Error("Cannot update other users");
        }
        try {
          const updated = await db.user.update({
            where: { id: input.id },
            data: { name: input.name },
            select: { id: true, name: true },
          });
          // quickdraw-migrate: review [emit] hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db
          this.emitUpdate(input.id, updated);
          return updated;
        } catch (error) {
          if ((error as { code?: string }).code === "P2002") {
            return { error: "name_taken" as const };
          }
          throw error;
        }
      },
    },
    getProfile: {
      // quickdraw-migrate: review [access] this method takes an id but its access "public" checks no row, which 4.x allowed and 5.0 refuses unless the method says rowless: true, written here: every caller the form admits reaches any row by its id. Narrow it ({ entry: "Read" }, or { service: L, entry: L }) unless that is meant
      access: "public",
      rowless: true,
      handler: async ({ input, db }) =>
        db.user.findUnique({
          where: { id: input.id },
          select: { id: true, name: true },
        }),
    },
  },
});
