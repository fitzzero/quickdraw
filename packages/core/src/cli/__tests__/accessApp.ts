// A small app for `quickdraw-docs --services` (docs.test.ts): contracts, and
// the services that implement them, between them the access forms, row
// policies, principal kinds, collection scopes, streams and channels the
// access pages describe. `noteService` has a contract and no service, as an app's
// services module can miss one. Nothing here runs: the docs read the
// definitions only.

import { z } from "zod";
import { defineContract, mutation, query, via } from "../../index";
import { anyOf, custom, inherit, initQuickdraw, members, owner } from "../../server/index";

const qd = initQuickdraw();

const team = z.object({ id: z.string(), name: z.string(), ownerId: z.string(), notes: z.string() });
const player = z.object({ id: z.string(), teamId: z.string(), userId: z.string() });
const byId = z.object({ id: z.string() });

export const teamContract = defineContract("teamService", {
  entity: team,
  fields: { notes: "Admin" },
  methods: {
    get: query({ input: byId, output: "entity" }),
    profile: query({ input: byId, output: "entity" }),
    rename: mutation({ input: byId.extend({ name: z.string().min(1) }), output: "entity" }),
    stats: query({ input: z.undefined(), output: z.number().int().nonnegative() }),
    audit: query({ input: z.object({ since: z.string() }), output: z.null() }),
    ping: query({ input: z.undefined(), output: z.null() }),
    roster: query({ input: z.object({ teamId: z.string() }), output: z.array(player) }),
  },
  streams: {
    world: {
      item: z.number(),
      scope: "worldId",
      access: { room: (worldId: string) => `world:${worldId}` },
    },
    lobby: { item: z.string(), access: { room: "lobby" }, seed: 1 },
    feed: { item: z.string(), scope: "teamId", access: { room: { prefix: "team:" } } },
  },
  channels: { cursor: { payload: z.object({ x: z.number() }), requires: { room: "lobby" } } },
});

export const playerContract = defineContract("playerService", {
  entity: player,
  methods: {
    get: query({ input: byId, output: "entity" }),
    join: mutation({ input: z.object({ teamId: z.string() }), output: "entity" }),
  },
  collections: {
    byTeam: { scope: "teamId", item: "entity", order: [["id", "asc"]] },
    mine: {
      scope: via({ model: "teamMember", entry: "playerId", scope: "userId" }),
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});

export const noteContract = defineContract("noteService", {
  methods: { read: query({ input: z.undefined(), output: z.string() }) },
});

const nothing = (): never => {
  throw new Error("never called");
};

export const teamService = qd.defineService(teamContract, {
  model: "team",
  access: anyOf(
    owner("ownerId"),
    members({ model: "teamMember", entry: "teamId", user: "userId", level: "role" }),
  ),
  watchAccess: "authenticated",
  kinds: ["user", "agent"],
  methods: {
    get: { access: { entry: "Read" }, handler: nothing },
    profile: { access: "public", rowless: true, handler: nothing },
    rename: { access: { service: "Admin", entry: "Moderate" }, kinds: ["user"], handler: nothing },
    stats: { access: { service: "Moderate" }, handler: nothing },
    audit: { access: custom(() => true), handler: nothing },
    ping: { access: "authenticated", handler: nothing },
    roster: { access: { entry: "Read", id: "teamId" }, handler: nothing },
  },
  streams: { feed: { seed: () => [], validate: "development" } },
  channels: { cursor: { access: { service: "Read" }, handler: () => undefined } },
});

export const playerService = qd.defineService(playerContract, {
  model: "player",
  access: inherit({ from: teamContract, via: "teamId" }),
  adminBypass: false,
  collections: { byTeam: { anchor: teamContract }, mine: { scopeAccess: "self" } },
  methods: {
    get: { access: { entry: "Read" }, handler: nothing },
    join: { access: { scope: "Moderate", of: teamContract, id: "teamId" }, handler: nothing },
  },
});

/** The services, as an app's services module exports them: one list. */
export const services = [teamService, playerService] as const;
