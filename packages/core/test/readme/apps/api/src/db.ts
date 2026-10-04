import { trackPrisma } from "@fitzzero/quickdraw-core/prisma";
import { prisma } from "@project/db";

// Every write through `db` is tracked: subscribers see it. Apply trackPrisma
// last, after any other client extension.
export const db = trackPrisma(prisma);
