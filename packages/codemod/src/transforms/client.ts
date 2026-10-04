// The web app's 4.x hooks become members of the typed client:
//
//   useService("svc", "m", opts)                 qd.svc.m.useMutation(opts)
//   useServiceQuery("svc", "m", payload, opts)   qd.svc.m.useQuery(payload, opts)
//   useSubscription("svc", id, opts)             qd.svc.useEntity(id, opts)
//   useCollection("svc", "name", scope, opts)    qd.svc.name.useCollection(scope, opts)
//
// whether the call reaches quickdraw's hook directly or through the app's
// typed wrapper (the template's hooks/useService.ts and friends), which is
// deleted once nothing uses it, with a file of types only the wrappers
// imported (the template's hooks/service-types.ts). Options 5.0 dropped, a
// kind the contract disagrees with, and manual refetches are marked, never
// silently removed, as is a hook's `error` read as the 4.x message string
// (`error.includes(...)`): it is a `QuickdrawError` now. A file's local type
// that only a rewritten call's type arguments named goes, and 4.x's
// one-argument `UseCollectionResult<Item>` gets 5.0's second argument.

import { type CallExpression, type Identifier, Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { Work } from "../apply";
import type { RunContext } from "../context";
import { type Category, MarkerSet } from "../markers";
import type { MethodKind, ServicePlan } from "../plan";
import { isUnder } from "../project";
import { infraPaths } from "./infra";
import { resolveHook, WRAPPED } from "./hookResolution";
import { completeCollectionResults, deleteOrphanTypes, localTypesOf } from "./webTypes";

/** What the client transform knows of each migrated service. */
interface ServiceShape {
  readonly kinds: ReadonlyMap<string, MethodKind>;
  readonly hasEntity: boolean;
  /** The 4.x collections type (`BaseService`'s seventh type argument), when the service named one. */
  readonly collectionsType: string | undefined;
}

/**
 * Each hook's 4.x options that 5.0 dropped or changed, with what to do. Built
 * from entries: an object literal keyed by 4.x option names is what lint's
 * no-v4-api reports.
 */
const DROPPED: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    "useService",
    new Map([
      [
        "onError",
        "onError receives a QuickdrawError now (4.x passed the message string): read error.message or error.code",
      ],
      [
        "timeout",
        "the timeout option is gone: calls time out after the server's callTimeoutMs (plus 2 s)",
      ],
    ]),
  ],
  [
    "useServiceQuery",
    new Map([
      [
        "invalidateOn",
        "invalidateOn is gone: give the query a watch in its contract entry (it is fetched again when that collection scope changes), or read a collection",
      ],
      [
        "skipCache",
        "skipCache is gone: pass staleTime: 0, or read live data (useEntity, a collection)",
      ],
      ["onSuccess", "useQuery takes no onSuccess: derive it from data"],
      ["onError", "useQuery takes no onError: read error (a QuickdrawError)"],
    ]),
  ],
  [
    "useSubscription",
    new Map([
      ["onData", "useEntity takes no onData: read data"],
      ["onError", "useEntity takes no onError: read error (a QuickdrawError)"],
      [
        "requiredLevel",
        "useEntity takes no requiredLevel: the service's policy decides each subscriber's level",
      ],
    ]),
  ],
  [
    "useCollection",
    new Map([
      [
        "compare",
        "compare is gone: items follow the contract collection's order (put the sort there)",
      ],
      ["insertPosition", "insertPosition is gone: items follow the contract collection's order"],
      ["onDelta", "onDelta is gone: read items, which deltas keep current"],
      ["onError", "useCollection takes no onError: read error"],
    ]),
  ],
]);

/** Members of a string: a 4.x hook's `error` was the message, a 5.0 hook's is a `QuickdrawError`. */
const STRING_MEMBERS: ReadonlySet<string> = new Set([
  "includes",
  "toLowerCase",
  "toUpperCase",
  "startsWith",
  "endsWith",
  "split",
  "trim",
  "match",
  "replace",
  "replaceAll",
  "indexOf",
  "slice",
  "substring",
  "charAt",
  "localeCompare",
  "length",
]);

