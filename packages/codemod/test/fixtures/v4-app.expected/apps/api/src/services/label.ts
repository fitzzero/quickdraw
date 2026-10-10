import type { Label, Prisma } from "@project/db";
// quickdraw-migrate: review [v4-api] 4.x API QuickdrawSocket (moved): lint's no-v4-api names each replacement
import { type QuickdrawSocket, resolver } from "@fitzzero/quickdraw-core/server";
import { qd } from "../quickdraw.js";
import { labelContract } from "@project/shared";
import { db } from "../db.js";

/** Called with a label's id whenever one is renamed or created. */
export type LabelListener = (labelId: string) => void;

// Labels renamed since start-up, as quickdraw-chat's game keeps its players
// quickdraw-migrate: review [this] 4.x instance field renamed of LabelService: now module state, one value for the whole process (a service object has no instance); keep it if that is right, else move it where it belongs
const renamed = new Set<string>();

// Set from the constructor's options, as quickdraw-chat's push service keeps its transport
// quickdraw-migrate: review [this] 4.x instance field onChange of LabelService, set by its constructor: now a module binding setUpLabelService(...) sets, one value for the whole process (a service object has no instance); keep it if that is right, else move it where it belongs
let onChange: LabelListener | undefined;

/** The room every label editor joins. */
// quickdraw-migrate: review [this] 4.x instance field room of LabelService, set by its constructor: now a module binding setUpLabelService(...) sets, one value for the whole process (a service object has no instance); keep it if that is right, else move it where it belongs
export let roomOfLabelService: string;

// quickdraw-migrate: review [this] 4.x constructor code of LabelService, its fields' values included: a service object has no constructor; call setUpLabelService(...) once where the server starts (or move each part to module scope or a job), then delete this function
export function setUpLabelService(options: { onChange?: LabelListener } = {}): void {
  onChange = options.onChange;
  // quickdraw-migrate: review [this] this.getRoomName was 4.x service-instance state: a service object has none. Import what it held, pass it in, or call another service with ctx.services
  roomOfLabelService = this.getRoomName("all");
}

/** How many labels were renamed since start-up. */
export function renamedCount(): number {
  return renamed.size;
}

/** The class's name, for logs: a member every object has, which the codemod must not take for one of its tables' keys. */
export function kind(): string {
  // quickdraw-migrate: review [this] this.constructor was 4.x service-instance state: a service object has none. Import what it held, pass it in, or call another service with ctx.services
  return this.constructor.name;
}

/** The label room and how many sockets are in it, for the admin page. */
export function roomStats(): { room: string; sockets: number } {
  const room = roomOfLabelService;
  // quickdraw-migrate: review [this] this.subscribers was 4.x service-instance state: a service object has none. Import what it held, pass it in, or call another service with ctx.services
  return { room, sockets: this.subscribers.get("all")?.size ?? 0 };
}

// The base class does the leaving; this only tells the listener
// quickdraw-migrate: review [this] overrode the 4.x BaseService method unsubscribeSocket, which 5.0 does not have: keep what it still needs elsewhere, then delete it
function unsubscribeSocket(socket: QuickdrawSocket): void {
  // quickdraw-migrate: review [this] dropped super.unsubscribeSocket(socket), a call of the 4.x base class, which 5.0 does not have: do here what this code still needs of it
  onChange?.(`left:${socket.id}`);
}

// Admin creates tell the listener too, as quickdraw-chat's definitions do
// quickdraw-migrate: review [this] overrode the 4.x BaseService method adminCreate, which 5.0 does not have: keep what it still needs elsewhere, then delete it
async function adminCreate(data: Prisma.LabelUncheckedCreateInput): Promise<Label> {
  // quickdraw-migrate: review [this] super.adminCreate(data) called the 4.x base class, which 5.0 does not have: it is undefined here; do what this code still needs of it
  const created = await undefined;
  onChange?.(created.id);
  return created;
}

// Deletes tell the listener too: 4.x's delete, whose name is a reserved word
// quickdraw-migrate: review [this] overrode the 4.x BaseService method delete, which 5.0 does not have: keep what it still needs elsewhere, then delete it; hoisted as deleteOfLabelService: delete is a reserved word
async function deleteOfLabelService(id: string): Promise<boolean> {
  await db.label.delete({ where: { id } });
  onChange?.(id);
  return true;
}

/** Deletes a label for the admin page, through the override. */
export async function removeLabel(id: string): Promise<boolean> {
  return await deleteOfLabelService(id);
}

/** Labels have no row-level access: only service grants open them. */
export const labelService = qd.defineService(labelContract, {
  model: "label",
  // quickdraw-migrate: review [access] 4.x had no row-level access here (no hasEntryACL, no checkAccess): only service grants opened rows, which this empty policy keeps. Give it a real policy if rows belong to someone
  access: resolver({ levelsFor: () => ({}) }),
  methods: {
    // quickdraw-migrate: review [kit] getLabel has the shape of the read/write kit's get, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
    getLabel: {
      access: { service: "Read", entry: "Read", id: "id" },
      handler: async ({ input }) => {
        return await db.label.findUnique({ where: { id: input.id } });
      },
    },
    renameLabel: {
      // quickdraw-migrate: review [access] 4.x's resolveEntryId was a function, kept here: where it returns nothing, the "" makes the row check fail, so only the service grant passes (4.x then applied the plain level)
      access: { service: "Moderate", entry: "Moderate", id: (input) => ((p) => p.labelId ?? null)(input) ?? "" },
      handler: async ({ input: { labelId, name } }) => {
        const label = await db.label.update({ where: { id: labelId }, data: { name } });
        renamed.add(label.id);
        onChange?.(label.id);
        return label;
      },
    },
    // quickdraw-migrate: review [kit] listLabels has the shape of the read/write kit's list, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
    listLabels: {
      // quickdraw-migrate: review [access] "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
      access: "authenticated",
      handler: async ({ input }) =>
        await db.label.findMany({
          where: { projectId: input.projectId },
          orderBy: { name: "asc" },
          take: 500,
        }),
    },
    deleteAllLabels: {
      access: { service: "Admin" },
      handler: async ({ input, ctx }) => {
        const { count } = await db.label.deleteMany({
          where: { projectId: input.projectId },
        });
        ctx.log.info(`Deleted ${count} labels`, { userId: ctx.principal.userId, service: "labelService" });
        return { count };
      },
    },
  },
});
