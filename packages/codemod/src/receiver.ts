// What becomes of `this.<member>` (or `service.<member>` in a method module)
// once a service is an object instead of a class. Mechanical cases are
// rewritten: the Prisma field becomes the tracked `db`, `getDelegate()` and
// `findById` become `db.<model>` calls, helper methods become the module
// functions they were hoisted into, `this.logger` in a handler becomes
// `ctx.log`. Everything else stays as written, under a marker that says what
// replaces it, because it needs a decision: hand emits, the CRUD helpers
// (which also emitted and ran lifecycle hooks), injected services.

import { Node, type PropertyAccessExpression, type SourceFile, SyntaxKind } from "ts-morph";
import type { Category } from "./markers";
import type { ServiceModel } from "./model";
import type { Edit } from "./text";
import { quote } from "./text";

/** A class member hoisted into a module-level function or const. */
export interface Hoisted {
  readonly name: string;
  readonly file: SourceFile;
  readonly exported: boolean;
}

/** Where the code being mapped sits. */
export interface ReceiverScope {
  readonly service: ServiceModel;
  readonly hoisted: ReadonlyMap<string, Hoisted>;
  /** `"this"`, or the method module's parameter name. */
  readonly receiver: string;
  /** The method module's parameter itself, so a nested parameter of the same name is not it. */
  readonly receiverParam?: Node | undefined;
  /** Whether the code is a method handler, which has `ctx`. */
  readonly inHandler: boolean;
  /** What the handler calls its context. */
  readonly ctxName: string;
}

/** A marker to place above the statement holding `node`. */
export interface PendingMarker {
  readonly node: Node;
  readonly category: Category;
  readonly message: string;
}

/** The edits and markers for the receiver references under one node. */
export interface ReceiverResult {
  readonly edits: Edit[];
  readonly markers: PendingMarker[];
  /** Hoisted members of other files the code now calls. */
  readonly imports: Hoisted[];
  usesDb: boolean;
  usesCtx: boolean;
}

const TRACKED =
  "write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract";

const EMITS: Readonly<Record<string, string>> = {
  emitUpdate:
    "hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db",
  emitCollectionUpsert: `hand emit: 5.0 sends collection deltas from tracked writes; ${TRACKED}`,
  emitCollectionRemove: `hand emit: 5.0 sends collection deltas from tracked writes; ${TRACKED}`,
  emitCollectionMove: `hand emit: 5.0 sends collection deltas from tracked writes; ${TRACKED}`,
  notifyCollections: `hand emit: 5.0 sends collection deltas from tracked writes; ${TRACKED}`,
  emitCollectionReset:
    "hand emit: send a reset with qd.collections.reset(contract, collection, scope), if one is still needed",
  emitToRoom:
    "room event: declare it in the contract's events and send it with ctx.rooms.emit(room, contract, event, payload)",
  emitToUserRoom:
    "room event: declare it in the contract's events and send it with ctx.rooms.emitToUser(userId, contract, event, payload)",
  emitToRoomVolatile:
    "volatile room traffic: declare a stream with volatile: true in the contract and push to it",
  kickFromCollection:
    "revocation is automatic: a tracked write that lowers someone's access removes them from the scope; delete this",
};

/** 4.x service set-up calls met outside the constructor, by name. */
const CONSTRUCTION_MARKERS: Readonly<Record<string, { category: Category; message: string }>> = {
  installAdminMethods: {
    category: "admin",
    message:
      "installAdminMethods: use the admin kit (...admin.contract({ entity }) in the contract, ...admin.handlers(contract, options) in methods)",
  },
  defineCollection: {
    category: "collection",
    message:
      "4.x collection: declare it in the contract's collections (scope, item, order) and anchor it in defineService's collections",
  },
  defineChannel: {
    category: "channel",
    message:
      "4.x channel: declare it in the contract's channels ({ payload, ratePerSecond, burst, requires }; requireRoom becomes requires: { room }) and handle it in defineService's channels",
  },
  defineMethod: {
    category: "contract",
    message:
      "a defineMethod call the codemod could not move (its name is not a literal): add the method to the contract and the service by hand",
  },
};

function writeMessage(name: string, model: string): string {
  const failure =
    name === "create"
      ? "db.create throws on failure"
      : `4.x returned ${name === "update" ? "null" : "false"} for a missing row where db.${name} throws NOT_FOUND`;
  return `4.x CRUD helper this.${name}: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.${model}.${name}(...) instead (frames follow the tracked write; hooks do not run; ${failure})`;
}

/** Whether `node` (a `this` keyword) belongs to `root`'s own `this`, not a nested function's. */
function ownThis(node: Node, root: Node): boolean {
  let current: Node | undefined = node.getParent();
  while (current !== undefined && current !== root) {
    if (
      Node.isFunctionExpression(current) ||
      Node.isFunctionDeclaration(current) ||
      Node.isMethodDeclaration(current) ||
      Node.isClassDeclaration(current) ||
      Node.isClassExpression(current) ||
      Node.isGetAccessorDeclaration(current) ||
      Node.isSetAccessorDeclaration(current) ||
      Node.isConstructorDeclaration(current)
    ) {
      return false;
    }
    current = current.getParent();
  }
  return true;
}