/** The other identifiers of `binding`'s file that refer to it. */
function referencesOf(binding: Identifier): Identifier[] {
  const symbol = binding.getSymbol();
  if (symbol === undefined) {
    return [];
  }
  return binding
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter(
      (identifier) =>
        identifier !== binding &&
        identifier.getText() === binding.getText() &&
        identifier.getSymbol() === symbol,
    );
}

/** The uses of a hook call's `error`: `const { error } = hook(...)`, or `result.error`. */
function errorUses(call: CallExpression): Node[] {
  const declaration = call.getParent();
  if (!Node.isVariableDeclaration(declaration)) {
    return [];
  }
  const name = declaration.getNameNode();
  if (Node.isObjectBindingPattern(name)) {
    return name.getElements().flatMap((element) => {
      const key = element.getPropertyNameNode()?.getText() ?? element.getName();
      const local = element.getNameNode();
      return key === "error" && Node.isIdentifier(local) ? referencesOf(local) : [];
    });
  }
  if (!Node.isIdentifier(name)) {
    return [];
  }
  return referencesOf(name).flatMap((reference) => {
    const parent = reference.getParent();
    return Node.isPropertyAccessExpression(parent) && parent.getName() === "error" ? [parent] : [];
  });
}

function literalArg(call: CallExpression, index: number): string | undefined {
  const arg = call.getArguments()[index];
  return arg !== undefined && Node.isStringLiteral(arg) ? arg.getLiteralValue() : undefined;
}

class FileRewrite {
  readonly markers: MarkerSet;
  rewrote = false;

  constructor(
    readonly file: SourceFile,
    readonly work: Work,
    private readonly services: ReadonlyMap<string, ServiceShape>,
  ) {
    this.markers = new MarkerSet(file);
  }

  mark(node: Node, message: string, category: Category = "client"): void {
    this.markers.add(node, category, message);
  }

  /**
   * Replaces the callee and the arguments before `kept` with `callee(`, so
   * edits inside the kept arguments (markers, nested rewrites) survive. The
   * file's own types that only the call's type arguments named go too.
   */
  private replace(call: CallExpression, callee: string, kept: number): void {
    for (const name of localTypesOf(call)) {
      this.work.for(this.file).dropIfUnused.add(name);
    }
    const first = call.getArguments()[kept];
    const open = call.getFirstChildByKindOrThrow(SyntaxKind.OpenParenToken);
    const firstArg = call.getArguments()[0];
    const gap =
      firstArg === undefined
        ? ""
        : this.file.getFullText().slice(open.getEnd(), firstArg.getStart());
    const edit =
      first === undefined
        ? { start: call.getStart(), end: call.getEnd(), text: `${callee}()` }
        : { start: call.getStart(), end: first.getStart(), text: `${callee}(${gap}` };
    this.work.for(this.file).edits.push(edit);
    this.rewrote = true;
  }

  private markOptions(call: CallExpression, hook: string, index: number): void {
    const options = call.getArguments()[index];
    if (options === undefined) {
      return;
    }
    if (!Node.isObjectLiteralExpression(options)) {
      this.mark(call, "options passed by reference: check them against the 5.0 hook's options");
      return;
    }
    const dropped = DROPPED.get(hook) ?? new Map<string, string>();
    for (const property of options.getProperties()) {
      const name =
        Node.isPropertyAssignment(property) ||
        Node.isShorthandPropertyAssignment(property) ||
        Node.isMethodDeclaration(property)
          ? property.getName()
          : "";
      const message = dropped.get(name);
      if (message !== undefined) {
        this.mark(call, message);
      }
    }
  }

