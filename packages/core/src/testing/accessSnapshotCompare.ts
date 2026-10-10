// What an access snapshot holds (`accessSnapshot.ts`), and how a run's
// matrix is compared with the stored one: the cells whose outcome changed
// (each marked when it opens or closes access), the principals whose kind
// changed, and the rows, principals and cells only one side has. A row of a
// section is one method, entity subscribe or collection scope (with its row
// variant), and holds one outcome per principal.

import type { ErrorCode } from "../protocol/errors";

/** What one cell recorded: `"ok"`, or the error code the call or subscribe failed with. */
export type AccessOutcome = "ok" | ErrorCode;

/**
 * A principal as the snapshot records it: its `kind` (`null` for a principal
 * without one), or `null` for the anonymous caller.
 */
export type AccessSnapshotPrincipal = { readonly kind: string | null } | null;

/** One row of the matrix (a method, subscribe or scope, with its row variant): an outcome per principal. */
export type AccessSnapshotRow = Readonly<Record<string, AccessOutcome>>;

/** The contents of an access snapshot file. */
export interface AccessSnapshot {
  readonly version: 1;
  /** Every principal of the matrix, the anonymous caller included, by name. */
  readonly principals: Readonly<Record<string, AccessSnapshotPrincipal>>;
  /** Method calls: `<service>.<method>`, plus ` (<variant>)` for a row variant. */
  readonly methods: Readonly<Record<string, AccessSnapshotRow>>;
  /** Entity subscribes (`qd:sub`): `<service>`, plus ` (<variant>)`. */
  readonly subscriptions: Readonly<Record<string, AccessSnapshotRow>>;
  /** Collection scopes (`qd:col:sub`): `<service>.<collection>`, plus ` (<variant>)` (`(self)` for a `"self"` scope). */
  readonly collections: Readonly<Record<string, AccessSnapshotRow>>;
  /** The methods left out with `exclude`, as `<service>.<method>`. */
  readonly excluded: readonly string[];
}

/** The sections of a snapshot that hold cells. */
export const ACCESS_SECTIONS = ["methods", "subscriptions", "collections"] as const;

/** A section of a snapshot that holds cells. */
export type AccessSection = (typeof ACCESS_SECTIONS)[number];

/** How a section's rows are named in a message: a subscribe or scope by its frame. */
const SECTION_PREFIX: Readonly<Record<AccessSection, string>> = Object.freeze({
  methods: "",
  subscriptions: "qd:sub ",
  collections: "qd:col:sub ",
});

/** One cell that differs between the stored snapshot and the run. */
export interface AccessCellChange {
  readonly section: AccessSection;
  /** The row's key in its section: `taskService.get (own)`. */
  readonly row: string;
  readonly principal: string;
  /** What the snapshot holds; `undefined` for a cell it does not have. */
  readonly before: AccessOutcome | undefined;
  /** What the run recorded; `undefined` for a cell it no longer has. */
  readonly after: AccessOutcome | undefined;
}

/** A principal of both whose record differs: another kind, or anonymous on one side only. */
export interface AccessPrincipalChange {
  readonly name: string;
  readonly before: AccessSnapshotPrincipal;
  readonly after: AccessSnapshotPrincipal;
}

/** How a run's matrix differs from the stored snapshot. */
export interface AccessComparison {
  /** Cells both have whose outcome differs. */
  readonly changed: readonly AccessCellChange[];
  /** Principals both have whose record differs. */
  readonly principals: readonly AccessPrincipalChange[];
  /** Rows only the run has, as a message names them (`qd:sub taskService (own)`). */
  readonly rowsAdded: readonly string[];
  /** Rows only the snapshot has. */
  readonly rowsRemoved: readonly string[];
  readonly principalsAdded: readonly string[];
  readonly principalsRemoved: readonly string[];
  /** Cells of rows and principals both have that only one side holds (an edited file). */
  readonly cells: readonly AccessCellChange[];
  /** Methods newly excluded. */
  readonly excludedAdded: readonly string[];
  /** Methods no longer excluded. */
  readonly excludedRemoved: readonly string[];
}

/** The items of `items` that `other` lacks, sorted. */
function only(items: Iterable<string>, other: ReadonlySet<string>): string[] {
  return [...items].filter((item) => !other.has(item)).sort();
}

function samePrincipal(a: AccessSnapshotPrincipal, b: AccessSnapshotPrincipal): boolean {
  return a === null || b === null ? a === b : a.kind === b.kind;
}

function cellOf(row: AccessSnapshotRow, principal: string): AccessOutcome | undefined {
  return Object.hasOwn(row, principal) ? row[principal] : undefined;
}

/** The differing cells of one row both sides have, among the principals both have. */
function compareRow(
  section: AccessSection,
  row: string,
  sides: { readonly before: AccessSnapshotRow; readonly after: AccessSnapshotRow },
  principals: readonly string[],
): AccessCellChange[] {
  return principals.flatMap((principal) => {
    const before = cellOf(sides.before, principal);
    const after = cellOf(sides.after, principal);
    return before === after ? [] : [{ section, row, principal, before, after }];
  });
}

/** The principals both sides have whose record differs. */
function comparePrincipals(
  before: AccessSnapshot,
  after: AccessSnapshot,
  shared: readonly string[],
): AccessPrincipalChange[] {
  return shared.flatMap((name) => {
    const was = before.principals[name] ?? null;
    const is = after.principals[name] ?? null;
    return samePrincipal(was, is) ? [] : [{ name, before: was, after: is }];
  });
}

