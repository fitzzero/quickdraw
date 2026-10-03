// Type tests for the sharing and membership kit (RFC 0003 section 12.3).
// `bun run typecheck` checks this file, and vitest's typecheck mode reports
// each block as a test. Each `@ts-expect-error` sits on the line the
// compiler reports, so a rule that stops failing breaks the typecheck.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createQuickdrawClient } from "../../../client/index";
import {
  defineContract,
  query,
  sharing as sharingContract,
  type ACL,
  type InputOf,
  type Member,
  type MembersPage,
  type OutputOf,
  type ParsedInputOf,
} from "../../../index";
import {
  anyOf,
  custom,
  initQuickdraw,
  jsonAcl,
  members,
  sharing,
  type Principal,
  type SharingChange,
} from "../../index";

const projectRow = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });

type ProjectRow = z.output<typeof projectRow>;

const project = defineContract("projectService", {
  entity: projectRow,
  methods: {
    ...sharingContract.contract({ mode: "acl" }),
    ...sharingContract.contract({ mode: "members", methods: ["invite", "leave", "listMembers"] }),
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
  },
});

const named = defineContract("namedService", {
  entity: projectRow,
  methods: {
    ...sharingContract.contract({ mode: "acl", methods: ["shareByName", "listShares"] }),
    ...sharingContract.contract({ mode: "members", methods: ["inviteByName"] }),
  },
});

interface Db {
  readonly project: { findUnique(args: object): Promise<ProjectRow> };
}

const qd = initQuickdraw<{ db: Db; principal: Principal }>();

const policy = {
  model: "project",
  access: anyOf(
    jsonAcl("acl", { owner: "ownerId" }),
    members({ model: "projectMember", entry: "projectId", user: "userId", level: "role" }),
  ),
} as const;

