// Reads the 4.x services of the api package: every class that extends
// `BaseService` or `BaseRpcService` (directly, or through an app's abstract
// `*ServiceCore`), what its constructor declares (service name, model,
// `hasEntryACL`), the hooks it overrides, and every `defineMethod` call that
// registers on it, whether inside the class or in a method module
// (`registerX(service)`, the 4.1 README's "Splitting Large Services").
// Test code is not read for services (`isTestFile`), and when several
// classes carry one service name, one is chosen: the class `registerService`
// instantiates, else the one named after the service, else the first by file.

import {
  type ArrowFunction,
  type CallExpression,
  type ClassDeclaration,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type NewExpression,
  Node,
  type Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import { importOf } from "./imports";
import { type Layout, repoPath } from "./layout";
import { isTestFile, isUnder } from "./project";
import { lowerFirst, upperFirst } from "./text";

const CORE_SERVER = "@fitzzero/quickdraw-core/server";
const BASES = new Set(["BaseService", "BaseRpcService"]);

/** A 4.x access level. */
export type Level = "Public" | "Read" | "Moderate" | "Admin";

const LEVELS = new Set<string>(["Public", "Read", "Moderate", "Admin"]);

/** One `defineMethod(name, level, handler, { schema, resolveEntryId })` call. */
export interface MethodCall {
  readonly call: CallExpression;
  readonly name: string;
  readonly level: Level | undefined;
  readonly levelText: string;
  readonly handler: ArrowFunction | FunctionExpression | undefined;
  readonly handlerArg: Expression | undefined;
  readonly schema: Expression | undefined;
  readonly resolveEntryId: Expression | undefined;
  /** `"this"` inside the class, else the parameter the call is made on. */
  readonly receiver: string;
  /** The method module's `registerX(service)` function, for a call outside the class. */
  readonly register: FunctionDeclaration | undefined;
}

/** A 4.x service: its classes, what they declare, and its methods. */
export interface ServiceModel {
  /** The class that is instantiated, then its ancestors up to the one extending BaseService. */
  readonly chain: readonly ClassDeclaration[];
  readonly className: string;
  readonly serviceName: string;
  /** True when no `serviceName` literal was found and the name came from the class. */
  readonly nameGuessed: boolean;
  readonly rpc: boolean;
  /** The Prisma model of `setDelegate(prisma.<model>)`. */
  readonly model: string | undefined;
  /** Whether the 4.x service passed `hasEntryACL: true`, so 4.x read the row's `acl` column. */
  readonly readsAclColumn: boolean;
  /** The 4.x hooks the classes override, by name. */
  readonly overrides: ReadonlySet<string>;
  /** The method map type (`ChatServiceMethods`) and the DTO type (`ChatDTO`) of `BaseService<...>`. */
  readonly methodMapName: string | undefined;
  readonly dtoName: string | undefined;
  /** The collections type of `BaseService<...>` (`ChatCollections`), when it names one. */
  readonly collectionsName: string | undefined;
  readonly methods: readonly MethodCall[];
  /** The fields that hold the Prisma client (`this.prisma`). */
  readonly prismaFields: ReadonlySet<string>;
  /** Other instantiable classes with the same service name, whose defineMethod calls were not read. */
  readonly shadowed: readonly ClassDeclaration[];
}

/** The class a class extends, when it is one of the project's. */
function parentClass(cls: ClassDeclaration): ClassDeclaration | undefined {
  const heritage = cls.getExtends();
  const expression = heritage?.getExpression();
  if (expression === undefined || !Node.isIdentifier(expression)) {
    return undefined;
  }
  const local = cls.getSourceFile().getClass(expression.getText());
  if (local !== undefined) {
    return local;
  }
  const declaration = expression.getSymbol()?.getAliasedSymbol()?.getDeclarations()[0];
  return declaration !== undefined && Node.isClassDeclaration(declaration)
    ? declaration
    : undefined;
}

/** `"BaseService"` or `"BaseRpcService"` when the class extends quickdraw's own directly. */
function directBase(cls: ClassDeclaration): string | undefined {
  const expression = cls.getExtends()?.getExpression();
  if (expression === undefined || !Node.isIdentifier(expression)) {
    return undefined;
  }
  const found = importOf(cls.getSourceFile(), expression.getText());
  return found?.module === CORE_SERVER && BASES.has(found.imported) ? found.imported : undefined;
}

/** The class and its ancestors up to the one extending quickdraw's base, or undefined. */
function chainOf(cls: ClassDeclaration): ClassDeclaration[] | undefined {
  const chain: ClassDeclaration[] = [cls];
  let current: ClassDeclaration | undefined = cls;
  while (current !== undefined && chain.length < 10) {
    if (directBase(current) !== undefined) {
      return chain;
    }
    current = parentClass(current);
    if (current !== undefined) {
      chain.push(current);
    }
  }
  return undefined;
}

/** Whether `cls` is a 4.x service class: it extends `BaseService` or `BaseRpcService`, directly or not. */
export function isServiceClass(cls: ClassDeclaration): boolean {
  return chainOf(cls) !== undefined;
}

/** A string literal's value. */
function literal(node: Node | undefined): string | undefined {
  return node !== undefined && Node.isStringLiteral(node) ? node.getLiteralValue() : undefined;
}

/** The value of `key` in the object literals passed to the chain's `super(...)` calls. */
function superOption(chain: readonly ClassDeclaration[], key: string): Node | undefined {
  for (const cls of chain) {
    for (const call of cls.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const [options] = call.getArguments();
      if (call.getExpression().getKind() !== SyntaxKind.SuperKeyword) {
        continue;
      }
      if (options !== undefined && Node.isObjectLiteralExpression(options)) {
        const property = options.getProperty(key);
        if (property !== undefined && Node.isPropertyAssignment(property)) {
          return property.getInitializer();
        }
      }
    }
  }
  return undefined;
}

/** Calls of `this.<name>(...)` inside the chain's classes. */
function thisCalls(chain: readonly ClassDeclaration[], name: string): CallExpression[] {
  return chain.flatMap((cls) =>
    cls.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
      const callee = call.getExpression();
      return (
        Node.isPropertyAccessExpression(callee) &&
        callee.getExpression().getKind() === SyntaxKind.ThisKeyword &&
        callee.getName() === name
      );
    }),
  );
}

