// Nested writes (RFC 0003 section 5.2): a `data` value that writes a related
// row, such as `{ labels: { create: [...] } }`, reaches Prisma's query hook
// only as the parent operation, so the related rows' writes are not tracked.
// They are found by shape and reported as a development warning; the lint
// rule `no-nested-write` catches them before they run.
//
// The check reads shapes, not the schema, so it also looks at each key's
// value: a relation operation takes rows (an object or a list), and `delete`
// and `disconnect` on a to-one relation take `true`. A JSON column's value
// such as `{ create: true, update: false, delete: false }` is therefore not a
// nested write; one whose keys hold objects still is.

/** The keys of a relation operation, in the order a warning names them. */
const NESTED_KEYS = [
  "create",
  "createMany",
  "connect",
  "connectOrCreate",
  "disconnect",
  "set",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
] as const;

/** Relation operations that also take `true` (a to-one relation); the rest take rows. */
const FLAG_KEYS: ReadonlySet<string> = new Set(["delete", "disconnect"]);

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRows(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

/**
 * `set` also sets a scalar (`{ title: { set: "x" } }`) or a scalar list; on a
 * relation it takes the rows to connect, which are objects.
 */
function isRelationSet(value: unknown): boolean {
  return Array.isArray(value) ? value.some(isPlainObject) : isPlainObject(value);
}

/**
 * Whether `value[key]` is a relation operation, judged by what the key
 * holds: rows (an object or a list) for every operation, `true` for
 * `delete` and `disconnect`, rows given as objects for `set`.
 */
function writesRelation(value: Readonly<Record<string, unknown>>, key: string): boolean {
  if (!Object.hasOwn(value, key)) {
    return false;
  }
  const operand = value[key];
  if (key === "set") {
    return isRelationSet(operand);
  }
  return isRows(operand) || (FLAG_KEYS.has(key) && operand === true);
}

function nestedKey(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  return NESTED_KEYS.find((key) => writesRelation(value, key));
}

/** One nested write found in a write's `data`. */
export interface NestedWrite {
  /** The relation field, for example `"labels"`. */
  readonly field: string;
  /** The nested operation, for example `"create"`. */
  readonly operation: string;
}

/** The nested writes in `data`, one per relation field that has one. */
export function findNestedWrites(data: unknown): NestedWrite[] {
  if (!isPlainObject(data)) {
    return [];
  }
  const found: NestedWrite[] = [];
  for (const [field, value] of Object.entries(data)) {
    const operation = nestedKey(value);
    if (operation !== undefined) {
      found.push({ field, operation });
    }
  }
  return found;
}