  /**
   * The codemod declares no collection (the report lists each 4.x one), so
   * until the contract does, the member does not exist; a cast to the 4.x
   * item type keeps that one error from spreading through the component.
   */
  private castCollection(
    call: CallExpression,
    service: string,
    member: string,
    shape: ServiceShape,
  ): void {
    const typeArg = call.getTypeArguments()[0]?.getText();
    const item =
      typeArg ??
      (shape.collectionsType === undefined
        ? undefined
        : `${shape.collectionsType}[${JSON.stringify(member)}]["item"]`);
    const until = `declare the collection "${member}" in the ${service} contract (see the [collection] marker where 4.x defined it): qd.${service}.${member} does not exist until then`;
    if (item === undefined) {
      this.mark(call, until);
      return;
    }
    this.mark(
      call,
      `${until}, and the cast to the 4.x item type stands in for its type; delete the cast once it is declared`,
    );
    this.work.for(this.file).edits.push({
      start: call.getEnd(),
      end: call.getEnd(),
      text: ` as UseCollectionResult<${item}, { readonly id: string }>`,
    });
    this.work.for(this.file).imports.push({
      name: "UseCollectionResult",
      from: "@fitzzero/quickdraw-core/client",
      typeOnly: true,
    });
    if (typeArg === undefined && shape.collectionsType !== undefined) {
      this.collectionTypes.add(shape.collectionsType);
    }
  }

  /** 4.x collection types the casts name, imported from the shared package. */
  readonly collectionTypes = new Set<string>();

  /** Marks where the hook's `error` is read as the 4.x message string (`error.includes(...)`). */
  private markStringErrors(call: CallExpression): void {
    for (const use of errorUses(call)) {
      const parent = use.getParent();
      if (
        Node.isPropertyAccessExpression(parent) &&
        parent.getExpression() === use &&
        STRING_MEMBERS.has(parent.getName())
      ) {
        this.mark(
          parent,
          "error is a QuickdrawError now (4.x: the message string): read error.message, or error.code (FORBIDDEN, NOT_FOUND, ...) to tell failures apart",
        );
      }
    }
  }

  /** Rewrites one hook call, or marks why it cannot. */
  rewrite(call: CallExpression, hook: string): boolean {
    const service = literalArg(call, 0);
    const member = hook === "useSubscription" ? "" : literalArg(call, 1);
    const shape = service === undefined ? undefined : this.services.get(service);
    if (service === undefined || member === undefined || shape === undefined) {
      const why =
        service !== undefined && member !== undefined
          ? `no contract was written for "${service}"`
          : "it names the service or method at run time";
      this.mark(
        call,
        `this 4.x hook call was not converted: ${why}. Call the typed client's member (qd.<service>.<method>) instead`,
      );
      return false;
    }
    if (hook === "useSubscription") {
      if (!shape.hasEntity) {
        this.mark(call, `${service} has no entity (no model), so its client has no useEntity`);
      }
      this.markOptions(call, hook, 2);
      this.replace(call, `qd.${service}.useEntity`, 1);
      this.markStringErrors(call);
      return true;
    }
    if (hook === "useCollection") {
      this.markOptions(call, hook, 3);
      this.replace(call, `qd.${service}.${member}.useCollection`, 2);
      this.castCollection(call, service, member, shape);
      this.markStringErrors(call);
      return true;
    }
    const query = hook === "useServiceQuery";
    const kind = shape.kinds.get(member);
    if (kind === undefined) {
      this.mark(call, `${service} has no method "${member}" in its contract`);
    } else if (query && kind === "mutation") {
      this.mark(
        call,
        `${member} was classified as a mutation, which has no useQuery: reclassify it as a query in the contract if it only reads`,
      );
    } else if (!query && kind === "query") {
      this.mark(
        call,
        `${member} was classified as a query, which has useQuery, call and key but no useMutation: reclassify it in the contract, or call qd.${service}.${member}.call(input) from the event handler`,
      );
    }
    this.markOptions(call, query ? "useServiceQuery" : "useService", query ? 3 : 2);
    this.replace(call, `qd.${service}.${member}.${query ? "useQuery" : "useMutation"}`, 2);
    this.markStringErrors(call);
    return true;
  }
}

