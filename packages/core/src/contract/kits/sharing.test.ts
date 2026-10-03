// The sharing and membership kit's contract half (RFC 0003 section 12.3):
// the entries `sharing.contract` makes per mode, the inputs and outputs it
// generates (validation and JSON Schema), and the options it refuses.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SHARING_METHODS,
  defineContract,
  hasJsonSchema,
  sharing,
  validate,
  type StandardSchemaV1,
} from "../../index";
import { sharingSpecOf } from "./sharing";

const acl = sharing.contract({ mode: "acl" });
const team = sharing.contract({ mode: "members" });
const byName = sharing.contract({
  mode: "acl",
  methods: ["listShares", "shareByName"],
  describe: { shareByName: "Shares a board with a teammate." },
});
const invites = sharing.contract({ mode: "members", methods: ["inviteByName", "listMembers"] });

/** The issues' paths a schema reports for `value`, or the value it parsed. */
async function check(schema: StandardSchemaV1, value: unknown) {
  const result = await validate(schema, value);
  return result.issues === undefined
    ? { value: result.value }
    : { paths: result.issues.map((issue) => issue.path ?? []) };
}

function json(schema: StandardSchemaV1) {
  if (!hasJsonSchema(schema)) {
    throw new Error("no JSON Schema");
  }
  return schema["~standard"].jsonSchema.input({ target: "draft-07" });
}

describe("sharing.contract", () => {
  it("makes each mode's methods but the by-name ones, and marks each with its kind", () => {
    expect(Object.keys(acl)).toEqual(["share", "unshare", "setLevel", "listShares"]);
    expect(Object.keys(team)).toEqual(["invite", "remove", "leave", "setRole", "listMembers"]);
    expect(Object.isFrozen(acl) && Object.isFrozen(team)).toBe(true);
    expect([acl.listShares.kind, team.listMembers.kind]).toEqual(["query", "query"]);
    expect(
      [
        acl.share,
        acl.unshare,
        acl.setLevel,
        team.invite,
        team.remove,
        team.leave,
        team.setRole,
      ].map((def) => def.kind),
    ).toEqual(Array.from({ length: 7 }, () => "mutation"));
    expect(sharingSpecOf(acl.unshare)).toEqual({ method: "unshare", mode: "acl" });
    expect(sharingSpecOf(team.leave)).toEqual({ method: "leave", mode: "members" });
    expect(sharingSpecOf({ kind: "query" })).toBeUndefined();
    expect(SHARING_METHODS.acl).toContain("shareByName");
    expect(SHARING_METHODS.members).toContain("inviteByName");
  });

  it("adds exactly the methods named, by-name ones included, with their descriptions", () => {
    expect(Object.keys(byName)).toEqual(["listShares", "shareByName"]);
    expect(Object.keys(invites)).toEqual(["inviteByName", "listMembers"]);
    expect(byName.shareByName.describe).toBe("Shares a board with a teammate.");
    expect(byName.listShares.describe).toBe(
      "Lists the users one row is shared with, and their levels.",
    );
    expect(sharingSpecOf(invites.inviteByName)).toEqual({
      method: "inviteByName",
      mode: "members",
    });
  });

  it("goes into a contract beside other methods, both modes together", () => {
    const project = defineContract("projectService", {
      entity: z.object({ id: z.string(), name: z.string() }),
      methods: { ...acl, ...team },
    });
    expect(Object.keys(project.methods)).toHaveLength(9);
    expect(sharingSpecOf(project.methods.setRole)).toEqual({ method: "setRole", mode: "members" });
  });

  it("refuses options it does not know, and malformed ones", () => {
    const bad = (options: unknown) => () => sharing.contract(options as never);
    expect(bad(undefined)).toThrow("sharing.contract: options must be");
    expect(bad({ mode: "acl", entity: {} })).toThrow('unknown option "entity"');
    expect(bad({ mode: "owner" })).toThrow('mode must be "acl"');
    expect(bad({ mode: "acl", methods: ["invite"] })).toThrow(
      'methods must name one or more distinct methods of mode "acl": "share", "unshare", "setLevel", "listShares", "shareByName"',
    );
    expect(bad({ mode: "members", methods: [] })).toThrow("methods must name one or more");
    expect(bad({ mode: "members", methods: ["leave", "leave"] })).toThrow("distinct methods");
    expect(bad({ mode: "acl", methods: ["share"], describe: { unshare: "x" } })).toThrow(
      'describe names "unshare", which these options do not add',
    );
    expect(bad({ mode: "acl", describe: { share: "" } })).toThrow(
      'describe for "share" must be a non-empty string',
    );
    expect(bad({ mode: "acl", describe: "Shares" })).toThrow("describe must map method names");
  });
});

