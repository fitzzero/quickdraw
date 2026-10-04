// `describeAccessMatrix` (RFC 0003 section 13): runs each case (a method and
// its input) as each principal, and anonymously, through a running test app,
// and compares every outcome with the expected allow/deny table. The calls go
// through the app's real dispatcher (in process, or over real sockets), so
// the matrix exercises the pipeline's authorization stage, not an engine in
// isolation.
//
//   await describeAccessMatrix(app, {
//     service: taskService,
//     principals: { owner, member, stranger },
//     cases: [
//       { method: "get", input: { id }, allow: ["owner", "member"] },
//       { method: "rename", input: { id, title: "x" }, allow: ["owner"] },
//     ],
//   });
//
// Every cell calls the method for real, so a mutation runs once per principal
// it allows: give inputs that can run again, or `input` as a function, called
// for each cell with the principal it runs as, which makes a fresh row (a
// task to delete, a name not yet taken) so no cell depends on the cells
// before it, whatever the order of the principals:
//
//   { method: "remove", input: async () => ({ id: await newTask() }), allow: ["owner"] }

import type { AnyContract } from "../contract/defineContract";
import type { InputOf, MethodName } from "../contract/infer";
import { QuickdrawError, type ErrorCode } from "../protocol/errors";
import type { PrincipalOfServices } from "../server/dispatcher";
import type { AnyService, Service } from "../server/service";
import type { Principal, QuickdrawTypes } from "../server/types";
import type { TestApp, TestConnection } from "./createTestApp";

/**
 * What one cell expects: `"allow"` (the call succeeds), `"deny"` (it fails
 * with `UNAUTHENTICATED` without a principal and `FORBIDDEN` with one), or
 * the exact error code.
 */
export type MatrixOutcome = "allow" | "deny" | ErrorCode;

/** The name the anonymous caller has in a matrix, unless `principals` names one as `null`. */
export const ANONYMOUS = "anonymous";

/** The cell an input factory makes the input of: who the call runs as. */
export interface MatrixCell<Name extends string = string, P = Principal> {
  /** The principal's name in the matrix (`"anonymous"` for the added anonymous caller). */
  readonly name: Name;
  /** The principal itself, or `null` for an anonymous caller. */
  readonly principal: P | null;
}

/** A case's input made per cell: a fresh row for a mutation that cannot run twice on one. */
export type MatrixInputFactory<Input, Name extends string = string, P = Principal> = (
  cell: MatrixCell<Name, P>,
) => Input | PromiseLike<Input>;

/** One row of the matrix: a method, its input, and who may call it. */
export type AccessMatrixCase<C extends AnyContract, Name extends string, P = Principal> = {
  readonly [M in MethodName<C>]: {
    readonly method: M;
    /**
     * The input, or a function making it for each cell (called just before
     * that cell's call), so a mutation that can run once per row (a delete,
     * a unique name) gets a row of its own in every cell.
     */
    readonly input: InputOf<C, M> | MatrixInputFactory<InputOf<C, M>, Name, P>;
    /** Names the case in the report; default the method name. */
    readonly label?: string;
    /** The principals the call succeeds for; it is denied for everyone else. */
    readonly allow?: readonly Name[];
    /** Outcomes per principal, over `allow`. */
    readonly expect?: Partial<Readonly<Record<Name, MatrixOutcome>>>;
  };
}[MethodName<C>];

/** Options of {@link describeAccessMatrix}. */
export interface AccessMatrixOptions<C extends AnyContract, P, Name extends string> {
  /** The service whose methods the cases call; the app must serve it. */
  readonly service: Service<QuickdrawTypes, C>;
  /** The callers, by name. An anonymous caller named `"anonymous"` is added unless one is `null`. */
  readonly principals: Readonly<Record<Name, P | null>>;
  readonly cases: readonly AccessMatrixCase<C, NoInfer<Name> | typeof ANONYMOUS, NoInfer<P>>[];
  /** Call in process (`"caller"`, the default) or over a real socket per principal. */
  readonly via?: "caller" | "socket";
}

/** One cell: a case run as one principal. */
export interface AccessMatrixCell {
  readonly case: string;
  readonly principal: string;
  readonly expected: MatrixOutcome;
  /** `"allow"` when the call succeeded, or its error code. */
  readonly actual: "allow" | ErrorCode;
  readonly pass: boolean;
}