describe("sharing.contract", () => {
  test("types each method's input and output", () => {
    expectTypeOf<InputOf<typeof project, "share">>().toEqualTypeOf<{
      readonly id: string;
      readonly userId: string;
      readonly level: "Read" | "Moderate" | "Admin";
    }>();
    expectTypeOf<OutputOf<typeof project, "share">>().toEqualTypeOf<ACL>();
    expectTypeOf<OutputOf<typeof project, "listShares">>().toEqualTypeOf<ACL>();
    expectTypeOf<InputOf<typeof project, "unshare">>().toEqualTypeOf<{
      readonly id: string;
      readonly userId: string;
    }>();
    expectTypeOf<InputOf<typeof project, "invite">>().toEqualTypeOf<{
      readonly entryId: string;
      readonly userId: string;
      readonly role?: string;
    }>();
    expectTypeOf<ParsedInputOf<typeof project, "invite">["role"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<OutputOf<typeof project, "invite">>().toEqualTypeOf<Member>();
    expectTypeOf<OutputOf<typeof project, "leave">>().toEqualTypeOf<null>();
    expectTypeOf<OutputOf<typeof project, "listMembers">>().toEqualTypeOf<MembersPage>();
    expectTypeOf<ParsedInputOf<typeof project, "listMembers">["limit"]>().toEqualTypeOf<number>();
    expectTypeOf<InputOf<typeof named, "shareByName">>().toMatchTypeOf<{
      readonly id: string;
      readonly name?: string;
      readonly email?: string;
    }>();
  });

  test("adds the mode's methods, or exactly those named", () => {
    expectTypeOf<
      keyof ReturnType<typeof sharingContract.contract<{ mode: "acl" }>>
    >().toEqualTypeOf<"share" | "unshare" | "setLevel" | "listShares">();
    expectTypeOf<keyof typeof named.methods>().toEqualTypeOf<
      "shareByName" | "listShares" | "inviteByName"
    >();
    // @ts-expect-error invite is a method of mode "members"
    sharingContract.contract({ mode: "acl", methods: ["invite"] });
    // @ts-expect-error describe names methods of the mode
    sharingContract.contract({ mode: "members", describe: { share: "Shares" } });
  });

  test("gives the client ordinary members", () => {
    const client = createQuickdrawClient({ project });
    expectTypeOf(client.project.share.useMutation).toBeFunction();
    expectTypeOf(client.project.listMembers.useQuery).toBeFunction();
    // @ts-expect-error remove was not added
    expectTypeOf(client.project.remove).toBeObject();
  });
});

describe("sharing.handlers", () => {
  test("implements the kit's methods inside defineService under its default forms", () => {
    const made = sharing.handlers(project);
    expectTypeOf(made.share.access).toEqualTypeOf<{ readonly entry: "Admin" }>();
    expectTypeOf(made.listShares.access).toEqualTypeOf<{ readonly entry: "Read" }>();
    expectTypeOf(made.invite.access).toEqualTypeOf<{
      readonly entry: "Admin";
      readonly id: "entryId";
    }>();
    expectTypeOf(made.leave.access).toEqualTypeOf<"authenticated">();
    expectTypeOf<keyof typeof made>().toEqualTypeOf<
      "share" | "unshare" | "setLevel" | "listShares" | "invite" | "leave" | "listMembers"
    >();
    const service = qd.defineService(project, {
      ...policy,
      methods: {
        ...made,
        get: {
          access: { entry: "Read" },
          handler: ({ input, db }) => db.project.findUnique({ where: { id: input.id } }),
        },
      },
    });
    expectTypeOf(service.contract).toEqualTypeOf<typeof project>();
  });

  test("access replaces a method's form, typed by that method's input", () => {
    const made = sharing.handlers(project, {
      access: {
        share: { entry: "Moderate" },
        leave: { entry: "Read", id: "entryId" },
        invite: custom((ctx, input) => {
          expectTypeOf(ctx.principal).toEqualTypeOf<Principal>();
          expectTypeOf(input.role).toEqualTypeOf<string | undefined>();
          return input.entryId.length > 0;
        }),
      },
      onChange: (change, ctx) => {
        expectTypeOf(change).toEqualTypeOf<SharingChange>();
        expectTypeOf(ctx.principal.userId).toBeString();
      },
    });
    expectTypeOf(made.share.access).toEqualTypeOf<{ readonly entry: "Moderate" }>();
    expectTypeOf(made.unshare.access).toEqualTypeOf<{ readonly entry: "Admin" }>();
    sharing.handlers(project, {
      // @ts-expect-error leave's input has no id: the form must name entryId
      access: { leave: { entry: "Read" } },
    });
    sharing.handlers(project, {
      // @ts-expect-error get is not a method sharing.contract made
      access: { get: "public" },
    });
  });

  test("needs resolveUser exactly when the contract has a by-name method", () => {
    sharing.handlers(named, {
      resolveUser: (lookup, ctx) => {
        expectTypeOf(lookup.email).toEqualTypeOf<string | undefined>();
        expectTypeOf(ctx.principal).toEqualTypeOf<Principal>();
        return lookup.name === undefined ? null : "u1";
      },
    });
    // @ts-expect-error shareByName and inviteByName need resolveUser
    sharing.handlers(named);
    // @ts-expect-error shareByName and inviteByName need resolveUser
    sharing.handlers(named, {});
    // @ts-expect-error project has no by-name method
    sharing.handlers(project, { resolveUser: () => null });
  });

  test("a contract without the kit's methods does not compile", () => {
    const plain = defineContract("plainService", {
      entity: projectRow,
      methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
    });
    // @ts-expect-error plainService has no method sharing.contract made
    sharing.handlers(plain);
  });

  test("defineService still checks the forms against the service", () => {
    qd.defineService(project, {
      model: "project",
      // @ts-expect-error entry access needs the service's access policy
      methods: {
        ...sharing.handlers(project),
        get: { access: "public", handler: ({ input, db }) => db.project.findUnique(input) },
      },
    });
  });
});