describe("the access list inputs", () => {
  it("take a row, a user and a level a list entry can usefully hold", async () => {
    expect(await check(acl.share.input, { id: "p1", userId: "u1", level: "Admin" })).toEqual({
      value: { id: "p1", userId: "u1", level: "Admin" },
    });
    expect(
      await check(acl.setLevel.input, { id: "", userId: 3, level: "Public", extra: true }),
    ).toEqual({ paths: [["extra"], ["id"], ["userId"], ["level"]] });
    expect(await check(acl.unshare.input, { id: "p1", userId: "u1" })).toEqual({
      value: { id: "p1", userId: "u1" },
    });
    expect(await check(acl.unshare.input, { id: "p1", userId: "u1", level: "Read" })).toEqual({
      paths: [["level"]],
    });
    expect(await check(acl.listShares.input, { id: "p1" })).toEqual({ value: { id: "p1" } });
    expect(await check(acl.share.input, "p1")).toEqual({ paths: [[]] });
  });

  it("take a name or an email in a by-name method", async () => {
    const input = byName.shareByName.input;
    expect(await check(input, { id: "p1", email: "gus@example.com", level: "Read" })).toEqual({
      value: { id: "p1", name: undefined, email: "gus@example.com", level: "Read" },
    });
    expect(await check(input, { id: "p1", level: "Read" })).toEqual({ paths: [[]] });
    expect(await check(input, { id: "p1", name: "x".repeat(257), level: "Read" })).toEqual({
      paths: [["name"]],
    });
  });
});

describe("the membership inputs", () => {
  it("take an entry, a user and an optional role", async () => {
    expect(await check(team.invite.input, { entryId: "p1", userId: "u1" })).toEqual({
      value: { entryId: "p1", userId: "u1", role: undefined },
    });
    expect(await check(team.invite.input, { entryId: "p1", userId: "u1", role: "" })).toEqual({
      paths: [["role"]],
    });
    expect(await check(team.setRole.input, { entryId: "p1", userId: "u1" })).toEqual({
      paths: [["role"]],
    });
    expect(await check(team.remove.input, { entryId: "p1", userId: "u1" })).toEqual({
      value: { entryId: "p1", userId: "u1" },
    });
    expect(await check(team.leave.input, { entryId: "p1", userId: "u1" })).toEqual({
      paths: [["userId"]],
    });
    expect(await check(invites.inviteByName.input, { entryId: "p1", role: "Read" })).toEqual({
      paths: [[]],
    });
  });

  it("page listMembers: 50 by default, at most 200, with a cursor", async () => {
    expect(await check(team.listMembers.input, { entryId: "p1" })).toEqual({
      value: { entryId: "p1", cursor: undefined, limit: 50 },
    });
    expect(await check(team.listMembers.input, { entryId: "p1", cursor: "c", limit: 500 })).toEqual(
      { value: { entryId: "p1", cursor: "c", limit: 200 } },
    );
    expect(
      await check(team.listMembers.input, { entryId: "p1", cursor: "", limit: 0, sort: "id" }),
    ).toEqual({ paths: [["sort"], ["cursor"], ["limit"]] });
  });

  it("describe themselves as JSON Schema, for MCP tools", () => {
    expect(json(team.invite.input)).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        entryId: { type: "string", minLength: 1 },
        userId: { type: "string", minLength: 1 },
        role: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["entryId", "userId"],
      additionalProperties: false,
    });
    expect(json(acl.share.input)).toMatchObject({
      properties: { level: { type: "string", enum: ["Read", "Moderate", "Admin"] } },
      required: ["id", "userId", "level"],
    });
    expect(json(team.listMembers.input)).toMatchObject({
      required: ["entryId"],
      properties: { limit: { type: "integer", maximum: 200, default: 50 } },
    });
    expect(json(byName.shareByName.input)).toMatchObject({ required: ["id", "level"] });
    expect(json(team.listMembers.output)).toMatchObject({
      required: ["items", "nextCursor"],
      properties: { items: { type: "array", items: { required: ["userId", "role", "level"] } } },
    });
  });
});

describe("the outputs", () => {
  it("are an access list, a member, a page of members, or null", async () => {
    expect(
      await check(acl.share.output as StandardSchemaV1, [{ userId: "u1", level: "Read" }]),
    ).toEqual({
      value: [{ userId: "u1", level: "Read" }],
    });
    expect(
      await check(acl.listShares.output as StandardSchemaV1, [
        { userId: "u1", level: "Read", addedAt: "x" },
        { userId: "u2", level: "Owner" },
      ]),
    ).toEqual({ paths: [[0], [1]] });
    const member = { userId: "u1", role: "editor", level: null };
    expect(await check(team.setRole.output as StandardSchemaV1, member)).toEqual({ value: member });
    expect(
      await check(team.listMembers.output as StandardSchemaV1, {
        items: [member, { userId: "u2", role: 1, level: "Read" }],
        nextCursor: 3,
      }),
    ).toEqual({ paths: [["items", 1], ["nextCursor"]] });
    expect(await check(team.leave.output as StandardSchemaV1, null)).toEqual({ value: null });
  });
});
