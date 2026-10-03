// The inputs and outputs the sharing and membership kit generates (RFC 0003
// section 12.3). An access list method names its row as `id` and its user as
// `userId`, and grants one of the levels a list entry can usefully hold
// (`Read`, `Moderate` or `Admin`); a membership method names its row as
// `entryId` and a stored role as `role`, which the server checks against the
// service's `members` policy (the contract cannot know its roles). The
// by-name methods take `name` or `email` instead of `userId`, for the
// server's `resolveUser`. `listMembers` pages like `list` (`crudList.ts`):
// 50 members by default, at most 200, by keyset cursor.
//
// Outputs: an access list as `ACL` (`[{ userId, level }]`, one entry per
// user), a member as `{ userId, role, level }`, a page of members, or `null`.

import { ACCESS_LEVELS, isAccessLevel, type ACL, type AccessLevel } from "../access";
import type { StandardSchemaV1 } from "../standardSchema";
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, MAX_CURSOR_LENGTH, pagingIssues } from "./crudList";
import {
  idJson,
  isId,
  isRecord,
  kitSchema,
  objectJson,
  unknownKeys,
  type JsonSchema,
  type KitSchema,
} from "./schemas";

/** A level an access list entry is given: `Public` grants nothing, so it is not one. */
export type ShareLevel = Exclude<AccessLevel, "Public">;

/** The levels `share` and `setLevel` grant, lowest first. */
export const SHARE_LEVELS: readonly ShareLevel[] = Object.freeze(["Read", "Moderate", "Admin"]);

/** The longest role, name or email the kit accepts. */
const MAX_TEXT_LENGTH = 256;

/** `share` and `setLevel`: give `userId` `level` on the row `id`. */
export interface ShareInput {
  readonly id: string;
  readonly userId: string;
  readonly level: ShareLevel;
}

/** `unshare`: take `userId`'s level on the row `id` away. */
export interface UnshareInput {
  readonly id: string;
  readonly userId: string;
}

/** Who a by-name method means: their name or their email, at least one. */
export interface UserLookupInput {
  readonly name?: string;
  readonly email?: string;
}

/** `shareByName`: `share`, with the user found by name or email. */
export interface ShareByNameInput extends UserLookupInput {
  readonly id: string;
  readonly level: ShareLevel;
}

/** `shareByName`'s input as its handler receives it. */
export interface ShareByNameQuery {
  readonly id: string;
  readonly name: string | undefined;
  readonly email: string | undefined;
  readonly level: ShareLevel;
}

/** `invite`: make `userId` a member of the row `entryId`, with `role` (the lowest by default). */
export interface InviteInput {
  readonly entryId: string;
  readonly userId: string;
  readonly role?: string;
}

/** `invite`'s input as its handler receives it. */
export interface InviteQuery {
  readonly entryId: string;
  readonly userId: string;
  readonly role: string | undefined;
}

/** `inviteByName`: `invite`, with the user found by name or email. */
export interface InviteByNameInput extends UserLookupInput {
  readonly entryId: string;
  readonly role?: string;
}

/** `inviteByName`'s input as its handler receives it. */
export interface InviteByNameQuery {
  readonly entryId: string;
  readonly name: string | undefined;
  readonly email: string | undefined;
  readonly role: string | undefined;
}

/** `remove`: end `userId`'s membership of the row `entryId`. */
export interface MemberInput {
  readonly entryId: string;
  readonly userId: string;
}

/** `leave`: end the caller's own membership of the row `entryId`. */
export interface LeaveInput {
  readonly entryId: string;
}

/** `setRole`: change `userId`'s role on the row `entryId`. */
export interface SetRoleInput {
  readonly entryId: string;
  readonly userId: string;
  readonly role: string;
}

/** `listMembers`: one page of the members of the row `entryId`. */
export interface ListMembersInput {
  readonly entryId: string;
  /** The `nextCursor` of the page before; the first page when absent. */
  readonly cursor?: string;
  /** The page size: default 50, at most 200 (a larger one is clamped). */
  readonly limit?: number;
}

/** `listMembers`' input as its handler receives it: the limit defaulted and clamped. */
export interface ListMembersQuery {
  readonly entryId: string;
  readonly cursor: string | undefined;
  readonly limit: number;
}

/** One member of a row. */
export interface Member {
  readonly userId: string;
  /** The role the membership table stores. */
  readonly role: string;
  /** The access level the role gives, or `null` for a role that gives none. */
  readonly level: AccessLevel | null;
}

/** One page of `listMembers`. */
export interface MembersPage {
  readonly items: Member[];
  /** Passed back as `cursor` for the next page; `null` on the last page. */
  readonly nextCursor: string | null;
}

type Issues = StandardSchemaV1.Issue[];

/** What one input key holds: a row or user id, a level, a role, or a name or email. */
type FieldKind = "id" | "level" | "role" | "text";

