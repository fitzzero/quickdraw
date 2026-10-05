// Which scopes a flush moved each row out of, into, or changed it in (RFC
// 0003 section 7.2). Membership is declared, so it is read from the values a
// write reports for the registered membership columns (`bind.ts`): a scope
// before the write and a scope after it. The rules, ported from 4.1's
// `notifyOne` (4.1 `src/server/collections.ts:220-270`), which compared
// `resolveScopeId` before and after on full rows it read first:
//
// | Write                          | Before                    | After          |
// |--------------------------------|---------------------------|----------------|
// | create                         | none                      | its values     |
// | create of a row the same unit  | the deleted row's values  | its values     |
// | deleted first (`before`)       | (`before`)                |                |
// | update                         | its old values (`before`, | its values     |
// |                                | over the new ones)        |                |
// | delete                         | its old values            | none           |
// | touch (`ctx.touch`)            | unknown: none             | read           |
// | touch merged with a tracked    | the tracked write's old   | its values, or |
// | write that carried `before`    | values (`before`)         | read           |
// | an `affects` hop               | the same as after         | read           |
// | `via` junction create / delete | the entry's links without | its links now  |
// |                                | this flush's, with the    | (read)         |
// |                                | ones it removed           |                |
// | `via` entry created or touched | the same (its links       | its links now  |
// |                                | before this flush)        | (read)         |
//
// Left gives `removed`, entered `added` with the full item (never a patch: a
// client cannot patch a row it never had), stayed `patched` or `updated` as
// entity frames decide (`emit/frames.ts`); a row created again in the same
// scope is `updated`, whole. A touched row's old scope is unknown, so it is
// `added` to its scope now and its old scope is not told (a touch carries no
// `before`), unless a tracked write merged with it says where it was: then
// it moves, or stays `updated`, whole. A deleted row whose old scope the
// write does not carry (a touch with `removed`, or a `via` entry whose links
// a cascade removed) left scopes nobody can name: every scope of the
// collection subscribed on this process gets `removed`.
//
// A `via` entry's scopes before the flush are known whatever wrote the
// entry: its links now, without the ones this flush's junction writes made,
// with the ones they removed. So an entry created or touched (an `upsert`
// that may have updated it is recorded as a create) is `added`, whole, to
// every scope it is in now (a client upserts it where it already was, which
// also covers links an untracked write made), and `removed` from the scopes
// this flush's junction writes took it out of: a touch beside the removal of
// a member's link no longer leaves the chat in that member's list.
//
// A `via` collection whose item reads the junction (`via`'s `refreshEntry`,
// a member count) also sends every entry a junction write named again,
// whole, to the scopes it stayed in: the count changed there too.
//
// Behind a cluster adapter (`current`) a write that committed first can
// flush last (`deltas.ts`), so membership comes from what is read at flush
// time: a column-scoped row's deltas are decided by its row read for the
// frame (`deltas.ts`), and a `via` entry's links are read here anyway, so a
// deleted entry linked to scopes again at that read (its id created again
// by a write whose flush went first) stays in them, whole.

import { frameKind, type FrameKind } from "../emit/frames";
import { modelKey, type StorageAdapter, type StorageRow } from "../storage";
import { ANY_FIELD, type WriteRecord } from "../uow/types";
import type { BoundCollection } from "./bind";
import type { CollectionScope } from "./define";
import { indexColumns } from "./index";
import { matchesWhere, membershipColumns, scopeIn, selectWith } from "./items";

type Values = Readonly<Record<string, unknown>>;

type Via = Extract<CollectionScope, { readonly kind: "via" }>;

/** What one flush did to one row of one collection. */
export interface Move {
  readonly id: string;
  /** Scopes it left: `removed`. */
  readonly left: readonly string[];
  /** Scopes it entered: `added`, with the full item. */
  readonly entered: readonly string[];
  /** Scopes it stayed in and changed in: `patched` or `updated`. */
  readonly stayed: readonly string[];
  /** How it goes out to the scopes it stayed in. */
  readonly kind: FrameKind;
  /** It left scopes the flush cannot name: every scope subscribed here gets `removed`. */
  readonly unknownLeft: boolean;
}

/** The moves of one flush in one collection, and the rows read to find them. */
export interface Moves {
  readonly moves: readonly Move[];
  /** Rows read with the item's select, by id; deltas take their items from them. */
  readonly rows: ReadonlyMap<string, StorageRow>;
  /** Junction rows were removed without values: every scope subscribed here gets `reset`. */
  readonly resetAll: boolean;
}