/** The model of `this.setDelegate(prisma.<model>)`. */
function modelOf(chain: readonly ClassDeclaration[]): string | undefined {
  const [call] = thisCalls(chain, "setDelegate");
  const [argument] = call?.getArguments() ?? [];
  return argument !== undefined && Node.isPropertyAccessExpression(argument)
    ? argument.getName()
    : undefined;
}

const PRISMA_TYPE = /PrismaClient/u;

/** The fields holding the Prisma client: typed `PrismaClient`, or assigned a parameter that is. */
function prismaFieldsOf(chain: readonly ClassDeclaration[]): Set<string> {
  const fields = new Set<string>();
  for (const cls of chain) {
    for (const property of cls.getProperties()) {
      if (PRISMA_TYPE.test(property.getTypeNode()?.getText() ?? "")) {
        fields.add(property.getName());
      }
    }
    for (const constructor of cls.getConstructors()) {
      const prismaParams = new Set(
        constructor
          .getParameters()
          .filter((param) => PRISMA_TYPE.test(param.getTypeNode()?.getText() ?? ""))
          .map((param) => param.getName()),
      );
      for (const param of constructor.getParameters()) {
        if (param.isParameterProperty() && prismaParams.has(param.getName())) {
          fields.add(param.getName());
        }
      }
      for (const assignment of constructor.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        const left = assignment.getLeft();
        const right = assignment.getRight();
        if (
          Node.isPropertyAccessExpression(left) &&
          left.getExpression().getKind() === SyntaxKind.ThisKeyword &&
          prismaParams.has(right.getText())
        ) {
          fields.add(left.getName());
        }
      }
    }
  }
  return fields;
}

/** Names of the 4.x hooks the 4.x base class lets a service override. */
export const OVERRIDABLE = new Set([
  "checkAccess",
  "checkEntryACL",
  "checkSubscriptionAccess",
  "checkBatchSubscriptionAccess",
  "hasServiceAccess",
  "toDto",
  "getProtectedFields",
  "hasElevatedAccess",
  "beforeCreate",
  "afterCreate",
  "beforeUpdate",
  "afterUpdate",
  "beforeDelete",
  "afterDelete",
]);

function overridesOf(chain: readonly ClassDeclaration[]): Set<string> {
  return new Set(
    chain.flatMap((cls) =>
      cls
        .getMethods()
        .map((method) => method.getName())
        .filter((name) => OVERRIDABLE.has(name)),
    ),
  );
}