interface Field {
  readonly kind: FieldKind;
  readonly optional?: boolean;
}

const MESSAGES: Readonly<Record<FieldKind, string>> = Object.freeze({
  id: "Expected a non-empty string",
  level: 'Expected "Read", "Moderate" or "Admin"',
  role: `Expected a role: a non-empty string of at most ${MAX_TEXT_LENGTH} characters`,
  text: `Expected a non-empty string of at most ${MAX_TEXT_LENGTH} characters`,
});

function isText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function fits(kind: FieldKind, value: unknown): boolean {
  if (kind === "id") {
    return isId(value);
  }
  return kind === "level" ? SHARE_LEVELS.some((level) => level === value) : isText(value);
}

function fieldJson(kind: FieldKind): JsonSchema {
  if (kind === "id") {
    return idJson();
  }
  return kind === "level"
    ? { type: "string", enum: [...SHARE_LEVELS] }
    : { type: "string", minLength: 1, maxLength: MAX_TEXT_LENGTH };
}

/** How one input is checked and parsed. */
interface InputShape {
  readonly fields: Readonly<Record<string, Field>>;
  /** Keys checked by `issues` rather than by a field: `listMembers`' paging. */
  readonly more?: Readonly<Record<string, JsonSchema>>;
  /** Issues no single field shows: a by-name method needs a name or an email. */
  readonly issues?: (value: Readonly<Record<string, unknown>>) => Issues;
  /** The parsed input, when it is not the known keys as given. */
  readonly parse?: (value: Readonly<Record<string, unknown>>) => unknown;
}

function fieldIssues(shape: InputShape, value: Readonly<Record<string, unknown>>): Issues {
  return Object.entries(shape.fields).flatMap(([key, field]): Issues => {
    const given = value[key];
    const missing = given === undefined && field.optional !== true;
    const wrong = given !== undefined && !fits(field.kind, given);
    return missing || wrong ? [{ message: MESSAGES[field.kind], path: [key] }] : [];
  });
}

function inputJson(shape: InputShape): JsonSchema {
  const properties = Object.fromEntries(
    Object.entries(shape.fields).map(([key, field]) => [key, fieldJson(field.kind)]),
  );
  const required = Object.entries(shape.fields)
    .filter(([, field]) => field.optional !== true)
    .map(([key]) => key);
  return objectJson({ ...properties, ...shape.more }, required);
}

/** An input made of `shape`'s keys and nothing else. */
function objectInput<Input, Parsed = Input>(shape: InputShape): KitSchema<Input, Parsed> {
  const keys = [...Object.keys(shape.fields), ...Object.keys(shape.more ?? {})];
  return kitSchema<Input, Parsed>(
    (input) => {
      if (!isRecord(input)) {
        return { issues: [{ message: "Expected an object", path: [] }] };
      }
      const issues = [
        ...unknownKeys(input, keys),
        ...fieldIssues(shape, input),
        ...(shape.issues?.(input) ?? []),
      ];
      if (issues.length > 0) {
        return { issues };
      }
      const parsed =
        shape.parse?.(input) ?? Object.fromEntries(keys.map((key) => [key, input[key]]));
      return { value: parsed as Parsed };
    },
    { input: () => inputJson(shape) },
  );
}

const ID: Field = { kind: "id" };
const LEVEL: Field = { kind: "level" };
const ROLE: Field = { kind: "role" };
const OPTIONAL_ROLE: Field = { kind: "role", optional: true };
const OPTIONAL_TEXT: Field = { kind: "text", optional: true };

function lookupIssues(value: Readonly<Record<string, unknown>>): Issues {
  return value.name === undefined && value.email === undefined
    ? [{ message: "Give name or email", path: [] }]
    : [];
}

/** `{ id, userId, level }`: `share`'s and `setLevel`'s input. */
export function shareInput(): KitSchema<ShareInput> {
  return objectInput<ShareInput>({ fields: { id: ID, userId: ID, level: LEVEL } });
}

/** `{ id, name?, email?, level }`: `shareByName`'s input. */
export function shareByNameInput(): KitSchema<ShareByNameInput, ShareByNameQuery> {
  return objectInput<ShareByNameInput, ShareByNameQuery>({
    fields: { id: ID, name: OPTIONAL_TEXT, email: OPTIONAL_TEXT, level: LEVEL },
    issues: lookupIssues,
  });
}

/** `{ id, userId }`: `unshare`'s input. */
export function unshareInput(): KitSchema<UnshareInput> {
  return objectInput<UnshareInput>({ fields: { id: ID, userId: ID } });
}

/** `{ entryId, userId, role? }`: `invite`'s input. */
export function inviteInput(): KitSchema<InviteInput, InviteQuery> {
  return objectInput<InviteInput, InviteQuery>({
    fields: { entryId: ID, userId: ID, role: OPTIONAL_ROLE },
  });
}