const WHOLE: FrameKind = Object.freeze({ t: "u" });

const NONE: ReadonlySet<string> = Object.freeze(new Set<string>());

function moveOf(
  id: string,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  kind: FrameKind | undefined,
  unknownLeft = false,
): Move {
  return {
    id,
    left: [...before].filter((scope) => !after.has(scope)),
    entered: [...after].filter((scope) => !before.has(scope)),
    stayed: kind === undefined ? [] : [...after].filter((scope) => before.has(scope)),
    kind: kind ?? WHOLE,
    unknownLeft,
  };
}

/**
 * The move of a row the write took out of `before` (and put in `after`), as
 * the scopes it is in at the flush's read (`now`) decide it: it leaves every
 * scope the write named that it is not in now, and goes out whole to the
 * ones it is in now.
 */
function movedTo(
  id: string,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  now: ReadonlySet<string>,
  unknownLeft: boolean,
): Move {
  const named = new Set([...before, ...after]);
  return {
    id,
    left: [...named].filter((scope) => !now.has(scope)),
    entered: [...now].filter((scope) => !before.has(scope)),
    stayed: [...now].filter((scope) => before.has(scope)),
    kind: WHOLE,
    unknownLeft,
  };
}

function isEmpty(move: Move): boolean {
  return (
    move.left.length === 0 &&
    move.entered.length === 0 &&
    move.stayed.length === 0 &&
    !move.unknownLeft
  );
}

function setOf(scope: string | null | undefined): ReadonlySet<string> {
  return typeof scope === "string" ? new Set([scope]) : NONE;
}

/**
 * Reads rows of the collection's model with the item's select, the
 * membership columns, and the version column an indexed collection's index
 * rows take their `rev` from.
 */
async function readRows(
  storage: StorageAdapter,
  collection: BoundCollection,
  ids: readonly string[],
): Promise<Map<string, StorageRow>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await storage.findMany(collection.model, {
    where: { id: { in: [...ids] } },
    select: selectWith(collection.item.select, [
      ...membershipColumns(collection),
      ...indexColumns(collection),
    ]),
  });
  return new Map(rows.flatMap((row) => (typeof row.id === "string" ? [[row.id, row]] : [])));
}

/** A column-scoped row's move, or `undefined` while its write lacks the values that decide it and no row was read. */
function columnMove(
  collection: BoundCollection,
  write: WriteRecord,
  current: StorageRow | undefined,
): Move | undefined {
  if (write.op === "delete") {
    const before = scopeIn(collection, write.before);
    return moveOf(write.id, setOf(before), NONE, undefined, before === undefined);
  }
  const values =
    scopeIn(collection, write.after) === undefined ? current : (write.after ?? current);
  const after = scopeIn(collection, values);
  if (after === undefined) {
    return undefined;
  }
  const whole = write.op === "create" || write.fields.includes(ANY_FIELD);
  if (whole && write.before !== undefined) {
    // Its old scope is known after all: deleted and created again in one unit,
    // or a tracked move merged with a touch. It moved from there, and goes out whole.
    const before = scopeIn(collection, { ...values, ...write.before });
    return moveOf(write.id, setOf(before), setOf(after), WHOLE);
  }
  if (whole) {
    return moveOf(write.id, NONE, setOf(after), undefined);
  }
  const before = scopeIn(collection, { ...values, ...write.before });
  const kind = frameKind(collection.item, write, collection.service.versionColumn);
  return moveOf(write.id, setOf(before), setOf(after), kind);
}

/** The moves of a column-scoped collection: `refresh` holds rows only an `affects` hop touched. */
export async function columnMoves(
  storage: StorageAdapter,
  collection: BoundCollection,
  writes: readonly WriteRecord[],
  refresh: readonly string[],
): Promise<Moves> {
  const own = writes.filter((write) => modelKey(write.model) === collection.model);
  const known = own.map((write) => columnMove(collection, write, undefined));
  const unresolved = own.filter((_, index) => known[index] === undefined).map(({ id }) => id);
  const rows = await readRows(storage, collection, [...unresolved, ...refresh]);
  const moves: Move[] = [];
  for (const [index, write] of own.entries()) {
    // A row read as missing was deleted since: its own flush removes it.
    const move = known[index] ?? columnMove(collection, write, rows.get(write.id));
    if (move !== undefined) {
      moves.push(move);
    }
  }
  for (const id of refresh) {
    const scope = setOf(scopeIn(collection, rows.get(id)));
    moves.push(moveOf(id, scope, scope, WHOLE));
  }
  return { moves: moves.filter((move) => !isEmpty(move)), rows, resetAll: false };
}

