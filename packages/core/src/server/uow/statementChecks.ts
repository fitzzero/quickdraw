// The development checks of a method call's statements (`../devWarnings.ts`):
// N+1 statements and unbounded reads. The tracked database client tells the
// write tracker about each statement before it runs (`trackPrisma`'s hook),
// and the tracker hands it to the checks of the innermost method call it
// runs in. A statement outside a method call (a `qd.run` job, a flush, a
// subscription) is not checked, and neither is one the framework runs
// `quietly`.

import { N_PLUS_ONE_STATEMENTS, type DevWarning } from "../devWarnings";

/** One statement the tracked database client is about to run. */
export interface Statement {
  /** The model, named as the client names it: `"task"`. */
  readonly model: string;
  /** The client operation: `"findMany"`. */
  readonly operation: string;
  readonly args: Readonly<Record<string, unknown>> | undefined;
}

/** The method call a unit of work runs. */
export interface CallSite {
  readonly service: string;
  readonly method: string;
}

/** Checks one statement of a call; `batched` when it runs inside an array-form `$transaction`. */
export type StatementCheck = (statement: Statement, batched: boolean) => void;

/** Raises a warning about the call the checks belong to. */
export type RaiseWarning = (warning: Omit<DevWarning, "service" | "method">) => void;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The keys a statement filters by, sorted: its shape besides the model and operation. */
function whereKeys(statement: Statement): string[] {
  const where = statement.args?.where;
  return isRecord(where) ? Object.keys(where).sort() : [];
}

/**
 * A `findMany` that can return every row of its table: no `take`, and no
 * filter on `id` (a read by id is bounded by the ids it names). The same
 * test as the lint rule `no-unbounded-read`, made on the arguments the
 * statement actually ran with.
 */
export function isUnboundedRead(statement: Statement): boolean {
  if (statement.operation !== "findMany") {
    return false;
  }
  const { take, where } = statement.args ?? {};
  if (take !== undefined && take !== null) {
    return false;
  }
  return !(isRecord(where) && where.id !== undefined);
}

function nPlusOne(
  statement: Statement,
  keys: readonly string[],
): Omit<DevWarning, "service" | "method"> {
  const label = `${statement.model}.${statement.operation}${keys.length === 0 ? "" : ` by ${keys.join(", ")}`}`;
  return {
    kind: "n-plus-one",
    message:
      `${label} ran ${N_PLUS_ONE_STATEMENTS} times in one call, once per item (N+1); ` +
      "read the rows in one query (findMany({ where: { id: { in: ids } } })), or write them together " +
      "(createMany, updateMany, db.$transaction([...]))",
    meta: { model: statement.model, operation: statement.operation, where: keys },
  };
}

function unboundedRead(statement: Statement): Omit<DevWarning, "service" | "method"> {
  return {
    kind: "unbounded-read",
    message:
      `${statement.model}.findMany() without take reads every matching row, however many there are; ` +
      "add take (with a cursor to page), or serve the list as a collection or the read/write kit's list",
    meta: { model: statement.model },
  };
}

/**
 * The checks of one method call: warns once its statements of one shape
 * (model, operation and `where` keys) reach {@link N_PLUS_ONE_STATEMENTS}, and
 * at an unbounded read. Statements batched in an array-form `$transaction`
 * are sent together, which is the fix for an N+1, so they are not counted.
 */
export function createStatementChecks(raise: RaiseWarning): StatementCheck {
  const shapes = new Map<string, number>();
  return (statement, batched) => {
    if (isUnboundedRead(statement)) {
      raise(unboundedRead(statement));
    }
    if (batched) {
      return;
    }
    const keys = whereKeys(statement);
    const shape = `${statement.model}.${statement.operation}(${keys.join(",")})`;
    const seen = (shapes.get(shape) ?? 0) + 1;
    shapes.set(shape, seen);
    if (seen === N_PLUS_ONE_STATEMENTS) {
      raise(nPlusOne(statement, keys));
    }
  };
}
