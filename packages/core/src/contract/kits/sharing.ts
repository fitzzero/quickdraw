// The sharing and membership kit's contract half (RFC 0003 section 12.3).
// `sharing.contract` returns ordinary `query` and `mutation` entries to
// spread into a contract's `methods`, for one of two ways a service's rows
// are shared:
//
//   export const project = defineContract("projectService", {
//     entity: projectSchema,
//     methods: {
//       ...sharing.contract({ mode: "acl" }), // share, unshare, setLevel, listShares
//       ...sharing.contract({ mode: "members", methods: ["invite", "remove", "leave", "listMembers"] }),
//     },
//   });
//
// `"acl"` edits the JSON access list a `jsonAcl` policy reads; `"members"`
// edits the membership table a `members` policy reads. `methods` picks the
// methods to add, by name; without it a mode adds all of its methods but the
// by-name ones (`shareByName`, `inviteByName`), which find the user by name
// or email through the server's `resolveUser`. The server half
// (`sharing.handlers` on `./server`) finds the kit's entries in the contract
// by what they were made for (`sharingSpecOf`), and its types by their tag
// (`SharingTag`), so the two halves name the same methods.

import type { ACL } from "../access";
import { mutation, query, type MethodDef, type MutationDef, type QueryDef } from "../methods";
import { idInput, nullOutput, type IdInput } from "./crudSchemas";
import type { KitSchema } from "./schemas";
import {
  aclOutput,
  inviteByNameInput,
  inviteInput,
  leaveInput,
  listMembersInput,
  memberInput,
  memberOutput,
  membersPageOutput,
  setRoleInput,
  shareByNameInput,
  shareInput,
  unshareInput,
  type InviteByNameInput,
  type InviteByNameQuery,
  type InviteInput,
  type InviteQuery,
  type LeaveInput,
  type ListMembersInput,
  type ListMembersQuery,
  type Member,
  type MemberInput,
  type MembersPage,
  type SetRoleInput,
  type ShareByNameInput,
  type ShareByNameQuery,
  type ShareInput,
  type UnshareInput,
} from "./sharingSchemas";

/** How a service's rows are shared: a JSON access list (`jsonAcl`) or a membership table (`members`). */
export type SharingMode = "acl" | "members";

/** The methods of `mode: "acl"`. */
export type AclMethodName = "share" | "shareByName" | "unshare" | "setLevel" | "listShares";

/** The methods of `mode: "members"`. */
export type MembersMethodName =
  | "invite"
  | "inviteByName"
  | "remove"
  | "leave"
  | "setRole"
  | "listMembers";

/** Every method the sharing kit can add. */
export type SharingMethodName = AclMethodName | MembersMethodName;

/** The methods that find their user by name or email: opt-in, since they need `resolveUser`. */
export type SharingByNameMethod = "shareByName" | "inviteByName";

/** Every method of each mode: those of RFC 0003 section 12.3, then the by-name one. */
export const SHARING_METHODS: {
  readonly acl: readonly AclMethodName[];
  readonly members: readonly MembersMethodName[];
} = Object.freeze({
  acl: Object.freeze<AclMethodName[]>([
    "share",
    "unshare",
    "setLevel",
    "listShares",
    "shareByName",
  ]),
  members: Object.freeze<MembersMethodName[]>([
    "invite",
    "remove",
    "leave",
    "setRole",
    "listMembers",
    "inviteByName",
  ]),
});

/** Type-only: marks a method the sharing kit made, and which one. Never set. */
export interface SharingTag<Kind extends SharingMethodName> {
  readonly "~sharing"?: Kind;
}

/** `sharing.contract`'s options, for one mode. */
export type SharingContractOptions =
  | {
      readonly mode: "acl";
      /** The methods to add; all but `shareByName` when absent. */
      readonly methods?: readonly AclMethodName[];
      /** Descriptions for people and agents, per method; the kit's own for the rest. */
      readonly describe?: { readonly [Name in AclMethodName]?: string };
    }
  | {
      readonly mode: "members";
      /** The methods to add; all but `inviteByName` when absent. */
      readonly methods?: readonly MembersMethodName[];
      /** Descriptions for people and agents, per method; the kit's own for the rest. */
      readonly describe?: { readonly [Name in MembersMethodName]?: string };
    };

