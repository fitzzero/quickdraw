import type { Prisma, PrismaClient, User } from "@project/db";
import type { UserDTO, UserServiceMethods } from "@project/shared";
import type { AccessLevel } from "@fitzzero/quickdraw-core";
import { BaseService, type QuickdrawSocket } from "@fitzzero/quickdraw-core/server";
import { z } from "zod";
import { cuidSchema } from "./shared/schemas.js";

const updateUserSchema = z.object({
  id: cuidSchema("user ID"),
  name: z.string().min(1).max(50),
});

export class UserService extends BaseService<
  User,
  Prisma.UserCreateInput,
  Prisma.UserUpdateInput,
  UserServiceMethods,
  Record<string, never>,
  UserDTO
> {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    super({ serviceName: "userService", hasEntryACL: false });
    this.prisma = prisma;
    this.setDelegate(prisma.user);
    this.initMethods();
  }

  protected override toDto(user: User): UserDTO {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      serviceAccess: user.serviceAccess as Record<string, AccessLevel> | null,
    };
  }

  // Any signed-in user may read a profile; only its owner may change it
  protected override checkAccess(
    userId: string,
    entryId: string,
    requiredLevel: AccessLevel,
    _socket: QuickdrawSocket,
  ): boolean {
    if (requiredLevel === "Read") {
      return true;
    }
    return userId === entryId;
  }

  // Protected fields non-elevated subscribers never receive
  protected override getProtectedFields(): (keyof UserDTO)[] {
    return ["email", "serviceAccess"];
  }

  private initMethods(): void {
    this.defineMethod(
      "getMe",
      "Read",
      async (_payload, ctx) => {
        if (!ctx.userId) return null;
        const user = await this.prisma.user.findUnique({ where: { id: ctx.userId } });
        return user ? this.toDto(user) : null;
      },
      { schema: z.object({}) },
    );

    this.defineMethod(
      "updateUser",
      "Read",
      async (payload, ctx) => {
        // Users can only update themselves unless they have service-level access
        if (payload.id !== ctx.userId && !ctx.serviceAccess.userService) {
          throw new Error("Cannot update other users");
        }
        try {
          const updated = await this.prisma.user.update({
            where: { id: payload.id },
            data: { name: payload.name },
            select: { id: true, name: true },
          });
          this.emitUpdate(payload.id, updated);
          return updated;
        } catch (error) {
          if ((error as { code?: string }).code === "P2002") {
            return { error: "name_taken" as const };
          }
          throw error;
        }
      },
      { schema: updateUserSchema, resolveEntryId: (p) => p.id },
    );

    // Anyone may look up a user's public profile by id
    this.defineMethod(
      "getProfile",
      "Public",
      async (payload, _ctx) =>
        this.prisma.user.findUnique({
          where: { id: payload.id },
          select: { id: true, name: true },
        }),
      { schema: z.object({ id: cuidSchema("user ID") }) },
    );

    this.verifyAllMethods(["getMe", "updateUser", "getProfile"]);
  }
}
