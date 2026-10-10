// Aggregators: functions that call method modules' register functions, the
// way split services wire them (`defineQueryMethods(service) {
// defineGetTarget(service); defineListTargets(service); }`), or call other
// aggregators. The run turns each register function into method objects, so
// an aggregator would call functions that no longer exist. One that does
// nothing else goes with its calls: the service class's
// (`defineQueryMethods(this)` vanishes with the constructor, see hoist.ts)
// and other aggregators'. So does a file it leaves empty, unless something
// imports it. One that does more (a condition, logging, a call of a function
// the run did not convert) stays under the register-leftover marker, without
// its calls of converted functions, which the marker names. A call of a
// register function the run kept for its other statements, or of a kept
// aggregator, goes too: the kept function's own marker says what it still
// does.

import {
  type ExpressionStatement,
  type FunctionDeclaration,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { Work } from "../apply";
import type { RunContext } from "../context";
import { isImported } from "../imports";
import { MarkerSet } from "../markers";
import { apiFiles } from "../model";
import type { ServicePlan } from "../plan";
import { editedText, type Edit, removalEdit } from "../text";
import type { ConvertedCalls } from "./methods";
import { registerLeftoverMessage } from "./serviceText";

/** A statement calling a register function or an aggregator, and that function as the call names it. */
interface ConvertedCall {
  readonly statement: ExpressionStatement;
  readonly callee: string;
}

/** The aggregators of a run, and the calls of the functions it converts. */
export interface Aggregators extends ConvertedCalls {
  /** The aggregators that only call converted functions: they go. */
  readonly removed: readonly FunctionDeclaration[];
  /** The aggregators that do more: they stay, marked, without their converted calls. */
  readonly kept: readonly FunctionDeclaration[];
  /** The statements of `fn` (not those of a function inside it) that call a converted function. */
  calls(fn: FunctionDeclaration): ConvertedCall[];
}

/** A statement calling a function by name: an identifier, or a member of a namespace import. */
interface NamedCall extends ConvertedCall {
  readonly name: Node;
}

/** The statements of `fn` that call a function by name, not those of a function or class inside it. */
function namedCalls(fn: FunctionDeclaration): NamedCall[] {
  return fn.getDescendantsOfKind(SyntaxKind.ExpressionStatement).flatMap((statement) => {
    const call = statement.getExpression();
    const owner = statement.getFirstAncestor(
      (node) =>
        Node.isFunctionLikeDeclaration(node) ||
        Node.isClassDeclaration(node) ||
        Node.isClassExpression(node),
    );
    if (owner !== fn || !Node.isCallExpression(call)) {
      return [];
    }
    const callee = call.getExpression();
    const name = Node.isIdentifier(callee)
      ? callee
      : Node.isPropertyAccessExpression(callee) && Node.isIdentifier(callee.getExpression())
        ? callee.getNameNode()
        : undefined;
    return name === undefined ? [] : [{ statement, name, callee: callee.getText() }];
  });
}

const IDENTIFIER = /[$A-Z_a-z][\w$]*/gu;

/** Whether `text` holds one of `names` as a word. */
function mentions(text: string, names: ReadonlySet<string>): boolean {
  for (const [word] of text.matchAll(IDENTIFIER)) {
    if (names.has(word)) {
      return true;
    }
  }
  return false;
}

/** The function declarations a name refers to, through its import. */
function functionsNamed(name: Node): FunctionDeclaration[] {
  const symbol = name.getSymbol();
  const target = symbol?.isAlias() === true ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
  return (target?.getDeclarations() ?? []).filter(
    (declaration): declaration is FunctionDeclaration => Node.isFunctionDeclaration(declaration),
  );
}

/** The other names files give a function they import or re-export (`import { a as b }`), by its own name. */
function aliasesIn(files: readonly SourceFile[]): Map<string, Set<string>> {
  const aliases = new Map<string, Set<string>>();
  for (const file of files) {
    const specifiers = [
      ...file.getImportDeclarations().flatMap((declaration) => declaration.getNamedImports()),
      ...file.getExportDeclarations().flatMap((declaration) => declaration.getNamedExports()),
    ];
    for (const specifier of specifiers) {
      const alias = specifier.getAliasNode()?.getText();
      if (alias !== undefined) {
        aliases.set(
          specifier.getName(),
          (aliases.get(specifier.getName()) ?? new Set()).add(alias),
        );
      }
    }
  }
  return aliases;
}

/**
 * The edit removing a call of a converted function: the statement, or, where
 * a statement must stay (`if (x) registerX(service);`), an empty block.
 */
function callRemoval({ statement }: ConvertedCall): Edit {
  const parent = statement.getParent();
  return Node.isBlock(parent) ||
    Node.isSourceFile(parent) ||
    Node.isCaseClause(parent) ||
    Node.isDefaultClause(parent) ||
    Node.isModuleBlock(parent)
    ? removalEdit(statement)
    : { start: statement.getStart(), end: statement.getEnd(), text: "{}" };
}

/** The callees of `calls`, once each, in order. */
function calleesOf(calls: readonly ConvertedCall[]): string[] {
  return [...new Set(calls.map((call) => call.callee))];
}

/**
 * Finds the aggregators of the api files outside test code: the functions
 * that call a register function the run converts (one of `plans`' methods is
 * registered in it) or another aggregator. A callee is resolved through its
 * import, and only when it names a converted function (or an alias of one).
 */
export function findAggregators(ctx: RunContext, plans: readonly ServicePlan[]): Aggregators {
  const converted = new Set(
    plans.flatMap((plan) => plan.methods.flatMap((method) => method.call.register ?? [])),
  );
  const resolved = new Map<Node, FunctionDeclaration[]>();
  const named = new Map<FunctionDeclaration, NamedCall[]>();
  let names = new Set<string>();
  const isConverted = ({ name }: NamedCall): boolean => {
    if (!names.has(name.getText())) {
      return false;
    }
    const functions = resolved.get(name) ?? functionsNamed(name);
    resolved.set(name, functions);
    return functions.some((fn) => converted.has(fn));
  };
  // Only a function whose text names a converted function is walked.
  const calls = (fn: FunctionDeclaration): ConvertedCall[] => {
    if (!mentions(fn.getText(), names)) {
      return [];
    }
    const list = named.get(fn) ?? namedCalls(fn);
    named.set(fn, list);
    return list.filter(isConverted).map(({ statement, callee }) => ({ statement, callee }));
  };
  const of: ConvertedCalls["of"] = (fn) => {
    const removedCalls = calls(fn);
    return {
      statements: new Set<Node>(removedCalls.map((call) => call.statement)),
      callees: calleesOf(removedCalls),
      text: editedText(fn, removedCalls.map(callRemoval)),
    };
  };
  if (converted.size === 0) {
    return { removed: [], kept: [], calls, of };
  }
  const files = apiFiles(ctx.project, ctx.layout);
  const aliases = aliasesIn(files);
  const candidates = files
    .flatMap((file) => file.getFunctions())
    .filter((fn) => fn.hasBody() && !converted.has(fn));
  const found: FunctionDeclaration[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    names = new Set(
      [...converted].flatMap((fn) => {
        const name = fn.getName();
        return name === undefined ? [] : [name, ...(aliases.get(name) ?? [])];
      }),
    );
    for (const fn of candidates) {
      if (!converted.has(fn) && calls(fn).length > 0) {
        found.push(fn);
        converted.add(fn);
        grew = true;
      }
    }
  }
  const removed = found.filter((fn) => {
    const statements = new Set<Node>(calls(fn).map((call) => call.statement));
    return fn.getStatements().every((statement) => statements.has(statement));
  });
  return { removed, kept: found.filter((fn) => !removed.includes(fn)), calls, of };
}

/**
 * Removes the aggregators that only call converted functions, and marks the
 * others, removing their calls of converted functions. Returns the files a
 * removed one was in, for `deleteEmptied` once the edits are applied.
 */
export function removeAggregators(
  ctx: RunContext,
  aggregators: Aggregators,
  work: Work,
): Set<SourceFile> {
  const files = new Set<SourceFile>();
  for (const fn of aggregators.removed) {
    const file = fn.getSourceFile();
    const fileWork = work.for(file);
    fileWork.edits.push(removalEdit(fn));
    fileWork.tidy = true;
    files.add(file);
    ctx.stats.aggregatorsRemoved += 1;
  }
  for (const fn of aggregators.kept) {
    const file = fn.getSourceFile();
    const calls = aggregators.calls(fn);
    const markers = new MarkerSet(file);
    markers.addAbove(
      fn,
      "this",
      registerLeftoverMessage(fn.getName() ?? "this function", calleesOf(calls)),
    );
    const fileWork = work.for(file);
    fileWork.edits.push(...calls.map(callRemoval), ...markers.edits);
    fileWork.tidy = true;
  }
  return files;
}

/**
 * Deletes the files the removed aggregators left without a statement, unless
 * something still imports them. Runs after the edits are applied.
 */
export function deleteEmptied(ctx: RunContext, files: ReadonlySet<SourceFile>): void {
  for (const file of files) {
    if (file.wasForgotten() || file.getStatements().length > 0 || isImported(ctx.project, file)) {
      continue;
    }
    ctx.deleted.add(file.getFilePath());
    file.delete();
  }
}
