// The JSON access list a `jsonAcl` policy reads, as the sharing kit reads and
// rewrites it (RFC 0003 sections 4.2 and 12.3): `[{ userId, level }]`.
//
// - A column holding no list (`null`) is an empty list.
// - A list the policy cannot fully read is malformed: not an array, or an
//   entry that is not an object with a non-empty `userId` and a known
//   `level`. The kit refuses to change a malformed list (`CONFLICT`) rather
//   than overwrite what the app stored there; the policy grants nothing from
//   it meanwhile.
// - An entry may hold more keys than `userId` and `level` (an app's own
//   `addedAt`): the kit keeps them, and changes only the entries of the user
//   a call names.
// - Several entries for one user count as their highest level, as the policy
//   reads them; a change to that user leaves one entry.

import { isAccessLevel, type ACE, type AccessLevel } from "../../../contract/access";
import { maxLevel } from "../../access/levels";

/** One entry of a stored list, with whatever other keys the app keeps in it. */
export type StoredEntry = Readonly<Record<string, unknown>> & {
  readonly userId: string;
  readonly level: AccessLevel;
};

function isEntry(value: unknown): value is StoredEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const { userId, level } = value as Readonly<Record<string, unknown>>;
  return typeof userId === "string" && userId.length > 0 && isAccessLevel(level);
}

/** The list a column holds, or `undefined` when it is malformed. */
export function parseList(value: unknown): readonly StoredEntry[] | undefined {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) && value.every(isEntry) ? (value as StoredEntry[]) : undefined;
}

/** The level the list gives `userId`: the highest of their entries, or `null` without one. */
export function levelIn(entries: readonly StoredEntry[], userId: string): AccessLevel | null {
  return entries
    .filter((entry) => entry.userId === userId)
    .reduce<AccessLevel | null>((level, entry) => maxLevel(level, entry.level), null);
}

/** How many entries the list holds for `userId`. */
export function entriesOf(entries: readonly StoredEntry[], userId: string): number {
  return entries.filter((entry) => entry.userId === userId).length;
}

/**
 * The list as the kit reports it: one `{ userId, level }` per user, at the
 * level the list gives them, in the order each user first appears.
 */
export function sharesOf(entries: readonly StoredEntry[]): ACE[] {
  const levels = new Map<string, AccessLevel>();
  for (const entry of entries) {
    levels.set(entry.userId, maxLevel(levels.get(entry.userId), entry.level) ?? entry.level);
  }
  return [...levels].map(([userId, level]) => ({ userId, level }));
}

/**
 * The list with `userId` at `level`, or without them for `null`: their first
 * entry keeps its place and its other keys, their other entries go, and a
 * user without one gets a new entry at the end.
 */
export function withLevel(
  entries: readonly StoredEntry[],
  userId: string,
  level: AccessLevel | null,
): StoredEntry[] {
  const kept: StoredEntry[] = [];
  let placed = false;
  for (const entry of entries) {
    if (entry.userId !== userId) {
      kept.push(entry);
    } else if (!placed && level !== null) {
      kept.push({ ...entry, level });
      placed = true;
    }
  }
  if (!placed && level !== null) {
    kept.push({ userId, level });
  }
  return kept;
}

/** True when someone has `Admin` on the row: the owner, or a user the list gives it. */
export function hasAdmin(entries: readonly StoredEntry[], owner: string | undefined): boolean {
  return owner !== undefined || entries.some((entry) => entry.level === "Admin");
}
