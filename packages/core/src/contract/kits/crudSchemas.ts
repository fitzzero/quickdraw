// The inputs and outputs the read/write kit generates (RFC 0003 section
// 12.1), except `list`'s (`crudList.ts`): `{ id }`, `{ ids }` (at most 200),
// a patch with `id` added, `{ ids, data }`, a reorder's neighbors, `null`
// and `{ count }`. A part the app's own schema provides (a create input, an
// update patch) is validated by that schema, and its JSON Schema is the
// app's own when its library can write one.

import type { InferInput, InferOutput, StandardSchemaV1 } from "../standardSchema";
import {
  hasJson,
  idJson,
  invalid,
  isId,
  isRecord,
  jsonOf,
  kitSchema,
  nested,
  objectJson,
  unknownKeys,
  type JsonSchema,
  type KitSchema,
  type Validated,
} from "./schemas";

/** The most ids one `getMany`, `bulkUpdate` or `bulkDelete` call may name. */
export const CRUD_MAX_IDS = 200;

/** `{ id }`: one row. */
export interface IdInput {
  readonly id: string;
}

/** `{ ids }`: up to {@link CRUD_MAX_IDS} rows. */
export interface IdsInput {
  readonly ids: readonly string[];
}

/** What `bulkUpdate` and `bulkDelete` return: how many rows they changed. */
export interface BulkResult {
  readonly count: number;
}

/**
 * `reorder`'s input: the row to move, and the rows it lands between. `beforeId`
 * is the row that will come right before it, `afterId` the one right after;
 * one of them is enough.
 */
export interface ReorderInput {
  readonly id: string;
  readonly beforeId?: string;
  readonly afterId?: string;
}

function idsIssues(ids: unknown, path: readonly PropertyKey[]): StandardSchemaV1.Issue[] {
  if (!Array.isArray(ids)) {
    return [{ message: "Expected an array of row ids", path: [...path] }];
  }
  if (ids.length > CRUD_MAX_IDS) {
    return [{ message: `At most ${CRUD_MAX_IDS} ids`, path: [...path] }];
  }
  return ids.flatMap((id: unknown, index) =>
    isId(id) ? [] : [{ message: "Expected a non-empty string", path: [...path, index] }],
  );
}

function idsJson(): JsonSchema {
  return { type: "array", items: idJson(), maxItems: CRUD_MAX_IDS };
}

/** `{ id }`. */
export function idInput(): KitSchema<IdInput> {
  return kitSchema<IdInput>(
    (value) => {
      if (!isRecord(value)) {
        return invalid("Expected an object");
      }
      const issues = unknownKeys(value, ["id"]);
      if (!isId(value.id)) {
        issues.push({ message: "Expected a non-empty string", path: ["id"] });
      }
      return issues.length > 0 ? { issues } : { value: { id: value.id as string } };
    },
    { input: () => objectJson({ id: idJson() }, ["id"]) },
  );
}

/** `{ ids }`, at most {@link CRUD_MAX_IDS} of them. */
export function idsInput(): KitSchema<IdsInput, { readonly ids: string[] }> {
  return kitSchema<IdsInput, { readonly ids: string[] }>(
    (value) => {
      if (!isRecord(value)) {
        return invalid("Expected an object");
      }
      const issues = [...unknownKeys(value, ["ids"]), ...idsIssues(value.ids, ["ids"])];
      return issues.length > 0 ? { issues } : { value: { ids: [...(value.ids as string[])] } };
    },
    { input: () => objectJson({ ids: idsJson() }, ["ids"]) },
  );
}

/** The JSON Schema of `{ id, ...patch }`, from the patch's own object schema. */
function withIdJson(patch: StandardSchemaV1, side: "input" | "output", target: string): JsonSchema {
  const json = jsonOf(patch, side, target) ?? {};
  if (json.type !== "object") {
    throw new Error("the patch schema does not describe an object");
  }
  const properties = isRecord(json.properties) ? json.properties : {};
  const required = Array.isArray(json.required) ? (json.required as unknown[]) : [];
  return {
    ...json,
    properties: { id: idJson(), ...properties },
    required: ["id", ...required.filter((key) => key !== "id")],
  };
}

/** Validates `value` with the app's patch schema; its result must be an object. */
async function patchOf(
  patch: StandardSchemaV1,
  value: unknown,
  path: readonly PropertyKey[],
): Promise<Validated<Readonly<Record<string, unknown>>>> {
  const result = await patch["~standard"].validate(value);
  if (result.issues !== undefined) {
    return { issues: nested(result.issues, path) };
  }
  return isRecord(result.value)
    ? { value: result.value }
    : invalid("The patch schema must produce an object", path);
}

/** The schema of `{ id } & patch`: what `update` takes. */
export type WithId<Patch extends StandardSchemaV1> = StandardSchemaV1<
  { readonly id: string } & InferInput<Patch>,
  { readonly id: string } & InferOutput<Patch>
>;

/**
 * `{ id, ...patch }`: `id` is checked here and the other keys by the app's
 * patch schema. With JSON Schema when the patch schema can write it.
 */