/** The links a junction write made and removed, by entry. */
interface LinkEvents {
  readonly linked: Map<string, Set<string>>;
  readonly unlinked: Map<string, Set<string>>;
  /** Every entry a junction write named, whatever it changed: `refreshEntry` sends them again. */
  readonly named: Set<string>;
  /** Junction rows whose link the write does not carry: read them. */
  readonly unknown: string[];
  /** A junction row was removed without values. */
  resetAll: boolean;
}

function linkOf(via: Via, values: Values | undefined): readonly [string, string] | undefined {
  const entry = values?.[via.entry];
  const scope = values?.[via.scope];
  const valid = typeof entry === "string" && entry !== "" && typeof scope === "string";
  return valid && scope !== "" ? [entry, scope] : undefined;
}

function addLink(
  links: Map<string, Set<string>>,
  link: readonly [string, string] | undefined,
): void {
  if (link !== undefined) {
    links.set(link[0], new Set([...(links.get(link[0]) ?? []), link[1]]));
  }
}

function linkEvents(via: Via, writes: readonly WriteRecord[]): LinkEvents {
  const events: LinkEvents = {
    linked: new Map(),
    unlinked: new Map(),
    named: new Set(),
    unknown: [],
    resetAll: false,
  };
  const name = (link: readonly [string, string] | undefined): void => {
    if (link !== undefined) {
      events.named.add(link[0]);
    }
  };
  for (const write of writes) {
    if (write.op === "delete") {
      const link = linkOf(via, write.before);
      addLink(events.unlinked, link);
      name(link);
      events.resetAll ||= link === undefined;
      continue;
    }
    const now = linkOf(via, write.after);
    if (now === undefined || write.fields.includes(ANY_FIELD)) {
      events.unknown.push(write.id);
      continue;
    }
    name(now);
    const moved = write.fields.some((field) => field === via.entry || field === via.scope);
    if (write.op === "create" || moved) {
      addLink(events.linked, now);
    }
    if (write.op === "update" && moved) {
      const old = linkOf(via, { ...write.after, ...write.before });
      addLink(events.unlinked, old);
      name(old);
    }
  }
  return events;
}

/** The current links of `ids` (rows of the junction), by entry. */
async function readLinks(
  storage: StorageAdapter,
  via: Via,
  where: Readonly<Record<string, unknown>>,
): Promise<Map<string, Set<string>>> {
  const rows = await storage.findMany(modelKey(via.model), {
    where,
    select: { [via.entry]: true, [via.scope]: true },
  });
  const links = new Map<string, Set<string>>();
  for (const row of rows) {
    addLink(links, linkOf(via, row));
  }
  return links;
}

interface ViaRow {
  readonly id: string;
  readonly write: WriteRecord | undefined;
  readonly links: ReadonlySet<string>;
  readonly row: StorageRow | undefined;
  readonly refreshed: boolean;
}

/** True when the collection declares a `where`: membership then needs the entry's values too. */
function filtered(collection: BoundCollection): boolean {
  return Object.keys(collection.where).length > 0;
}

/**
 * A `via` entry's move: its links before the flush against its links now,
 * both filtered by `where`. A deleted entry left scopes nobody can name;
 * with `current` (behind a cluster adapter), the scopes it is linked to at
 * the read keep it. An entry created or touched is `added` to every scope it
 * is in now and `removed` from the ones it left.
 */