/** The receiver expressions under `root`: `this`, or the module's service parameter. */
function receivers(root: Node, scope: ReceiverScope): Node[] {
  if (scope.receiver === "this") {
    return root.getDescendantsOfKind(SyntaxKind.ThisKeyword).filter((node) => ownThis(node, root));
  }
  return root
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter((node) => {
      const declaration = node.getSymbol()?.getDeclarations()[0];
      return (
        node.getText() === scope.receiver &&
        declaration?.getKind() === SyntaxKind.Parameter &&
        (scope.receiverParam === undefined || declaration === scope.receiverParam)
      );
    })
    .filter((node) => {
      const parent = node.getParent();
      return !(Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node);
    });
}

function rewriteCall(
  access: PropertyAccessExpression,
  model: string | undefined,
): string | undefined {
  const call = access.getParent();
  if (model === undefined || !Node.isCallExpression(call) || call.getExpression() !== access) {
    return undefined;
  }
  const args = call.getArguments().map((arg) => arg.getText());
  if (args.some((arg) => /\bthis\b/u.test(arg))) {
    return undefined;
  }
  switch (access.getName()) {
    case "getDelegate":
      return `db.${model}`;
    case "findById":
      return args.length === 1
        ? `db.${model}.findUnique({ where: { id: ${args[0] ?? ""} } })`
        : undefined;
    case "findByIds":
      return args.length === 1
        ? `db.${model}.findMany({ where: { id: { in: ${args[0] ?? ""} } } })`
        : undefined;
    default:
      return undefined;
  }
}

/** Maps one `receiver.<name>` access. */
function mapAccess(
  access: PropertyAccessExpression,
  scope: ReceiverScope,
  result: ReceiverResult,
): void {
  const name = access.getName();
  const { service } = scope;
  const replace = (text: string, node: Node = access): void => {
    result.edits.push({ start: node.getStart(), end: node.getEnd(), text });
  };
  const call = rewriteCall(access, service.model);
  const hoisted = scope.hoisted.get(name);
  if (call !== undefined) {
    replace(call, access.getParentOrThrow());
    result.usesDb = true;
  } else if (service.prismaFields.has(name)) {
    replace("db");
    result.usesDb = true;
  } else if (name === "delegate" && service.model !== undefined) {
    replace(`db.${service.model}`);
    result.usesDb = true;
  } else if (name === "serviceName") {
    replace(quote(service.serviceName));
  } else if (hoisted !== undefined) {
    replace(hoisted.name);
    result.imports.push(hoisted);
  } else if (name === "logger" && scope.inHandler) {
    replace(`${scope.ctxName}.log`);
    result.usesCtx = true;
  } else {
    result.markers.push({ node: access, ...markerFor(name, service) });
  }
}

function markerFor(name: string, service: ServiceModel): { category: Category; message: string } {
  const emit = EMITS[name];
  if (emit !== undefined) {
    return { category: "emit", message: emit };
  }
  if (name === "create" || name === "update" || name === "delete") {
    return { category: "write", message: writeMessage(name, service.model ?? "<model>") };
  }
  if (name === "logger") {
    return {
      category: "this",
      message:
        "the 4.x service logger: take a Logger argument, or log from the handler that calls this with ctx.log",
    };
  }
  const construction = CONSTRUCTION_MARKERS[name];
  if (construction !== undefined) {
    return construction;
  }
  if (name === "isLevelSufficient" || name === "hasServiceAccess") {
    return {
      category: "access",
      message: `this.${name}: compare levels in a policy or a custom(fn) form (Public < Read < Moderate < Admin)`,
    };
  }
  return {
    category: "this",
    message: `this.${name} was 4.x service-instance state: a service object has none. Import what it held, pass it in, or call another service with ctx.services`,
  };
}

const RAW_WRITE = /\b(?:insert|update|delete|merge|truncate)\b/iu;

/** Raw SQL that writes: invisible to tracked writes, so subscribers would miss it. */
function markRawSql(root: Node, result: ReceiverResult): void {
  const calls = [
    ...root.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression),
    ...root.getDescendantsOfKind(SyntaxKind.CallExpression),
  ];
  for (const call of calls) {
    const callee = Node.isTaggedTemplateExpression(call) ? call.getTag() : call.getExpression();
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
    const writes =
      name.startsWith("$executeRaw") ||
      (name.startsWith("$queryRaw") && RAW_WRITE.test(call.getText()));
    if (writes) {
      result.markers.push({
        node: call,
        category: "raw-sql",
        message:
          "raw SQL write: tracked writes cannot see it, so subscribers would miss it; record the rows with ctx.touch(model, ids), or reset a scope with qd.collections.reset (lint: no-raw-sql-write)",
      });
    }
  }
}

/** Maps every receiver reference under `root`. */
export function mapReceiver(root: Node, scope: ReceiverScope): ReceiverResult {
  const result: ReceiverResult = {
    edits: [],
    markers: [],
    imports: [],
    usesDb: false,
    usesCtx: false,
  };
  markRawSql(root, result);
  for (const superKeyword of root.getDescendantsOfKind(SyntaxKind.SuperKeyword)) {
    result.markers.push({
      node: superKeyword,
      category: "this",
      message:
        "calls the 4.x base class, which 5.0 does not have: keep what this code still needs without it",
    });
  }
  for (const receiver of receivers(root, scope)) {
    const parent = receiver.getParent();
    if (
      parent !== undefined &&
      Node.isPropertyAccessExpression(parent) &&
      parent.getExpression() === receiver
    ) {
      mapAccess(parent, scope, result);
    } else {
      result.markers.push({
        node: receiver,
        category: "this",
        message:
          "uses the 4.x service instance itself, which no longer exists: pass what this code needs instead",
      });
    }
  }
  return result;
}