export function withId<Patch extends StandardSchemaV1>(patch: Patch): WithId<Patch> {
  const validate = async (
    value: unknown,
  ): Promise<Validated<Readonly<Record<string, unknown>>>> => {
    if (!isRecord(value)) {
      return invalid("Expected an object");
    }
    const { id, ...rest } = value;
    const result = await patchOf(patch, rest, []);
    const issues = [
      ...(isId(id) ? [] : [{ message: "Expected a non-empty string", path: ["id"] }]),
      ...(result.issues ?? []),
    ];
    if (issues.length > 0 || result.issues !== undefined) {
      return { issues };
    }
    return { value: { ...result.value, id: id as string } };
  };
  if (!hasJson(patch)) {
    const props = { version: 1 as const, vendor: "quickdraw", validate };
    return Object.freeze({ "~standard": Object.freeze(props) }) as unknown as WithId<Patch>;
  }
  return kitSchema(validate, {
    input: (target) => withIdJson(patch, "input", target),
    output: (target) => withIdJson(patch, "output", target),
  }) as unknown as WithId<Patch>;
}

/** The schema of `{ ids, data }`: what `bulkUpdate` takes. */
export type BulkPatch<Patch extends StandardSchemaV1> = StandardSchemaV1<
  { readonly ids: readonly string[]; readonly data: InferInput<Patch> },
  { readonly ids: string[]; readonly data: InferOutput<Patch> }
>;

function bulkJson(patch: StandardSchemaV1, side: "input" | "output", target: string): JsonSchema {
  return objectJson({ ids: idsJson(), data: jsonOf(patch, side, target) ?? {} }, ["ids", "data"]);
}

/** `{ ids, data }`: up to {@link CRUD_MAX_IDS} ids, and one patch for all of them. */
export function bulkPatch<Patch extends StandardSchemaV1>(patch: Patch): BulkPatch<Patch> {
  const validate = async (
    value: unknown,
  ): Promise<Validated<Readonly<Record<string, unknown>>>> => {
    if (!isRecord(value)) {
      return invalid("Expected an object");
    }
    const data = await patchOf(patch, value.data, ["data"]);
    const issues = [
      ...unknownKeys(value, ["ids", "data"]),
      ...idsIssues(value.ids, ["ids"]),
      ...(data.issues ?? []),
    ];
    if (issues.length > 0 || data.issues !== undefined) {
      return { issues };
    }
    return { value: { ids: [...(value.ids as string[])], data: data.value } };
  };
  if (!hasJson(patch)) {
    const props = { version: 1 as const, vendor: "quickdraw", validate };
    return Object.freeze({ "~standard": Object.freeze(props) }) as unknown as BulkPatch<Patch>;
  }
  return kitSchema(validate, {
    input: (target) => bulkJson(patch, "input", target),
    output: (target) => bulkJson(patch, "output", target),
  }) as unknown as BulkPatch<Patch>;
}

function neighborIssues(value: Readonly<Record<string, unknown>>): StandardSchemaV1.Issue[] {
  const { id, beforeId, afterId } = value;
  const issues: StandardSchemaV1.Issue[] = [];
  for (const key of ["beforeId", "afterId"] as const) {
    const neighbor = value[key];
    if (neighbor !== undefined && !isId(neighbor)) {
      issues.push({ message: "Expected a non-empty string", path: [key] });
    } else if (neighbor !== undefined && neighbor === id) {
      issues.push({ message: "A row cannot move next to itself", path: [key] });
    }
  }
  if (beforeId === undefined && afterId === undefined) {
    issues.push({ message: "Give beforeId, afterId or both", path: [] });
  } else if (beforeId !== undefined && beforeId === afterId) {
    issues.push({ message: "beforeId and afterId must be different rows", path: ["afterId"] });
  }
  return issues;
}

/** `{ id, beforeId?, afterId? }`. */
export function reorderInput(): KitSchema<ReorderInput> {
  return kitSchema<ReorderInput>(
    (value) => {
      if (!isRecord(value)) {
        return invalid("Expected an object");
      }
      const issues = [...unknownKeys(value, ["id", "beforeId", "afterId"])];
      if (!isId(value.id)) {
        issues.push({ message: "Expected a non-empty string", path: ["id"] });
      }
      issues.push(...neighborIssues(value));
      if (issues.length > 0) {
        return { issues };
      }
      const { id, beforeId, afterId } = value as unknown as ReorderInput;
      return {
        value: {
          id,
          ...(beforeId === undefined ? {} : { beforeId }),
          ...(afterId === undefined ? {} : { afterId }),
        },
      };
    },
    {
      input: () => objectJson({ id: idJson(), beforeId: idJson(), afterId: idJson() }, ["id"]),
    },
  );
}

/** `null`: what `delete` returns. */
export function nullOutput(): KitSchema<null> {
  return kitSchema<null>((value) => (value === null ? { value } : invalid("Expected null")), {
    input: () => ({ type: "null" }),
  });
}

/** `{ count }`: what `bulkUpdate` and `bulkDelete` return. */
export function countOutput(): KitSchema<BulkResult> {
  return kitSchema<BulkResult>(
    (value) => {
      const count = isRecord(value) ? value.count : undefined;
      return Number.isInteger(count) && (count as number) >= 0
        ? { value: { count: count as number } }
        : invalid("Expected { count } with a count of rows");
    },
    { input: () => objectJson({ count: { type: "integer", minimum: 0 } }, ["count"]) },
  );
}
