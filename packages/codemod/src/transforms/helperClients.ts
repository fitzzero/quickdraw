// Writers that take the Prisma client say they take the tracked one. A module
// function with a parameter typed as the app's Prisma client (`prisma:
// PrismaClient`, or `Prisma.TransactionClient`), which writes through it or
// hands it to a function that does, and whose every caller the run sees
// gives it the tracked client, gets that type wrapped: `Tracked<PrismaClient>`,
// or `TrackedTransaction<...>` when a caller gives it a transaction's client
// or its 4.x type took one (`TrackedTransaction<Prisma.TransactionClient>` is
// `TrackedTransaction<PrismaClient>`). The tracked client is a handler's `db`, a
// client `trackPrisma` made (the `db` of the api's `db.ts`, which the run
// imports where 4.x code used `this.prisma`), a parameter or variable typed
// with quickdraw's `Tracked` or `TrackedTransaction`, the client of a
// transaction on one of those, or the parameter of another writer retyped
// here. The compiler then refuses the untracked client there, and lint's
// `no-untracked-write` reads the type whatever the parameter is named: an
// app's writers that took `prisma: PrismaClient`, and were only ever given
// the tracked client, were reported until they said so.
//
// A function is left as it is when a caller gives it anything else (the
// untracked `prisma`, the parameter of a function whose callers the run does
// not see), when nothing in the run calls it, when it is used other than by
// a call (passed on, stored, `typeof`), and when it only reads: a read needs
// no tracked client, and a caller outside the run may hold the untracked
// one. A caller outside the run that gives a retyped writer the untracked
// client no longer compiles, which is the point: its writes reached no
// subscriber. The analysis reads a project of its own (`analysisProject`).

import {
  type ArrowFunction,
  type BindingElement,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  Node,
  type ParameterDeclaration,
  Project,
  type SourceFile,
  SyntaxKind,
  type TypeNode,
} from "ts-morph";
import type { Work } from "../apply";
import { declaresBinding } from "../bindings";
import type { RunContext } from "../context";
import {
  declarationsOf,
  type Given as GivenTo,
  givenBy,
  PRISMA_MODULE,
  QUICKDRAW_MODULES,
  unwrapped,
} from "../trackedClient";

/** The Prisma model operations that write rows, as lint's rules list them. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression;

/** A module function's parameter typed as the app's Prisma client. */
interface Candidate {
  readonly fn: FunctionLike;
  /** The function's name where it is declared: its own, or its `const`'s. */
  readonly name: Identifier;
  readonly param: ParameterDeclaration;
  readonly index: number;
  /** Its 4.x type took a transaction's client (`Prisma.TransactionClient`). */
  readonly transaction: boolean;
}

/** What a call gives a candidate's parameter; a candidate's own parameter is tracked when that candidate is retyped. */
type Given = GivenTo<Candidate>;

/** The local names `file` imports `PrismaClient` and the `Prisma` namespace under. */
function prismaNames(file: SourceFile): {
  client: string | undefined;
  namespace: string | undefined;
} {
  let client: string | undefined;
  let namespace: string | undefined;
  for (const declaration of file.getImportDeclarations()) {
    for (const specifier of declaration.getNamedImports()) {
      const local = (specifier.getAliasNode() ?? specifier.getNameNode()).getText();
      if (specifier.getName() === "PrismaClient") {
        client = local;
      } else if (specifier.getName() === "Prisma") {
        namespace = local;
      }
    }
  }
  return { client, namespace };
}

/**
 * Whether `type` is the app's Prisma client (`PrismaClient`, `Prisma.TransactionClient`
 * or a union of them): `"transaction"` when it takes a transaction's client.
 */
