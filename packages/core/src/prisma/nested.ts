// Nested writes (RFC 0003 section 5.2): a `data` value that writes a related
// row, such as `{ labels: { create: [...] } }`, reaches Prisma's query hook
// only as the parent operation, so the related rows' writes are not tracked.
// They are found by shape and reported as a development warning; the lint
// rule `no-nested-write` catches them before they run.
//
// The check reads shapes, not the schema, so a JSON column whose value has
// one of these keys also warns.

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

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `set` also sets a scalar (`{ title: { set: "x" } }`) or a scalar list; on a
 * relation it takes the rows to connect, which are objects.
 */
function isRelationSet(value: unknown): boolean {
  return Array.isArray(value) ? value.some(isPlainObject) : isPlainObject(value);
}

function nestedKey(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  return NESTED_KEYS.find(
    (key) => Object.hasOwn(value, key) && (key !== "set" || isRelationSet(value[key])),
  );
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