function markRefetches(rewrite: FileRewrite): void {
  for (const call of rewrite.file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
    if (name === "refetch") {
      rewrite.mark(
        call,
        "manual refetch: live data, watch and the invalidation coordinator keep quickdraw queries current; delete it, or give the query a watch",
      );
    }
  }
}

const OTHER_HOOKS: Readonly<Record<string, string>> = {
  useRoomEvents:
    "room events: declare them in the contract's events and listen with qd.<service>.<event>.useEvent(handler)",
  useChannelSend:
    "channels: declare them in the contract's channels and send with qd.<service>.<channel>.useChannel()",
};

/** Rewrites the 4.x hook calls of the web app; returns the wrappers that may now be deleted. */
export function migrateClient(
  ctx: RunContext,
  plans: readonly ServicePlan[],
  work: Work,
): Map<string, boolean> {
  const web = ctx.layout.web;
  const wrappers = new Map<string, boolean>();
  if (web === undefined) {
    return wrappers;
  }
  const services = new Map(
    plans.map((plan) => [
      plan.service.serviceName,
      {
        kinds: new Map(plan.methods.map((method) => [method.name, method.kind])),
        hasEntity: plan.entity !== undefined,
        collectionsType: plan.service.collectionsName,
      },
    ]),
  );
  const client = infraPaths(ctx).client;
  for (const file of ctx.project.getSourceFiles()) {
    if (!isUnder(file, web.src) || file.getFilePath() === client) {
      continue;
    }
    const rewrite = new FileRewrite(file, work, services);
    for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
      visitIdentifier(identifier, rewrite, wrappers);
    }
    markRefetches(rewrite);
    completeCollectionResults(file, work);
    work.for(file).edits.push(...rewrite.markers.edits);
    for (const type of rewrite.collectionTypes) {
      work.for(file).imports.push({ name: type, from: ctx.layout.shared.name, typeOnly: true });
    }
    if (rewrite.rewrote && client !== undefined) {
      work.for(file).imports.push({ name: "qd", from: client });
      work.for(file).tidy = true;
      ctx.stats.clientCalls += 1;
    }
  }
  return wrappers;
}

/** Whether an identifier only names something (a specifier, a declaration, a property) rather than using it. */
function isNaming(identifier: Identifier): boolean {
  const parent = identifier.getParent();
  return (
    identifier.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) !== undefined ||
    identifier.getFirstAncestorByKind(SyntaxKind.ExportDeclaration) !== undefined ||
    (Node.isFunctionDeclaration(parent) && parent.getNameNode() === identifier) ||
    (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) ||
    (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier)
  );
}

function visitIdentifier(
  identifier: Identifier,
  rewrite: FileRewrite,
  wrappers: Map<string, boolean>,
): void {
  const name = identifier.getText();
  if ((!WRAPPED.has(name) && OTHER_HOOKS[name] === undefined) || isNaming(identifier)) {
    return;
  }
  const parent = identifier.getParent();
  const isCall = Node.isCallExpression(parent) && parent.getExpression() === identifier;
  const resolved = resolveHook(identifier);
  if (resolved === undefined) {
    return;
  }
  const other = OTHER_HOOKS[resolved.hook];
  let converted = false;
  if (isCall && other !== undefined) {
    rewrite.mark(parent, other);
  } else if (isCall) {
    converted = rewrite.rewrite(
      parent,
      resolved.hook === "useServiceMethod" ? "useService" : resolved.hook,
    );
  }
  if (resolved.wrapper !== undefined) {
    const key = resolved.wrapper;
    wrappers.set(key, (wrappers.get(key) ?? true) && converted);
  }
}

