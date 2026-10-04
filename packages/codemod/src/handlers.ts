// One `defineMethod(name, level, handler, options)` call becomes one
// `{ access, handler }` method object. The handler body is kept; its
// parameters `(payload, ctx)` become `({ input, ctx, db })` (only the names it
// uses), `payload` is renamed `input`, the 4.x context fields map onto 5.0's
// (`ctx.userId` is `ctx.principal.userId`), and receiver references go
// through `receiver.ts`. The template's `requireAuth(ctx)` guard is dropped
// where access already requires a principal: 4.x had answered such a caller
// before the handler ran too. In a file that imports the tracked `db` (its
// helper functions use it), a handler uses that one rather than taking `db`
// as well, which would shadow it: it is the same client. A `throw new
// Error(message)` in a handler gets an `[error]` marker: 4.x sent its message
// to the caller, 5.0 answers it with `INTERNAL` and a generic message unless
// it is a `QuickdrawError` with a code.

import {
  type ArrowFunction,
  type FunctionExpression,
  type Identifier,
  Node,
  type ParameterDeclaration,
  SyntaxKind,
} from "ts-morph";
import type { AccessForm } from "./access";
import { MarkerSet, markerAnchor, markerText } from "./markers";
import type { MethodCall } from "./model";
import { type Hoisted, mapReceiver, type ReceiverScope } from "./receiver";
import { type Edit, editedText, statementOf } from "./text";

/** A built method object. */
export interface MethodEntry {
  readonly name: string;
  /** `{ access, handler }`, as code. */
  readonly text: string;
  readonly imports: readonly Hoisted[];
}

type Handler = ArrowFunction | FunctionExpression;

function isUnused(param: ParameterDeclaration | undefined): boolean {
  return (
    param === undefined ||
    (Node.isIdentifier(param.getNameNode()) && param.getName().startsWith("_"))
  );
}

/** References to `param` (an identifier parameter) inside `body`. */
function referencesTo(param: ParameterDeclaration, body: Node): Identifier[] {
  const symbol = param.getSymbol();
  return body
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter(
      (identifier) => identifier.getSymbol() === symbol && identifier !== param.getNameNode(),
    );
}

/** Renames `payload` to `input`, unless `input` already means something there. */
function renamePayload(param: ParameterDeclaration, body: Node, edits: Edit[]): string {
  const name = param.getName();
  const references = referencesTo(param, body);
  const taken = body
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .some((identifier) => identifier.getText() === "input");
  if (name === "input" || taken) {
    return name === "input" ? "input" : `input: ${name}`;
  }
  for (const reference of references) {
    const parent = reference.getParent();
    const text = Node.isShorthandPropertyAssignment(parent) ? `${name}: input` : "input";
    edits.push({ start: reference.getStart(), end: reference.getEnd(), text });
  }
  return "input";
}

interface ContextResult {
  readonly edits: Edit[];
  readonly markers: { node: Node; message: string }[];
  readonly removed: Node[];
}

/** Whether a statement only throws: `throw ...`, or a block holding just that. */
function onlyThrows(statement: Node | undefined): boolean {
  if (statement === undefined) {
    return false;
  }
  if (Node.isBlock(statement)) {
    const [only, ...rest] = statement.getStatements();
    return rest.length === 0 && only !== undefined && Node.isThrowStatement(only);
  }
  return Node.isThrowStatement(statement);
}

/**
 * 4.x handlers guarded the principal inline (`if (!ctx.userId) throw ...`).
 * Where access already requires a principal, a guard that is all of its
 * condition is dead code and goes; one that is part of a larger condition
 * is marked (5.0's lint rule no-inline-auth-guard reports both).
 */
function markGuard(access: Node, form: AccessForm, result: ContextResult): void {
  const not = access.getParent();
  const guard = not?.getFirstAncestorByKind(SyntaxKind.IfStatement);
  if (
    not === undefined ||
    !Node.isPrefixUnaryExpression(not) ||
    not.getOperatorToken() !== SyntaxKind.ExclamationToken ||
    guard === undefined ||
    !onlyThrows(guard.getThenStatement())
  ) {
    return;
  }
  const condition = guard.getExpression();
  if (not.getStart() < condition.getStart() || not.getEnd() > condition.getEnd()) {
    return;
  }
  if (condition === not && guard.getElseStatement() === undefined && !form.isPublic) {
    result.removed.push(guard);
  } else if (!form.isPublic) {
    result.markers.push({
      node: guard,
      message:
        "inline auth guard: the access form already requires a principal, so the !ctx.principal.userId part never holds; drop it (lint: no-inline-auth-guard)",
    });
  }
}