function viaMove(
  collection: BoundCollection,
  events: LinkEvents,
  entry: ViaRow,
  current: boolean,
): Move {
  const { id, write, links, row } = entry;
  const unlinked = events.unlinked.get(id) ?? NONE;
  const matches = (values: Values | undefined): boolean =>
    !filtered(collection) || (values !== undefined && matchesWhere(collection, values));
  const after = matches(row) ? links : NONE;
  if (write?.op === "delete") {
    return current
      ? movedTo(id, unlinked, NONE, after, true)
      : moveOf(id, unlinked, NONE, undefined, true);
  }
  const linked = events.linked.get(id) ?? NONE;
  const linksBefore = new Set([...[...links].filter((scope) => !linked.has(scope)), ...unlinked]);
  const before = matches(row === undefined ? undefined : { ...row, ...write?.before })
    ? linksBefore
    : NONE;
  if (write?.op === "create" || write?.fields.includes(ANY_FIELD) === true) {
    // Whole wherever it is now (an upsert where a client held it), gone where it left.
    return {
      id,
      left: [...before].filter((scope) => !after.has(scope)),
      entered: [...after],
      stayed: [],
      kind: WHOLE,
      unknownLeft: false,
    };
  }
  const changed = write !== undefined || entry.refreshed;
  // A refreshed entry's item changed beyond its own write (a count over the junction): whole.
  const kind =
    write === undefined || entry.refreshed
      ? WHOLE
      : frameKind(collection.item, write, collection.service.versionColumn);
  return moveOf(id, before, after, changed ? kind : undefined);
}

/**
 * One flush's moves per collection. The collection sink and the topic sink
 * (`../topics.ts`) both need them, and the rows a flush's moves read are read
 * once: the moves are kept by the flush's batch of writes, which every sink
 * of a flush receives as the same array, until it is garbage.
 */
export type FlushMoves = WeakMap<readonly WriteRecord[], Map<BoundCollection, Promise<Moves>>>;

/**
 * The moves of `collection` in the flush of `writes`, found on the first
 * call for that flush and shared by every later one. `refresh` holds the
 * collection's rows only an `affects` hop touched; `current` is true behind
 * a cluster adapter.
 */
export function movesOf(
  memo: FlushMoves,
  storage: StorageAdapter,
  collection: BoundCollection,
  writes: readonly WriteRecord[],
  refresh: readonly string[],
  current = false,
): Promise<Moves> {
  let flush = memo.get(writes);
  if (flush === undefined) {
    flush = new Map();
    memo.set(writes, flush);
  }
  let moves = flush.get(collection);
  if (moves === undefined) {
    moves =
      collection.scope.kind === "column"
        ? columnMoves(storage, collection, writes, refresh)
        : viaMoves(storage, collection, writes, refresh, current);
    flush.set(collection, moves);
  }
  return moves;
}

/**
 * The moves of a `via` collection: from its entry rows' writes, its
 * junction's writes and `affects` hops. With `current`, a deleted entry
 * linked to scopes at the read stays in them. With `refreshEntry`, every
 * entry a junction write named is sent again to the scopes it stayed in.
 */
export async function viaMoves(
  storage: StorageAdapter,
  collection: BoundCollection,
  writes: readonly WriteRecord[],
  refresh: readonly string[],
  current = false,
): Promise<Moves> {
  const via = collection.scope as Via;
  const entries = new Map(
    writes.filter((write) => modelKey(write.model) === collection.model).map((w) => [w.id, w]),
  );
  const events = linkEvents(
    via,
    writes.filter((write) => modelKey(write.model) === modelKey(via.model)),
  );
  if (events.unknown.length > 0) {
    for (const [entry, scopes] of await readLinks(storage, via, { id: { in: events.unknown } })) {
      events.named.add(entry);
      for (const scope of scopes) {
        addLink(events.linked, [entry, scope]);
      }
    }
  }
  const refreshed = new Set([...refresh, ...(via.refreshEntry ? events.named : [])]);
  const ids = [
    ...new Set([
      ...entries.keys(),
      ...events.linked.keys(),
      ...events.unlinked.keys(),
      ...refreshed,
    ]),
  ];
  if (ids.length === 0) {
    return { moves: [], rows: new Map(), resetAll: events.resetAll };
  }
  // Without a `where`, links alone decide membership: items are read later, for subscribed scopes only.
  const [links, rows] = await Promise.all([
    readLinks(storage, via, { [via.entry]: { in: ids } }),
    filtered(collection) ? readRows(storage, collection, ids) : new Map<string, StorageRow>(),
  ]);
  const moves = ids.map((id) =>
    viaMove(
      collection,
      events,
      {
        id,
        write: entries.get(id),
        links: links.get(id) ?? NONE,
        row: rows.get(id),
        refreshed: refreshed.has(id),
      },
      current,
    ),
  );
  return { moves: moves.filter((move) => !isEmpty(move)), rows, resetAll: events.resetAll };
}