/** Compares a run's matrix (`after`) with the stored snapshot (`before`). */
export function compareAccessSnapshots(
  before: AccessSnapshot,
  after: AccessSnapshot,
): AccessComparison {
  const namesBefore = new Set(Object.keys(before.principals));
  const namesAfter = new Set(Object.keys(after.principals));
  const shared = [...namesAfter].filter((name) => namesBefore.has(name)).sort();
  const differing: AccessCellChange[] = [];
  const rowsAdded: string[] = [];
  const rowsRemoved: string[] = [];
  for (const section of ACCESS_SECTIONS) {
    const rowsBefore = new Set(Object.keys(before[section]));
    const rowsAfter = new Set(Object.keys(after[section]));
    const prefix = SECTION_PREFIX[section];
    rowsAdded.push(...only(rowsAfter, rowsBefore).map((row) => prefix + row));
    rowsRemoved.push(...only(rowsBefore, rowsAfter).map((row) => prefix + row));
    for (const row of [...rowsAfter].filter((key) => rowsBefore.has(key)).sort()) {
      const sides = { before: before[section][row] ?? {}, after: after[section][row] ?? {} };
      differing.push(...compareRow(section, row, sides, shared));
    }
  }
  const excludedBefore = new Set(before.excluded);
  const excludedAfter = new Set(after.excluded);
  const oneSided = (change: AccessCellChange): boolean =>
    change.before === undefined || change.after === undefined;
  return {
    changed: differing.filter((change) => !oneSided(change)),
    principals: comparePrincipals(before, after, shared),
    rowsAdded,
    rowsRemoved,
    principalsAdded: only(namesAfter, namesBefore),
    principalsRemoved: only(namesBefore, namesAfter),
    cells: differing.filter(oneSided),
    excludedAdded: only(excludedAfter, excludedBefore),
    excludedRemoved: only(excludedBefore, excludedAfter),
  };
}

/** True when a cell's outcome or a principal changed: what fails until the change is accepted. */
export function hasDifferences(comparison: AccessComparison): boolean {
  return comparison.changed.length > 0 || comparison.principals.length > 0;
}

/** True when the matrix has other rows, principals, cells or exclusions than the snapshot. */
export function isReshaped(comparison: AccessComparison): boolean {
  return [
    comparison.rowsAdded,
    comparison.rowsRemoved,
    comparison.principalsAdded,
    comparison.principalsRemoved,
    comparison.cells,
    comparison.excludedAdded,
    comparison.excludedRemoved,
  ].some((list) => list.length > 0);
}

/** An outcome that refuses the caller. */
function denies(outcome: AccessOutcome | undefined): boolean {
  return outcome === "UNAUTHENTICATED" || outcome === "FORBIDDEN";
}

/** An outcome that says access let the call through: anything but a refusal or an unusable input. */
function passes(outcome: AccessOutcome | undefined): boolean {
  return outcome !== undefined && outcome !== "VALIDATION" && !denies(outcome);
}

/** Whether a changed cell opens access (a refusal became a pass), closes it, or neither. */
export function accessFlip(change: AccessCellChange): "opens access" | "closes access" | undefined {
  if (denies(change.before) && passes(change.after)) {
    return "opens access";
  }
  if (passes(change.before) && denies(change.after)) {
    return "closes access";
  }
  return undefined;
}

/** A cell as a message names it: `taskService.get (own) as bo`, `qd:sub taskService as bo`. */
export function cellName(cell: Pick<AccessCellChange, "section" | "row" | "principal">): string {
  return `${SECTION_PREFIX[cell.section]}${cell.row} as ${cell.principal}`;
}

/** At most this many lines of one kind in a message. */
const MAX_LINES = 50;

function capped(lines: readonly string[]): string[] {
  if (lines.length <= MAX_LINES) {
    return [...lines];
  }
  return [...lines.slice(0, MAX_LINES), `  ... and ${lines.length - MAX_LINES} more`];
}

function shownPrincipal(principal: AccessSnapshotPrincipal): string {
  if (principal === null) {
    return "anonymous";
  }
  return principal.kind === null ? "no kind" : `kind ${principal.kind}`;
}

/** Where a changed cell goes in a message: those that open access first, then those that close it. */
function flipRank(change: AccessCellChange): number {
  const flip = accessFlip(change);
  if (flip === "opens access") {
    return 0;
  }
  return flip === "closes access" ? 1 : 2;
}

/** One line per changed principal and cell, the cells that open access first, then those that close it. */
export function describeDifferences(comparison: AccessComparison): string[] {
  const principals = comparison.principals.map(
    (change) =>
      `  principal ${change.name}: ${shownPrincipal(change.before)} → ${shownPrincipal(change.after)}`,
  );
  const cells = [...comparison.changed]
    .sort((a, b) => flipRank(a) - flipRank(b))
    .map((change) => {
      const flip = accessFlip(change);
      const line = `  ${cellName(change)}: ${String(change.before)} → ${String(change.after)}`;
      return flip === undefined ? line : `${line} (${flip})`;
    });
  return [...capped(principals), ...capped(cells)];
}

/** One line per row, principal, cell and exclusion only one side has. */
export function describeReshape(comparison: AccessComparison): string[] {
  const lines = (label: string, items: readonly string[]): string[] =>
    capped(items.map((item) => `  ${label}: ${item}`));
  const cells = comparison.cells.map(
    (cell) => `${cellName(cell)}: ${cell.before ?? "none"} → ${cell.after ?? "none"}`,
  );
  return [
    ...lines("added", comparison.rowsAdded),
    ...lines("removed", comparison.rowsRemoved),
    ...lines("added principal", comparison.principalsAdded),
    ...lines("removed principal", comparison.principalsRemoved),
    ...lines("now excluded", comparison.excludedAdded),
    ...lines("no longer excluded", comparison.excludedRemoved),
    ...lines("cell", cells),
  ];
}