/** Maps the 4.x context's fields onto 5.0's, and drops or marks `requireAuth(ctx)`. */
function mapContext(param: ParameterDeclaration, body: Node, form: AccessForm): ContextResult {
  const result: ContextResult = { edits: [], markers: [], removed: [] };
  const name = param.getName();
  const principal = form.isPublic ? `${name}.principal?.` : `${name}.principal.`;
  for (const reference of referencesTo(param, body)) {
    const parent = reference.getParent();
    if (
      Node.isPropertyAccessExpression(parent) &&
      parent.getExpression() === reference &&
      parent.getName() === "userId"
    ) {
      markGuard(parent, form, result);
    }
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === reference) {
      const field = parent.getName();
      if (field === "userId") {
        result.edits.push({
          start: parent.getStart(),
          end: parent.getEnd(),
          text: `${principal}userId`,
        });
      } else if (field === "serviceAccess") {
        result.edits.push({
          start: parent.getStart(),
          end: parent.getEnd(),
          text: `(${principal}serviceAccess ?? {})`,
        });
      } else {
        result.markers.push({
          node: parent,
          message: `ctx.${field} was a field of 4.x's method context (userId, socketId, serviceAccess); 5.0's ctx has principal, requestId, log and transport`,
        });
      }
      continue;
    }
    const call = parent;
    const guard =
      Node.isCallExpression(call) &&
      call.getExpression().getText() === "requireAuth" &&
      Node.isExpressionStatement(call.getParent());
    if (guard && !form.isPublic) {
      result.removed.push(call.getParentOrThrow());
    } else if (guard) {
      result.markers.push({
        node: call,
        message:
          'requireAuth guarded a public method: declare access "authenticated" instead of guarding in the handler',
      });
    } else {
      result.markers.push({
        node: reference,
        message:
          "passes 4.x's method context on: 5.0's ctx has principal (userId, serviceAccess), requestId, log and transport instead of userId, socketId and serviceAccess",
      });
    }
  }
  return result;
}

/** The edit that removes a whole statement and its line. */
function removal(statement: Node): Edit {
  const text = statement.getSourceFile().getFullText();
  let start = statement.getStart();
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) {
    start -= 1;
  }
  let end = text[statement.getEnd()] === "\n" ? statement.getEnd() + 1 : statement.getEnd();
  // a blank line left at the top of the block goes too
  if (text[end] === "\n" && /\{\s*$/u.test(text.slice(0, start))) {
    end += 1;
  }
  return { start, end, text: "" };
}

/** The `(...)` of a function's parameter list, or its single bare parameter. */
function paramRange(handler: Handler): { start: number; end: number } {
  const open = handler.getFirstChildByKind(SyntaxKind.OpenParenToken);
  const close = handler.getFirstChildByKind(SyntaxKind.CloseParenToken);
  if (open !== undefined && close !== undefined) {
    return { start: open.getStart(), end: close.getEnd() };
  }
  const [param] = handler.getParameters();
  return {
    start: param?.getStart() ?? handler.getStart(),
    end: param?.getEnd() ?? handler.getStart(),
  };
}

function paramsText(
  payloadBinding: string | undefined,
  ctxBinding: string | undefined,
  usesDb: boolean,
): string {
  const parts = [payloadBinding, ctxBinding, usesDb ? "db" : undefined].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length === 0 ? "()" : `({ ${parts.join(", ")} })`;
}

function payloadBindingOf(
  param: ParameterDeclaration | undefined,
  body: Node,
  edits: Edit[],
): string | undefined {
  if (param === undefined || isUnused(param)) {
    return undefined;
  }
  const nameNode = param.getNameNode();
  return Node.isIdentifier(nameNode)
    ? renamePayload(param, body, edits)
    : `input: ${nameNode.getText()}`;
}

/** The error classes whose message 4.x sent to the caller and 5.0 answers with a generic `INTERNAL`. */
const PLAIN_ERRORS: ReadonlySet<string> = new Set(["Error", "TypeError", "RangeError"]);

const ERROR_MESSAGE =
  "4.x sent this error's message to the caller; 5.0 answers an error that is not a QuickdrawError with INTERNAL and a generic message: throw new QuickdrawError(code, message) with the code that fits (NOT_FOUND, FORBIDDEN, CONFLICT, VALIDATION) if the caller should see it";