/** `{ entryId, name?, email?, role? }`: `inviteByName`'s input. */
export function inviteByNameInput(): KitSchema<InviteByNameInput, InviteByNameQuery> {
  return objectInput<InviteByNameInput, InviteByNameQuery>({
    fields: { entryId: ID, name: OPTIONAL_TEXT, email: OPTIONAL_TEXT, role: OPTIONAL_ROLE },
    issues: lookupIssues,
  });
}

/** `{ entryId, userId }`: `remove`'s input. */
export function memberInput(): KitSchema<MemberInput> {
  return objectInput<MemberInput>({ fields: { entryId: ID, userId: ID } });
}

/** `{ entryId }`: `leave`'s input. */
export function leaveInput(): KitSchema<LeaveInput> {
  return objectInput<LeaveInput>({ fields: { entryId: ID } });
}

/** `{ entryId, userId, role }`: `setRole`'s input. */
export function setRoleInput(): KitSchema<SetRoleInput> {
  return objectInput<SetRoleInput>({ fields: { entryId: ID, userId: ID, role: ROLE } });
}

/** `{ entryId, cursor?, limit? }`: `listMembers`' input. */
export function listMembersInput(): KitSchema<ListMembersInput, ListMembersQuery> {
  return objectInput<ListMembersInput, ListMembersQuery>({
    fields: { entryId: ID },
    more: {
      cursor: { type: "string", minLength: 1, maxLength: MAX_CURSOR_LENGTH },
      limit: { type: "integer", minimum: 1, maximum: LIST_MAX_LIMIT, default: LIST_DEFAULT_LIMIT },
    },
    issues: (value) => pagingIssues({ cursor: value.cursor, limit: value.limit }),
    parse: (value): ListMembersQuery => ({
      entryId: value.entryId as string,
      cursor: value.cursor as string | undefined,
      limit: Math.min((value.limit as number | undefined) ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT),
    }),
  });
}

function shareIssues(entry: unknown, path: readonly PropertyKey[]): Issues {
  const valid =
    isRecord(entry) &&
    isId(entry.userId) &&
    isAccessLevel(entry.level) &&
    Object.keys(entry).length === 2;
  return valid ? [] : [{ message: "Expected { userId, level }", path: [...path] }];
}

function shareJson(): JsonSchema {
  return objectJson({ userId: idJson(), level: { type: "string", enum: [...ACCESS_LEVELS] } }, [
    "userId",
    "level",
  ]);
}

/** `[{ userId, level }]`: an access list, as `share`, `unshare`, `setLevel` and `listShares` return it. */
export function aclOutput(): KitSchema<ACL> {
  return kitSchema<ACL>(
    (value) => {
      if (!Array.isArray(value)) {
        return { issues: [{ message: "Expected an access list", path: [] }] };
      }
      const issues = value.flatMap((entry: unknown, index) => shareIssues(entry, [index]));
      return issues.length > 0 ? { issues } : { value: value as ACL };
    },
    { input: () => ({ type: "array", items: shareJson() }) },
  );
}

function memberIssues(member: unknown, path: readonly PropertyKey[]): Issues {
  const valid =
    isRecord(member) &&
    isId(member.userId) &&
    typeof member.role === "string" &&
    (member.level === null || isAccessLevel(member.level)) &&
    Object.keys(member).length === 3;
  return valid ? [] : [{ message: "Expected { userId, role, level }", path: [...path] }];
}

function memberJson(): JsonSchema {
  return objectJson(
    { userId: idJson(), role: { type: "string" }, level: { enum: [...ACCESS_LEVELS, null] } },
    ["userId", "role", "level"],
  );
}

/** `{ userId, role, level }`: a member, as `invite` and `setRole` return it. */
export function memberOutput(): KitSchema<Member> {
  return kitSchema<Member>(
    (value) => {
      const issues = memberIssues(value, []);
      return issues.length > 0 ? { issues } : { value: value as Member };
    },
    { input: memberJson },
  );
}

/** `{ items, nextCursor }`: one page of `listMembers`. */
export function membersPageOutput(): KitSchema<MembersPage> {
  return kitSchema<MembersPage>(
    (value) => {
      if (!isRecord(value) || !Array.isArray(value.items)) {
        return { issues: [{ message: "Expected a page of members", path: [] }] };
      }
      const issues = [
        ...unknownKeys(value, ["items", "nextCursor"]),
        ...value.items.flatMap((member: unknown, index) => memberIssues(member, ["items", index])),
      ];
      if (value.nextCursor !== null && typeof value.nextCursor !== "string") {
        issues.push({ message: "Expected a cursor or null", path: ["nextCursor"] });
      }
      return issues.length > 0 ? { issues } : { value: value as unknown as MembersPage };
    },
    {
      input: () =>
        objectJson(
          {
            items: { type: "array", items: memberJson() },
            nextCursor: { type: ["string", "null"] },
          },
          ["items", "nextCursor"],
        ),
    },
  );
}