function clientType(
  type: TypeNode | undefined,
  names: { client: string | undefined; namespace: string | undefined },
): "client" | "transaction" | undefined {
  if (Node.isUnionTypeNode(type)) {
    const members = type.getTypeNodes().map((member) => clientType(member, names));
    if (members.some((member) => member === undefined)) {
      return undefined;
    }
    return members.includes("transaction") ? "transaction" : "client";
  }
  if (!Node.isTypeReference(type) || type.getTypeArguments().length > 0) {
    return undefined;
  }
  const name = type.getTypeName();
  if (Node.isIdentifier(name)) {
    return names.client !== undefined && name.getText() === names.client ? "client" : undefined;
  }
  return names.namespace !== undefined &&
    name.getLeft().getText() === names.namespace &&
    name.getRight().getText() === "TransactionClient"
    ? "transaction"
    : undefined;
}

/** The file's module functions: its function declarations and the functions its `const`s hold. */
function moduleFunctions(file: SourceFile): { fn: FunctionLike; name: Identifier }[] {
  const functions: { fn: FunctionLike; name: Identifier }[] = [];
  for (const fn of file.getFunctions()) {
    const name = fn.getNameNode();
    if (name !== undefined && fn.hasBody() && fn.getOverloads().length === 0) {
      functions.push({ fn, name });
    }
  }
  for (const statement of file.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      const initializer = declaration.getInitializer();
      const name = declaration.getNameNode();
      if (
        Node.isIdentifier(name) &&
        (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
      ) {
        functions.push({ fn: initializer, name });
      }
    }
  }
  return functions;
}

function candidatesOf(files: readonly SourceFile[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const file of files) {
    const names = prismaNames(file);
    if (names.client === undefined && names.namespace === undefined) {
      continue;
    }
    for (const { fn, name } of moduleFunctions(file)) {
      fn.getParameters().forEach((param, index) => {
        const type = clientType(param.getTypeNode(), names);
        if (
          type !== undefined &&
          Node.isIdentifier(param.getNameNode()) &&
          !param.isRestParameter()
        ) {
          candidates.push({ fn, name, param, index, transaction: type === "transaction" });
        }
      });
    }
  }
  return candidates;
}

/** The app's source files, the ones the run reads (no declaration files, nothing installed). */
function appFiles(project: Project): SourceFile[] {
  return project
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile() && !file.isInNodeModules());
}

/**
 * A project of its own over the run's sources as they stand, which the type
 * checker reads afresh. In the run's project, ts-morph keeps each file's
 * import literals that resolved to no file, and checks them again whenever
 * the checker loads one; a file an earlier transform rewrote still holds
 * literals ts-morph has forgotten, and the first file the checker loads for
 * the migrated imports throws on them. This project has no such history. It
 * lives in memory and holds the app's sources only: packages stay
 * unresolved, which the analysis, reading the app's own functions and calls,
 * does not need.
 */
function analysisProject(ctx: RunContext): Project {
  const project = new Project({
    compilerOptions: ctx.project.getCompilerOptions(),
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    useInMemoryFileSystem: true,
  });
  for (const file of appFiles(ctx.project)) {
    project.createSourceFile(file.getFilePath(), file.getFullText());
  }
  return project;
}

/** What a destructured binding names: `const { assignTask } = await import("./rows.js")` names rows.ts's function. */
function bindingTargets(element: BindingElement): Node[] {
  const owner = element.getParent().getParent();
  const key = element.getPropertyNameNode()?.getText() ?? element.getName();
  const property = Node.isVariableDeclaration(owner)
    ? owner.getInitializer()?.getType().getProperty(key)
    : undefined;
  return (property?.getAliasedSymbol() ?? property)?.getDeclarations() ?? [];
}

/** Whether `node` names `param`. */
function namesParameter(node: Node | undefined, param: ParameterDeclaration): boolean {
  return Node.isIdentifier(node) && declarationsOf(node).includes(param);
}

/** Whether the candidate writes through its parameter itself: `prisma.<model>.<write>(...)` or `prisma.$transaction(...)`. */
function writesDirectly(candidate: Candidate): boolean {
  return candidate.fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) {
      return false;
    }
    const target = unwrapped(callee.getExpression());
    if (callee.getName() === "$transaction") {
      return namesParameter(target, candidate.param);
    }
    return (
      WRITE_METHODS.has(callee.getName()) &&
      Node.isPropertyAccessExpression(target) &&
      namesParameter(unwrapped(target.getExpression()), candidate.param)
    );
  });
}