export type SharingShare = MutationDef<KitSchema<ShareInput>, KitSchema<ACL>> & SharingTag<"share">;
export type SharingShareByName = MutationDef<
  KitSchema<ShareByNameInput, ShareByNameQuery>,
  KitSchema<ACL>
> &
  SharingTag<"shareByName">;
export type SharingUnshare = MutationDef<KitSchema<UnshareInput>, KitSchema<ACL>> &
  SharingTag<"unshare">;
export type SharingSetLevel = MutationDef<KitSchema<ShareInput>, KitSchema<ACL>> &
  SharingTag<"setLevel">;
export type SharingListShares = QueryDef<KitSchema<IdInput>, KitSchema<ACL>> &
  SharingTag<"listShares">;
export type SharingInvite = MutationDef<KitSchema<InviteInput, InviteQuery>, KitSchema<Member>> &
  SharingTag<"invite">;
export type SharingInviteByName = MutationDef<
  KitSchema<InviteByNameInput, InviteByNameQuery>,
  KitSchema<Member>
> &
  SharingTag<"inviteByName">;
export type SharingRemove = MutationDef<KitSchema<MemberInput>, KitSchema<null>> &
  SharingTag<"remove">;
export type SharingLeave = MutationDef<KitSchema<LeaveInput>, KitSchema<null>> &
  SharingTag<"leave">;
export type SharingSetRole = MutationDef<KitSchema<SetRoleInput>, KitSchema<Member>> &
  SharingTag<"setRole">;
export type SharingListMembers = QueryDef<
  KitSchema<ListMembersInput, ListMembersQuery>,
  KitSchema<MembersPage>
> &
  SharingTag<"listMembers">;

/** The entry `sharing.contract` makes for method `Name`. */
export type SharingDefOf<Name extends SharingMethodName> = {
  share: SharingShare;
  shareByName: SharingShareByName;
  unshare: SharingUnshare;
  setLevel: SharingSetLevel;
  listShares: SharingListShares;
  invite: SharingInvite;
  inviteByName: SharingInviteByName;
  remove: SharingRemove;
  leave: SharingLeave;
  setRole: SharingSetRole;
  listMembers: SharingListMembers;
}[Name];

type ModeIn<O> = O extends { readonly mode: infer Mode } ? Mode : never;

type DefaultNames<Mode> = Mode extends "acl"
  ? Exclude<AclMethodName, SharingByNameMethod>
  : Mode extends "members"
    ? Exclude<MembersMethodName, SharingByNameMethod>
    : never;

type NamesIn<O> = O extends { readonly methods: readonly (infer Name extends SharingMethodName)[] }
  ? Name
  : DefaultNames<ModeIn<O>>;

/** The entries `sharing.contract(options)` returns: one per method it adds. */
export type SharingMethods<O> = { readonly [Name in NamesIn<O>]: SharingDefOf<Name> };

/** What the server half needs to know about a method the sharing kit made. */
export interface SharingSpec {
  readonly method: SharingMethodName;
  readonly mode: SharingMode;
}

const SPECS = new WeakMap<object, SharingSpec>();

/** What the sharing kit made `method` for, or `undefined` for any other method. */
export function sharingSpecOf(method: unknown): SharingSpec | undefined {
  return typeof method === "object" && method !== null ? SPECS.get(method) : undefined;
}

const DESCRIBE: Readonly<Record<SharingMethodName, string>> = Object.freeze({
  share:
    "Gives a user a level on one row: Read, Moderate or Admin. A user the row is shared with already gets the new level.",
  shareByName:
    "Gives the user with this name or email a level on one row: Read, Moderate or Admin.",
  unshare: "Takes a user's level on one row away. The owner's cannot be taken away.",
  setLevel: "Changes the level of a user one row is already shared with.",
  listShares: "Lists the users one row is shared with, and their levels.",
  invite: "Makes a user a member of one row, with a role (the lowest role when none is given).",
  inviteByName:
    "Makes the user with this name or email a member of one row, with a role (the lowest role when none is given).",
  remove: "Ends a user's membership of one row. The last Admin member cannot be removed.",
  leave: "Ends the caller's own membership of one row. The last Admin member cannot leave.",
  setRole: "Changes a member's role on one row.",
  listMembers:
    "Lists the members of one row and their roles, a page at a time. Pass a page's nextCursor back as cursor for the next page.",
});