/** What {@link describeAccessMatrix} found: every cell, in order. */
export interface AccessMatrixReport {
  readonly cells: readonly AccessMatrixCell[];
}

type MethodFunction = (input: unknown) => Promise<unknown>;
type ServiceFunctions = Readonly<Record<string, MethodFunction>>;

function matches(expected: MatrixOutcome, actual: string, anonymous: boolean): boolean {
  if (expected === "deny") {
    return actual === (anonymous ? "UNAUTHENTICATED" : "FORBIDDEN");
  }
  return expected === actual;
}

async function outcomeOf(call: () => Promise<unknown>): Promise<"allow" | ErrorCode> {
  try {
    await call();
    return "allow";
  } catch (error) {
    if (error instanceof QuickdrawError) {
      return error.code;
    }
    throw error;
  }
}

function report(serviceName: string, cells: readonly AccessMatrixCell[]): string {
  const failed = cells.filter((cell) => !cell.pass);
  const lines = failed.map(
    (cell) => `  ${cell.case} as ${cell.principal}: expected ${cell.expected}, got ${cell.actual}`,
  );
  return `describeAccessMatrix(${serviceName}): ${failed.length} of ${cells.length} cells differ\n${lines.join("\n")}`;
}

/** The callers of each principal: in process, or over one socket each (closed by `close`). */
function callers<S extends readonly AnyService[]>(
  app: TestApp<S>,
  serviceName: string,
  via: "caller" | "socket",
): { of(principal: PrincipalOfServices<S> | null): Promise<ServiceFunctions>; close(): void } {
  const connections = new Map<unknown, Promise<TestConnection<S>>>();
  const pick = (caller: unknown): ServiceFunctions =>
    (caller as Readonly<Record<string, ServiceFunctions>>)[serviceName] ?? {};
  return {
    async of(principal) {
      if (via === "caller") {
        return pick(app.as(principal));
      }
      let connection = connections.get(principal);
      if (connection === undefined) {
        connection = app.connect(principal);
        connections.set(principal, connection);
      }
      return pick((await connection).call);
    },
    close() {
      for (const connection of connections.values()) {
        connection.then(
          (open) => open.close(),
          () => undefined,
        );
      }
    },
  };
}

/**
 * Runs every case as every principal, and anonymously, through `app` (from
 * `createTestApp`), and compares each outcome with the case's `allow` or
 * `expect`. Resolves with every cell; rejects with an `Error` listing each
 * cell that differs.
 */
export async function describeAccessMatrix<
  S extends readonly AnyService[],
  C extends AnyContract,
  const Name extends string,
>(
  app: TestApp<S>,
  options: AccessMatrixOptions<C, PrincipalOfServices<S>, Name>,
): Promise<AccessMatrixReport> {
  const { service, cases } = options;
  if (app.server.dispatcher.registry.services.get(service.name) !== service) {
    throw new TypeError(`describeAccessMatrix: the app does not serve ${service.name}`);
  }
  const principals: [string, PrincipalOfServices<S> | null][] = Object.entries(options.principals);
  if (!principals.some(([, principal]) => principal === null)) {
    principals.push([ANONYMOUS, null]);
  }
  const via = callers(app, service.name, options.via ?? "caller");
  const cells: AccessMatrixCell[] = [];
  try {
    for (const entry of cases) {
      const expectations: Partial<Record<string, MatrixOutcome>> = entry.expect ?? {};
      for (const [name, principal] of principals) {
        const allowed = (entry.allow as readonly string[] | undefined)?.includes(name) === true;
        const expected = expectations[name] ?? (allowed ? "allow" : "deny");
        const method = (await via.of(principal))[entry.method];
        if (method === undefined) {
          throw new TypeError(`describeAccessMatrix: ${service.name} has no ${entry.method}`);
        }
        const { input } = entry as { readonly input: unknown };
        const made =
          typeof input === "function"
            ? await (input as MatrixInputFactory<unknown>)({ name, principal })
            : input;
        const actual = await outcomeOf(() => method(made));
        const pass = matches(expected, actual, principal === null);
        cells.push({ case: entry.label ?? entry.method, principal: name, expected, actual, pass });
      }
    }
  } finally {
    via.close();
  }
  if (cells.some((cell) => !cell.pass)) {
    throw new Error(report(service.name, cells));
  }
  return { cells };
}
