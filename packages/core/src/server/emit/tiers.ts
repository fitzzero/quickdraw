// Field tiers (RFC 0003 section 6). A contract's `fields` map names the
// minimum level a reader needs to receive a field (`{ notes: "Admin" }`);
// every other field goes to anyone who may read the row. An entity frame is
// built once and stripped once per occupied tier: subscribers join the room
// of their own level, and levels that see the same fields share one stripped
// frame. A method's result is stripped per caller, after any shared run
// (section 9, step 6). 4.1 had two fixed tiers, "elevated" and everyone else
// (`legacy-src/server/BaseService.ts:630-692`), and decided which by
// overridable methods rather than by declared levels.

import type { AccessLevel } from "../../contract/access";
import { meetsLevel } from "../access/levels";
import type { RowLevel } from "../access/policy";

/** The lowest level that may subscribe to a row, as in 4.1 (`requiredLevel = "Read"`). */
export const SUBSCRIBE_LEVEL: AccessLevel = "Read";

/** The levels a subscriber can hold, lowest first: one entity room per level. */
export const SUBSCRIBER_LEVELS: readonly AccessLevel[] = Object.freeze([
  "Read",
  "Moderate",
  "Admin",
]);

/** Subscriber levels that receive the same fields, so one stripped frame serves them all. */
export interface TierGroup {
  readonly levels: readonly AccessLevel[];
  /** The projection's keys these levels do not receive. */
  readonly hidden: ReadonlySet<string>;
}

/** The contract's field tiers over one projection's keys. */
export interface Tiers {
  /** True when some key of the projection has a minimum level, so a reader's level matters. */
  readonly tiered: boolean;
  /** The keys a reader at `level` does not receive; `null` is no level, which meets no tier. */
  hidden(level: RowLevel): ReadonlySet<string>;
  /** The subscriber levels, grouped by the keys they do not receive. */
  readonly groups: readonly TierGroup[];
}

const NOTHING: ReadonlySet<string> = Object.freeze(new Set<string>());

function hiddenAt(
  fields: Readonly<Record<string, AccessLevel>>,
  keys: readonly string[],
  level: RowLevel,
): ReadonlySet<string> {
  const hidden = keys.filter((key) => {
    const required = Object.hasOwn(fields, key) ? fields[key] : undefined;
    return required !== undefined && !meetsLevel(level, required);
  });
  return hidden.length === 0 ? NOTHING : Object.freeze(new Set(hidden));
}

/** The tiers of `fields` over `keys`. */
export function tiersOf(
  fields: Readonly<Record<string, AccessLevel>>,
  keys: readonly string[],
): Tiers {
  const byLevel = new Map<RowLevel, ReadonlySet<string>>();
  const hidden = (level: RowLevel): ReadonlySet<string> => {
    let found = byLevel.get(level);
    if (found === undefined) {
      found = hiddenAt(fields, keys, level);
      byLevel.set(level, found);
    }
    return found;
  };
  const groups = new Map<string, { levels: AccessLevel[]; hidden: ReadonlySet<string> }>();
  for (const level of SUBSCRIBER_LEVELS) {
    const set = hidden(level);
    const signature = [...set].join("\u0000");
    const group = groups.get(signature);
    if (group === undefined) {
      groups.set(signature, { levels: [level], hidden: set });
    } else {
      group.levels.push(level);
    }
  }
  return Object.freeze({
    tiered: keys.some((key) => Object.hasOwn(fields, key)),
    hidden,
    groups: Object.freeze([...groups.values()].map((group) => Object.freeze(group))),
  });
}

/** `row` without the `hidden` keys: a copy when there are any, the row itself otherwise. */
export function strip<Row extends Readonly<Record<string, unknown>>>(
  row: Row,
  hidden: ReadonlySet<string>,
): Row {
  if (hidden.size === 0) {
    return row;
  }
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!hidden.has(key)) {
      kept[key] = value;
    }
  }
  return kept as Row;
}