/** The type argument names of `extends BaseService<...>`: the method map, the DTO and the collections. */
function typeArgumentsOf(root: ClassDeclaration): {
  methodMap?: string;
  dto?: string;
  collections?: string;
} {
  const base = directBase(root);
  const args =
    root
      .getExtends()
      ?.getTypeArguments()
      .map((arg) => arg.getText()) ?? [];
  if (base === "BaseRpcService") {
    return { methodMap: args[0] };
  }
  return { methodMap: args[3], dto: args[5] ?? args[0], collections: args[6] };
}

function methodCallFrom(call: CallExpression, receiver: string): MethodCall | undefined {
  const [nameArg, levelArg, handlerArg, optionsArg] = call.getArguments();
  const name = literal(nameArg);
  if (name === undefined || levelArg === undefined) {
    return undefined;
  }
  const levelText = literal(levelArg) ?? levelArg.getText();
  const options =
    optionsArg !== undefined && Node.isObjectLiteralExpression(optionsArg) ? optionsArg : undefined;
  const option = (key: string): Expression | undefined => {
    const property = options?.getProperty(key);
    return property !== undefined && Node.isPropertyAssignment(property)
      ? property.getInitializer()
      : undefined;
  };
  const handler =
    handlerArg !== undefined &&
    (Node.isArrowFunction(handlerArg) || Node.isFunctionExpression(handlerArg))
      ? handlerArg
      : undefined;
  return {
    call,
    name,
    level: LEVELS.has(levelText) ? (levelText as Level) : undefined,
    levelText,
    handler,
    handlerArg: handlerArg as Expression | undefined,
    schema: option("schema"),
    resolveEntryId: option("resolveEntryId"),
    receiver,
    register:
      receiver === "this" ? undefined : call.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration),
  };
}

/** `defineMethod` calls on a parameter typed as one of the chain's classes, in other api files. */
function moduleCalls(
  project: Project,
  layout: Layout,
  chain: readonly ClassDeclaration[],
): MethodCall[] {
  const names = new Set(chain.map((cls) => cls.getName() ?? ""));
  const own = new Set(chain.map((cls) => cls.getSourceFile()));
  const calls: MethodCall[] = [];
  for (const file of project.getSourceFiles()) {
    if (
      !isUnder(file, layout.api.src) ||
      own.has(file) ||
      isTestFile(repoPath(layout, file.getFilePath()))
    ) {
      continue;
    }
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "defineMethod") {
        continue;
      }
      const receiver = callee.getExpression();
      const declaration = receiver.getSymbol()?.getDeclarations()[0];
      if (
        declaration !== undefined &&
        Node.isParameterDeclaration(declaration) &&
        names.has(declaration.getTypeNode()?.getText() ?? "")
      ) {
        const method = methodCallFrom(call, receiver.getText());
        if (method !== undefined) {
          calls.push(method);
        }
      }
    }
  }
  return calls;
}

function modelFor(project: Project, layout: Layout, chain: ClassDeclaration[]): ServiceModel {
  const [leaf] = chain;
  const root = chain.at(-1) ?? leaf;
  if (leaf === undefined || root === undefined) {
    throw new Error("quickdraw-codemod: empty class chain");
  }
  const className = leaf.getName() ?? "Service";
  const literalName = literal(superOption(chain, "serviceName"));
  const own = thisCalls(chain, "defineMethod")
    .map((call) => methodCallFrom(call, "this"))
    .filter((method): method is MethodCall => method !== undefined);
  const { methodMap, dto, collections } = typeArgumentsOf(root);
  return {
    chain,
    className,
    serviceName: literalName ?? lowerFirst(className),
    nameGuessed: literalName === undefined,
    rpc: directBase(root) === "BaseRpcService",
    model: modelOf(chain),
    readsAclColumn: superOption(chain, "hasEntryACL")?.getKind() === SyntaxKind.TrueKeyword,
    overrides: overridesOf(chain),
    methodMapName: methodMap,
    dtoName: dto,
    collectionsName:
      collections !== undefined && /^\w+$/u.test(collections) ? collections : undefined,
    methods: [...own, ...moduleCalls(project, layout, chain)],
    prismaFields: prismaFieldsOf(chain),
    shadowed: [],
  };
}

/** The api package's source files outside test code. */
function apiFiles(project: Project, layout: Layout): SourceFile[] {
  return project
    .getSourceFiles()
    .filter(
      (file) => isUnder(file, layout.api.src) && !isTestFile(repoPath(layout, file.getFilePath())),
    );
}