/** Whether any other file still imports `name` from `file` (an import, not a re-export). */
function importedFrom(ctx: RunContext, file: SourceFile, name: string): boolean {
  return ctx.project
    .getSourceFiles()
    .some((other) =>
      other
        .getImportDeclarations()
        .some(
          (declaration) =>
            declaration.getModuleSpecifierSourceFile() === file &&
            declaration.getNamedImports().some((specifier) => specifier.getName() === name),
        ),
    );
}

function removeReExports(ctx: RunContext, file: SourceFile, names: ReadonlySet<string>): void {
  for (const other of ctx.project.getSourceFiles()) {
    for (const declaration of other.getExportDeclarations()) {
      if (declaration.getModuleSpecifierSourceFile() !== file) {
        continue;
      }
      for (const specifier of declaration.getNamedExports()) {
        if (names.has(specifier.getName())) {
          specifier.remove();
        }
      }
      if (declaration.getNamedExports().length === 0 && !declaration.wasForgotten()) {
        declaration.remove();
      }
    }
  }
}

/** Barrels re-exporting quickdraw's 4.x hooks drop the ones nothing imports any more. */
function trimCoreReExports(ctx: RunContext): void {
  for (const file of ctx.project.getSourceFiles()) {
    for (const declaration of file.getExportDeclarations()) {
      if (declaration.getModuleSpecifierValue() !== "@fitzzero/quickdraw-core/client") {
        continue;
      }
      for (const specifier of declaration.getNamedExports()) {
        const exported = specifier.getAliasNode()?.getText() ?? specifier.getName();
        if (
          WRAPPED.has(specifier.getName()) &&
          !OTHER_HOOKS[specifier.getName()] &&
          !importedFrom(ctx, file, exported)
        ) {
          specifier.remove();
        }
      }
      if (declaration.getNamedExports().length === 0 && !declaration.wasForgotten()) {
        declaration.remove();
      }
    }
  }
}

/**
 * Deletes the app's wrapper hooks that every call site stopped using, with
 * their barrels' re-exports and the files of types only they imported. Runs
 * after the rewrites are applied.
 */
export function deleteWrappers(ctx: RunContext, wrappers: ReadonlyMap<string, boolean>): void {
  const byFile = new Map<string, Set<string>>();
  for (const [key, converted] of wrappers) {
    const [path = "", name = ""] = key.split("#");
    const names = byFile.get(path) ?? new Set<string>();
    if (converted) {
      names.add(name);
    }
    byFile.set(path, names);
  }
  const typeFiles = new Set<SourceFile>();
  for (const [path, names] of byFile) {
    const file = ctx.project.getSourceFile(path);
    if (file === undefined || names.size === 0) {
      continue;
    }
    const exported = [...file.getExportedDeclarations().keys()];
    const others = exported.filter((name) => !names.has(name) && importedFrom(ctx, file, name));
    if (others.length > 0 || [...names].some((name) => importedFrom(ctx, file, name))) {
      continue;
    }
    removeReExports(ctx, file, new Set(exported));
    for (const declaration of file.getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target !== undefined && declaration.getModuleSpecifierValue().startsWith(".")) {
        typeFiles.add(target);
      }
    }
    ctx.deleted.add(path);
    ctx.stats.wrappersDeleted += 1;
    file.delete();
  }
  deleteOrphanTypes(ctx, typeFiles);
  trimCoreReExports(ctx);
}

/** `service.method` for every method the web app reads with useServiceQuery: those are queries. */
export function queriedMethods(ctx: RunContext): Set<string> {
  const queried = new Set<string>();
  const web = ctx.layout.web;
  if (web === undefined) {
    return queried;
  }
  for (const file of ctx.project.getSourceFiles()) {
    if (!isUnder(file, web.src)) {
      continue;
    }
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (
        callee.getText() === "useServiceQuery" ||
        resolveHook(callee)?.hook === "useServiceQuery"
      ) {
        const service = literalArg(call, 0);
        const method = literalArg(call, 1);
        if (service !== undefined && method !== undefined) {
          queried.add(`${service}.${method}`);
        }
      }
    }
  }
  return queried;
}
