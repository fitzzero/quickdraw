// How `expectBudget` compares a measured step with its stored budget
// (`budget.ts`): statements must match exactly, bytes may move by up to
// `BUDGET_BYTES_TOLERANCE` either way, and a step whose calls changed (other
// methods, outcomes, or how many) is a change of its own that counts as
// growth. A budget only moves down by itself: a number within the tolerance
// keeps its stored value, so small byte drifts never rewrite the file.

/** One call of a budgeted step. */
export interface BudgetCall {
  /** `"taskService.list"`. */
  readonly call: string;
  /** The statements its handler ran, from its completion record; 0 for a call that joined a shared run. */
  readonly statements: number;
  /** Its reply's size as its transport measured it (`app.as(...)`: the reply as JSON). */
  readonly bytes: number;
  /** How it failed; absent when it succeeded. */
  readonly outcome?: string;
}

/** What one step cost: an entry of a budget file. */
export interface Budget {
  /** Every statement the apps' tracked clients ran during the step. */
  readonly statements: number;
  /** Every byte the apps' servers wrote to sockets during the step, plus the in-process replies. */
  readonly bytes: number;
  /** The step's calls, sorted by method. */
  readonly calls: readonly BudgetCall[];
}

/** How far bytes may move, up or down, before it counts as a change: 5%. */
export const BUDGET_BYTES_TOLERANCE = 0.05;

type Direction = "grew" | "fell" | "same";

/** One number of a budget, before and now. */
interface NumberChange {
  readonly label: string;
  readonly was: number;
  readonly now: number;
  readonly direction: Direction;
  readonly bytes: boolean;
}

/** A measured step against its budget. */
export interface Comparison {
  /** A number grew past the budget, or the step's calls changed. */
  readonly grew: boolean;
  /** A number fell below the budget. */
  readonly fell: boolean;
  /** The step's calls are other than the budget's: other methods, outcomes, or how many. */
  readonly callsChanged: boolean;
  readonly changes: readonly NumberChange[];
  readonly was: Budget;
  readonly now: Budget;
}

function directionOf(was: number, now: number, bytes: boolean): Direction {
  const tolerance = bytes ? BUDGET_BYTES_TOLERANCE : 0;
  if (now > was * (1 + tolerance)) {
    return "grew";
  }
  return now < was * (1 - tolerance) ? "fell" : "same";
}

function change(label: string, was: number, now: number, bytes: boolean): NumberChange {
  return { label, was, now, direction: directionOf(was, now, bytes), bytes };
}

function signature(call: BudgetCall): string {
  return call.outcome === undefined ? call.call : `${call.call} (${call.outcome})`;
}

function sameCalls(was: readonly BudgetCall[], now: readonly BudgetCall[]): boolean {
  return (
    was.length === now.length &&
    was.every((call, index) => {
      const other = now[index];
      return other !== undefined && signature(call) === signature(other);
    })
  );
}

/** Compares a measured step with its budget. */
export function compareBudgets(was: Budget, now: Budget): Comparison {
  const changes: NumberChange[] = [
    change("statements", was.statements, now.statements, false),
    change("bytes", was.bytes, now.bytes, true),
  ];
  const callsChanged = !sameCalls(was.calls, now.calls);
  if (!callsChanged) {
    now.calls.forEach((call, index) => {
      const stored = was.calls[index] ?? call;
      const label = `${call.call} (call ${index + 1})`;
      changes.push(
        change(`${label} statements`, stored.statements, call.statements, false),
        change(`${label} bytes`, stored.bytes, call.bytes, true),
      );
    });
  }
  return {
    grew: callsChanged || changes.some((each) => each.direction === "grew"),
    fell: changes.some((each) => each.direction === "fell"),
    callsChanged,
    changes,
    was,
    now,
  };
}

function describe(each: NumberChange): string {
  const line = `  ${each.label}: was ${each.was}, now ${each.now}`;
  if (!each.bytes || each.was === 0) {
    return line;
  }
  const percent = ((each.now - each.was) / each.was) * 100;
  return `${line} (${percent > 0 ? "+" : ""}${percent.toFixed(1)}%; bytes may move by ${BUDGET_BYTES_TOLERANCE * 100}%)`;
}

/**
 * The lines of a failure message: each number that moved `direction` (grew,
 * by default) with its old and new values, and for growth the changed calls.
 */
export function describeChanges(
  comparison: Comparison,
  direction: "grew" | "fell" = "grew",
): string {
  const lines = comparison.changes.filter((each) => each.direction === direction).map(describe);
  if (direction === "grew" && comparison.callsChanged) {
    const list = (calls: readonly BudgetCall[]): string =>
      calls.length === 0 ? "none" : calls.map(signature).join(", ");
    lines.push(`  calls: was ${list(comparison.was.calls)}; now ${list(comparison.now.calls)}`);
  }
  return lines.join("\n");
}

/**
 * The budget to store after a comparison that changed something: the
 * measured step where its calls changed, else each number that moved past
 * the tolerance at its new value and every other number as it was.
 */
export function mergeBudget(was: Budget, now: Budget, comparison: Comparison): Budget {
  if (comparison.callsChanged) {
    return now;
  }
  const pick = (stored: number, measured: number, bytes: boolean): number =>
    directionOf(stored, measured, bytes) === "same" ? stored : measured;
  return {
    statements: pick(was.statements, now.statements, false),
    bytes: pick(was.bytes, now.bytes, true),
    calls: now.calls.map((call, index) => {
      const stored = was.calls[index] ?? call;
      return {
        ...call,
        statements: pick(stored.statements, call.statements, false),
        bytes: pick(stored.bytes, call.bytes, true),
      };
    }),
  };
}