/** The 4.x service classes of the api package's test code, each with its chain: the codemod reads no service from them. */
export function findTestServiceClasses(
  project: Project,
  layout: Layout,
): (readonly ClassDeclaration[])[] {
  return project
    .getSourceFiles()
    .filter(
      (file) => isUnder(file, layout.api.src) && isTestFile(repoPath(layout, file.getFilePath())),
    )
    .flatMap((file) => file.getClasses())
    .flatMap((cls) => {
      const chain = chainOf(cls);
      return chain === undefined ? [] : [chain];
    });
}

/** The `new X(...)` that `node` is, or that the variable `node` names was initialized with. */
function newExpressionOf(node: Node | undefined): NewExpression | undefined {
  if (node === undefined || Node.isNewExpression(node)) {
    return node;
  }
  if (!Node.isIdentifier(node)) {
    return undefined;
  }
  const declaration = node.getSymbol()?.getDeclarations()[0];
  const initializer =
    declaration !== undefined && Node.isVariableDeclaration(declaration)
      ? declaration.getInitializer()
      : undefined;
  return initializer !== undefined && Node.isNewExpression(initializer) ? initializer : undefined;
}

/** The class a `new` expression instantiates, when it is one of the project's. */
function instantiated(created: NewExpression): ClassDeclaration | undefined {
  const symbol = created.getExpression().getSymbol();
  const target = symbol?.isAlias() === true ? symbol.getAliasedSymbol() : symbol;
  const declaration = target?.getDeclarations()[0];
  return declaration !== undefined && Node.isClassDeclaration(declaration)
    ? declaration
    : undefined;
}

/** The class each `registerService("<name>", instance)` call registers, by service name. */
function registeredClasses(files: readonly SourceFile[]): Map<string, ClassDeclaration> {
  const registered = new Map<string, ClassDeclaration>();
  for (const file of files) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "registerService") {
        continue;
      }
      const [name, instance] = call.getArguments();
      const serviceName = literal(name);
      const created = newExpressionOf(instance);
      const cls = created === undefined ? undefined : instantiated(created);
      if (serviceName !== undefined && cls !== undefined && !registered.has(serviceName)) {
        registered.set(serviceName, cls);
      }
    }
  }
  return registered;
}

/**
 * The one model of a service name several classes carry: the class
 * `registerService` instantiates, else the one named after the service
 * (`TaskService` for `taskService`), else the first by file and name. The
 * others are `shadowed`.
 */
function choose(
  models: readonly ServiceModel[],
  registered: ReadonlyMap<string, ClassDeclaration>,
): ServiceModel {
  const rank = (model: ServiceModel): [number, number, string] => {
    const [leaf] = model.chain;
    return [
      registered.get(model.serviceName) === leaf ? 0 : 1,
      model.className === upperFirst(model.serviceName) ? 0 : 1,
      `${leaf?.getSourceFile().getFilePath() ?? ""}:${model.className}`,
    ];
  };
  const [chosen, ...others] = models.toSorted((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
  });
  if (chosen === undefined) {
    throw new Error("quickdraw-codemod: no class for a service");
  }
  return {
    ...chosen,
    shadowed: others.flatMap((model) => model.chain.slice(0, 1)),
  };
}

/**
 * Every 4.x service of the api package: one per service name, read from a
 * class that is instantiated (not abstract, not extended) outside test code.
 */
export function findServices(project: Project, layout: Layout): ServiceModel[] {
  const files = apiFiles(project, layout);
  const chains = new Map<ClassDeclaration, ClassDeclaration[]>();
  for (const file of files) {
    for (const cls of file.getClasses()) {
      const chain = chainOf(cls);
      if (chain !== undefined) {
        chains.set(cls, chain);
      }
    }
  }
  const extended = new Set([...chains.values()].flatMap((chain) => chain.slice(1)));
  const byName = new Map<string, ServiceModel[]>();
  for (const [cls, chain] of chains) {
    if (extended.has(cls) || cls.isAbstract()) {
      continue;
    }
    const model = modelFor(project, layout, chain);
    byName.set(model.serviceName, [...(byName.get(model.serviceName) ?? []), model]);
  }
  const registered = registeredClasses(files);
  return [...byName.values()]
    .map((models) => choose(models, registered))
    .toSorted((a, b) => a.serviceName.localeCompare(b.serviceName));
}

/** The files a service's classes live in. */
export function serviceFiles(service: ServiceModel): SourceFile[] {
  return [...new Set(service.chain.map((cls) => cls.getSourceFile()))];
}