/** The `throw new Error(...)` statements in a handler's body, nested callbacks included. */
function plainErrorThrows(body: Node): Node[] {
  return body.getDescendantsOfKind(SyntaxKind.ThrowStatement).filter((statement) => {
    const thrown = statement.getExpression();
    return Node.isNewExpression(thrown) && PLAIN_ERRORS.has(thrown.getExpression().getText());
  });
}

/** The handler's new code, and what it needs. */
function buildHandler(
  handler: Handler,
  form: AccessForm,
  scope: Omit<ReceiverScope, "ctxName">,
  entryMarkers: string[],
  moduleDb: boolean,
): { text: string; imports: Hoisted[] } {
  const [payloadParam, ctxParam] = handler.getParameters();
  const body = handler.getBody();
  const ctxName = ctxParam !== undefined && !isUnused(ctxParam) ? ctxParam.getName() : "ctx";
  const mapped = mapReceiver(body, { ...scope, ctxName });
  const edits: Edit[] = [...mapped.edits];
  const markers = new MarkerSet(handler.getSourceFile());
  const mark = (node: Node, category: Parameters<MarkerSet["add"]>[1], message: string): void => {
    const target = markerAnchor(statementOf(node));
    if (
      target.getStart() > body.getStart() &&
      target.getEnd() <= body.getEnd() &&
      target !== body
    ) {
      markers.addAbove(target, category, message);
    } else {
      const line = markerText(category, message);
      if (!entryMarkers.includes(line)) {
        entryMarkers.push(line);
      }
    }
  };
  for (const marker of mapped.markers) {
    mark(marker.node, marker.category, marker.message);
  }
  const payloadBinding = payloadBindingOf(payloadParam, body, edits);
  let usesCtx = mapped.usesCtx;
  let removedRanges: (readonly [number, number])[] = [];
  if (ctxParam !== undefined && !isUnused(ctxParam)) {
    const context = mapContext(ctxParam, body, form);
    edits.push(...context.edits, ...context.removed.map((statement) => removal(statement)));
    context.markers.forEach((marker) => mark(marker.node, "context", marker.message));
    removedRanges = context.removed.map(
      (statement) => [statement.getStart(), statement.getEnd()] as const,
    );
    usesCtx ||= referencesTo(ctxParam, body).some(
      (reference) =>
        !removedRanges.some(
          ([start, end]) => reference.getStart() >= start && reference.getEnd() <= end,
        ),
    );
  }
  for (const thrown of plainErrorThrows(body)) {
    const removed = removedRanges.some(
      ([start, end]) => thrown.getStart() >= start && thrown.getEnd() <= end,
    );
    if (!removed) {
      mark(thrown, "error", ERROR_MESSAGE);
    }
  }
  const ctxBinding = usesCtx ? (ctxName === "ctx" ? "ctx" : `ctx: ${ctxName}`) : undefined;
  const range = paramRange(handler);
  edits.push({
    start: range.start,
    end: range.end,
    text: paramsText(payloadBinding, ctxBinding, mapped.usesDb && !moduleDb),
  });
  return { text: editedText(handler, [...edits, ...markers.edits]), imports: mapped.imports };
}

/**
 * Builds the method object for `call`, with `form` as its access. With
 * `moduleDb`, the file imports the tracked `db`, which the handler uses.
 */
export function buildMethod(
  call: MethodCall,
  form: AccessForm,
  scope: Omit<ReceiverScope, "ctxName">,
  moduleDb = false,
  notes: readonly string[] = [],
): MethodEntry {
  const entryMarkers: string[] = [];
  const accessMarkers = form.notes.map((note) => markerText(note.category, note.message));
  let handlerText: string;
  let imports: Hoisted[] = [];
  if (call.handler === undefined) {
    handlerText = `({ input, ctx }) => (${call.handlerArg?.getText() ?? "undefined"})(input, ctx)`;
    entryMarkers.push(
      markerText(
        "context",
        "the 4.x handler was not an inline function: make it take ({ input, ctx, db })",
      ),
    );
  } else {
    const built = buildHandler(call.handler, form, scope, entryMarkers, moduleDb);
    handlerText = built.text;
    imports = built.imports;
  }
  const lines = [
    "{",
    ...accessMarkers,
    `access: ${form.code},`,
    ...(form.rowless ? ["rowless: true,"] : []),
    ...notes,
    ...entryMarkers,
    `handler: ${handlerText},`,
    "}",
  ];
  return { name: call.name, text: lines.join("\n"), imports };
}
