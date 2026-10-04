import { qd } from "../quickdraw.js";
import { healthContract } from "@project/shared";

/** Method-only service: no rows, no subscriptions. */
export const healthService = qd.defineService(healthContract, {
  methods: {
    ping: {
      access: "public",
      handler: async ({ ctx }) => {
        ctx.log.debug("ping");
        return { ok: true as const, at: new Date().toISOString() };
      },
    },
    stats: {
      access: { service: "Admin" },
      handler: async ({ db }) => {
        const [projects, tasks] = await Promise.all([
          db.project.count(),
          db.task.count(),
        ]);
        return { projects, tasks };
      },
    },
  },
});