const BUILD: Readonly<Record<SharingMethodName, (describe: string) => MethodDef>> = Object.freeze({
  share: (describe) => mutation({ input: shareInput(), output: aclOutput(), describe }),
  shareByName: (describe) => mutation({ input: shareByNameInput(), output: aclOutput(), describe }),
  unshare: (describe) => mutation({ input: unshareInput(), output: aclOutput(), describe }),
  setLevel: (describe) => mutation({ input: shareInput(), output: aclOutput(), describe }),
  listShares: (describe) => query({ input: idInput(), output: aclOutput(), describe }),
  invite: (describe) => mutation({ input: inviteInput(), output: memberOutput(), describe }),
  inviteByName: (describe) =>
    mutation({ input: inviteByNameInput(), output: memberOutput(), describe }),
  remove: (describe) => mutation({ input: memberInput(), output: nullOutput(), describe }),
  leave: (describe) => mutation({ input: leaveInput(), output: nullOutput(), describe }),
  setRole: (describe) => mutation({ input: setRoleInput(), output: memberOutput(), describe }),
  listMembers: (describe) =>
    query({ input: listMembersInput(), output: membersPageOutput(), describe }),
});

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TypeError(`sharing.contract: ${message}`);
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

function modeOf(options: unknown): SharingMode {
  if (!isRecord(options)) {
    fail('options must be { mode: "acl" | "members", methods?, describe? }');
  }
  const unknownKey = Object.keys(options).find(
    (key) => !["mode", "methods", "describe"].includes(key),
  );
  if (unknownKey !== undefined) {
    fail(`unknown option "${unknownKey}"; the options are mode, methods and describe`);
  }
  const { mode } = options;
  if (mode !== "acl" && mode !== "members") {
    fail('mode must be "acl" (a jsonAcl access list) or "members" (a members table)');
  }
  return mode;
}

/** The methods the options add: those `methods` names, or the mode's default ones. */
function namesOf(mode: SharingMode, methods: unknown): readonly SharingMethodName[] {
  const all: readonly SharingMethodName[] = SHARING_METHODS[mode];
  if (methods === undefined) {
    return all.filter((name) => name !== "shareByName" && name !== "inviteByName");
  }
  const valid =
    Array.isArray(methods) &&
    methods.length > 0 &&
    methods.every((name) => all.some((known) => known === name)) &&
    new Set(methods).size === methods.length;
  if (!valid) {
    fail(`methods must name one or more distinct methods of mode "${mode}": ${quoted(all)}`);
  }
  return methods as SharingMethodName[];
}

/** The descriptions the options give, each for a method they add. */
function describeOf(names: readonly SharingMethodName[], describe: unknown): UnknownRecord {
  if (describe === undefined) {
    return {};
  }
  if (!isRecord(describe)) {
    fail("describe must map method names to descriptions");
  }
  for (const [name, text] of Object.entries(describe)) {
    if (!names.some((added) => added === name)) {
      fail(`describe names "${name}", which these options do not add`);
    }
    if (typeof text !== "string" || text.length === 0) {
      fail(`describe for "${name}" must be a non-empty string`);
    }
  }
  return describe;
}

function contract<const O extends SharingContractOptions>(options: O): SharingMethods<O> {
  const mode = modeOf(options);
  const names = namesOf(mode, options.methods);
  const described = describeOf(names, options.describe);
  const methods: Record<string, MethodDef> = {};
  for (const name of names) {
    const own = described[name];
    const def = BUILD[name](typeof own === "string" ? own : DESCRIBE[name]);
    SPECS.set(def, Object.freeze({ method: name, mode }));
    methods[name] = def;
  }
  return Object.freeze(methods) as unknown as SharingMethods<O>;
}

/**
 * The sharing and membership kit's contract half: `sharing.contract({ mode,
 * methods?, describe? })` makes the methods that share a row through its
 * JSON access list (`mode: "acl"`) or its membership table
 * (`mode: "members"`), which the server half (`sharing.handlers` on
 * `./server`) implements.
 */
export const sharing = Object.freeze({ contract });