/** The candidate a call's expression calls with its parameter at `index`, if any. */
function candidateCalled(
  callee: Node,
  index: number,
  byName: ReadonlyMap<Node, readonly Candidate[]>,
): Candidate | undefined {
  const named = Node.isPropertyAccessExpression(callee) ? callee.getNameNode() : callee;
  if (!Node.isIdentifier(named)) {
    return undefined;
  }
  const declarations = declarationsOf(named).flatMap((declaration) =>
    Node.isBindingElement(declaration) ? bindingTargets(declaration) : [declaration],
  );
  for (const declaration of declarations) {
    const name =
      Node.isVariableDeclaration(declaration) || Node.isFunctionDeclaration(declaration)
        ? declaration.getNameNode()
        : undefined;
    const candidate =
      name === undefined ? undefined : byName.get(name)?.find((each) => each.index === index);
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

/** The writers among `candidates`: they write through their parameter, or hand it to a writer. */
function writers(
  candidates: readonly Candidate[],
  byName: ReadonlyMap<Node, readonly Candidate[]>,
): Set<Candidate> {
  const found = new Set(candidates.filter(writesDirectly));
  for (let grew = true; grew; ) {
    grew = false;
    for (const candidate of candidates) {
      if (found.has(candidate)) {
        continue;
      }
      const handsOn = candidate.fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) =>
        call.getArguments().some((argument, index) => {
          if (!namesParameter(unwrapped(argument), candidate.param)) {
            return false;
          }
          const called = candidateCalled(call.getExpression(), index, byName);
          return called !== undefined && found.has(called);
        }),
      );
      if (handsOn) {
        found.add(candidate);
        grew = true;
      }
    }
  }
  return found;
}

/** The arguments of every call of a candidate's function, or `undefined` when it is used other than by a call. */
function callsOf(candidate: Candidate): (readonly Node[])[] | undefined {
  const calls: (readonly Node[])[] = [];
  const pending: Identifier[] = [candidate.name];
  const seen = new Set<Node>([candidate.name]);
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined) {
      break;
    }
    for (const reference of name.findReferencesAsNodes()) {
      if (seen.has(reference) || reference.getAncestors().some((node) => Node.isJSDoc(node))) {
        continue;
      }
      seen.add(reference);
      const parent = reference.getParent();
      if (
        Node.isImportSpecifier(parent) ||
        Node.isExportSpecifier(parent) ||
        Node.isImportClause(parent)
      ) {
        continue;
      }
      if (Node.isBindingElement(parent)) {
        // `const { countTasks } = await import("./rows.js")`: its calls are the local's
        const local = parent.getNameNode();
        if (!Node.isIdentifier(local)) {
          return undefined;
        }
        if (!seen.has(local) || local === reference) {
          pending.push(local);
        }
        continue;
      }
      const callee =
        Node.isPropertyAccessExpression(parent) && parent.getNameNode() === reference
          ? parent
          : reference;
      const call = callee.getParent();
      if (!Node.isCallExpression(call) || call.getExpression() !== callee) {
        return undefined;
      }
      calls.push(call.getArguments());
    }
  }
  return calls;
}

/** Whether a call's `given` is tracked while the candidates in `kept` are retyped. */
function isTracked(given: Given, kept: ReadonlySet<Candidate>): boolean {
  switch (given.kind) {
    case "untracked":
      return false;
    case "root":
      return true;
    default:
      return given.of === undefined || kept.has(given.of);
  }
}

