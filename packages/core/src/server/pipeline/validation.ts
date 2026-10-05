// Input and output validation (RFC 0003 section 9, steps 3 and 8). Input
// failures reach the caller as `VALIDATION` with `data.issues` in the wire
// shape `{ path, message }[]`. 4.1 sent Zod's message as a code-400 string
// (`legacy-src/server/ServiceRegistry.ts:296-305`), and only when the method
// had a schema at all.

import type { AnyContract } from "../../contract/defineContract";
import type { MethodOutput } from "../../contract/methods";
import {
  isStandardSchema,
  validate,
  type StandardSchemaV1,
  type ValidationIssue,
} from "../../contract/standardSchema";
import { QuickdrawError, type WireIssue } from "../../protocol/errors";
import type { SchemaOutput } from "../service";
import { compileSchemaOutput } from "./schemaOutput";

type PathSegment = NonNullable<ValidationIssue["path"]>[number];

function wireKey(key: PropertyKey): string | number {
  if (typeof key === "symbol") {
    return key.description ?? key.toString();
  }
  return key;
}

function wireSegment(segment: PathSegment): string | number {
  return typeof segment === "object" ? wireKey(segment.key) : wireKey(segment);
}

/**
 * Standard Schema issues in the wire shape of RFC 0003 section 3: each path
 * as object keys and array indexes (a `{ key }` segment becomes its key, a
 * symbol its description), and the message unchanged.
 */
export function toWireIssues(issues: readonly ValidationIssue[]): WireIssue[] {
  return issues.map((issue) => ({
    path: (issue.path ?? []).map(wireSegment),
    message: issue.message,
  }));
}

/** Validates a call's input. Resolves with the parsed input, or rejects with `VALIDATION`. */
export async function parseInput(
  schema: StandardSchemaV1,
  input: unknown,
  label: string,
): Promise<unknown> {
  const result = await validate(schema, input);
  if (result.issues !== undefined) {
    throw new QuickdrawError("VALIDATION", `Invalid input for ${label}`, {
      issues: toWireIssues(result.issues),
    });
  }
  return result.value;
}

function derivedSchema(validateValue: StandardSchemaV1.Props["validate"]): StandardSchemaV1 {
  return Object.freeze({
    "~standard": Object.freeze({ version: 1, vendor: "quickdraw", validate: validateValue }),
  });
}

function nullableOf(inner: StandardSchemaV1): StandardSchemaV1 {
  return derivedSchema((value) =>
    value === null ? { value } : inner["~standard"].validate(value),
  );
}

function listOfSchema(inner: StandardSchemaV1): StandardSchemaV1 {
  return derivedSchema(async (value) => {
    if (!Array.isArray(value)) {
      return { issues: [{ message: "Expected an array", path: [] }] };
    }
    const results = await Promise.all(value.map((item: unknown) => validate(inner, item)));
    const issues = results.flatMap((result, index) =>
      (result.issues ?? []).map((issue) => ({
        message: issue.message,
        path: [index, ...(issue.path ?? [])],
      })),
    );
    return issues.length > 0 ? { issues } : { value };
  });
}

function projectionSchema(contract: AnyContract, projection: string): StandardSchemaV1 {
  const found = projection === "entity" ? contract.entity : contract.projections[projection];
  if (found === undefined) {
    throw new TypeError(
      `defineService("${contract.name}"): output names unknown projection "${projection}"`,
    );
  }
  return found;
}

/**
 * The schema a method's result is checked against: its `output` schema, or
 * the entity or projection schema it names, wrapped for `nullable(...)` and
 * `listOf(...)` (RFC 0003 section 17).
 */
export function outputSchemaOf(contract: AnyContract, output: MethodOutput): StandardSchemaV1 {
  if (isStandardSchema(output)) {
    return output;
  }
  if (typeof output === "string") {
    return projectionSchema(contract, output);
  }
  const row = projectionSchema(contract, output.projection);
  return output.kind === "nullable" ? nullableOf(row) : listOfSchema(row);
}

/**
 * A method output that is a schema of its own, compiled to reduce results to
 * what it declares (`schemaOutput.ts`); `undefined` for a projection output
 * or a schema without JSON Schema.
 */
export function schemaOutputOf(output: MethodOutput): SchemaOutput | undefined {
  return isStandardSchema(output) ? compileSchemaOutput(output) : undefined;
}

/** The problems with a handler's result, or `undefined` when it matches the method's output. */
export async function outputIssues(
  output: StandardSchemaV1,
  value: unknown,
): Promise<WireIssue[] | undefined> {
  const result = await validate(output, value);
  return result.issues === undefined ? undefined : toWireIssues(result.issues);
}