/** The writers whose every caller gives them the tracked client, each with whether one gives a transaction's client. */
function retyped(candidates: readonly Candidate[]): Map<Candidate, boolean> {
  const byName = new Map<Node, Candidate[]>();
  for (const candidate of candidates) {
    byName.set(candidate.name, [...(byName.get(candidate.name) ?? []), candidate]);
  }
  const calls = new Map<Candidate, Given[]>();
  for (const candidate of writers(candidates, byName)) {
    const found = callsOf(candidate);
    if (found !== undefined && found.length > 0) {
      calls.set(
        candidate,
        found.map((args) =>
          givenBy(args[candidate.index], (declaration) =>
            candidates.find((each) => each.param === declaration),
          ),
        ),
      );
    }
  }
  // The greatest set whose every caller gives the tracked client, its own parameters included
  const kept = new Set(calls.keys());
  for (let shrank = true; shrank; ) {
    shrank = false;
    for (const candidate of kept) {
      if (!(calls.get(candidate) ?? []).every((given) => isTracked(given, kept))) {
        kept.delete(candidate);
        shrank = true;
      }
    }
  }
  // A transaction's client reaches a writer from its caller, or through a writer that takes one
  const transaction = new Set([...kept].filter((candidate) => candidate.transaction));
  for (let grew = true; grew; ) {
    grew = false;
    for (const candidate of kept) {
      const takes = (calls.get(candidate) ?? []).some(
        (given) =>
          given.kind === "transaction" || (given.kind === "parameter" && transaction.has(given.of)),
      );
      if (takes && !transaction.has(candidate)) {
        transaction.add(candidate);
        grew = true;
      }
    }
  }
  return new Map([...kept].map((candidate) => [candidate, transaction.has(candidate)]));
}

/** How `file` binds `name`: not at all, by quickdraw's type of that name, or as something else. */
function bindingOf(file: SourceFile, name: string): "free" | "quickdraw" | "other" {
  let binding: "free" | "quickdraw" = "free";
  for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (identifier.getText() !== name) {
      continue;
    }
    const parent = identifier.getParent();
    if (Node.isImportSpecifier(parent)) {
      if ((parent.getAliasNode() ?? parent.getNameNode()) !== identifier) {
        continue;
      }
      const source = parent.getImportDeclaration().getModuleSpecifierValue();
      if (!QUICKDRAW_MODULES.has(source) || parent.getName() !== name) {
        return "other";
      }
      binding = "quickdraw";
    } else if (
      declaresBinding(identifier) ||
      ((Node.isTypeAliasDeclaration(parent) ||
        Node.isInterfaceDeclaration(parent) ||
        Node.isTypeParameterDeclaration(parent)) &&
        parent.getNameNode() === identifier)
    ) {
      return "other";
    }
  }
  return binding;
}

/**
 * Retypes the writers whose every caller the run sees gives them the
 * tracked client: their 4.x type in `Tracked<...>`, or in `TrackedTransaction<...>`.
 */
export function typeHelperClients(ctx: RunContext, work: Work): void {
  // Most apps have no such writer: the analysis project is built only when one may be there
  if (candidatesOf(appFiles(ctx.project)).length === 0) {
    return;
  }
  const project = analysisProject(ctx);
  for (const [candidate, transaction] of retyped(candidatesOf(appFiles(project)))) {
    const wrapper = transaction ? "TrackedTransaction" : "Tracked";
    const file = ctx.project.getSourceFile(candidate.param.getSourceFile().getFilePath());
    const type = candidate.param.getTypeNode();
    const binding = file === undefined ? "other" : bindingOf(file, wrapper);
    if (file === undefined || type === undefined || binding === "other") {
      continue;
    }
    // The 4.x type stays inside: TrackedTransaction<Prisma.TransactionClient> is
    // TrackedTransaction<PrismaClient>, and no import changes but the wrapper's
    const fileWork = work.for(file);
    fileWork.edits.push({
      start: type.getStart(),
      end: type.getEnd(),
      text: `${wrapper}<${type.getText()}>`,
    });
    if (binding === "free") {
      fileWork.imports.push({ name: wrapper, from: PRISMA_MODULE, typeOnly: true });
    }
    ctx.stats.writersTyped += 1;
  }
}
