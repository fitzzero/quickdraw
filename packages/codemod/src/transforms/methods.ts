// The methods of a migrated service. A method registered inside its class
// becomes an entry of `defineService`'s `methods`; one a method module
// registered (`registerX(service)`) stays in that module as an exported,
// typed method object, which `methods` lists by name.

import type { FunctionDeclaration, Node, SourceFile } from "ts-morph";
import { accessFor } from "../access";
import type { Work } from "../apply";
import type { RunContext } from "../context";
import { buildMethod } from "../handlers";
import { kitMarker } from "../kits";
import type { ServicePlan } from "../plan";
import type { Hoisted } from "../receiver";
import { infraPaths } from "./infra";
import {
  leadingCommentText,
  moduleConst,
  registerLeftoverMarker,
  startWithComments,
} from "./serviceText";

/**
 * The calls of converted functions (register functions and the aggregators
 * that call them, `aggregators.ts`): a function the run keeps loses them.
 */
export interface ConvertedCalls {
  /** `fn`'s statements that call a converted function, the callees they name, and `fn`'s text without them. */
  of(fn: FunctionDeclaration): {
    readonly statements: ReadonlySet<Node>;
    readonly callees: readonly string[];
    readonly text: string;
  };
}

/** A service's methods, built: entries of `methods`, and the method modules' objects. */
export interface ServiceBuild {
  readonly inline: string[];
  readonly modules: Map<FunctionDeclaration, string[]>;
  readonly moduleExports: { readonly name: string; readonly file: SourceFile }[];
  anyEntry: boolean;
}

/** Imports `imports` (hoisted members of other files) into `file`. */
export function addHoistedImports(work: Work, file: SourceFile, imports: readonly Hoisted[]): void {
  for (const hoisted of imports) {
    if (hoisted.file !== file) {
      work.for(file).imports.push({ name: hoisted.name, from: hoisted.file.getFilePath() });
    }
  }
}

/**
 * Builds every method of the service: inline entries, and method module
 * objects. A handler in one of `dbFiles` uses the tracked `db` its file
 * imports.
 */
export function buildMethods(
  ctx: RunContext,
  plan: ServicePlan,
  hoisted: ReadonlyMap<string, Hoisted>,
  work: Work,
  dbFiles: ReadonlySet<SourceFile> = new Set(),
): ServiceBuild {
  const build: ServiceBuild = {
    inline: [],
    modules: new Map(),
    moduleExports: [],
    anyEntry: false,
  };
  const leafFile = plan.service.chain[0]?.getSourceFile();
  const names = plan.methods.map((method) => method.name);
  for (const method of plan.methods) {
    const { call } = method;
    const form = accessFor(call.level, call.levelText, {
      entryId: method.entryId,
      rows: plan.service.model !== undefined,
      inputHasId: method.inputHasId,
    });
    build.anyEntry ||= form.entry;
    const entry = buildMethod(
      call,
      form,
      {
        service: plan.service,
        hoisted,
        receiver: call.receiver,
        receiverParam: call.register?.getParameters()[0],
        inHandler: true,
      },
      dbFiles.has(call.call.getSourceFile()),
      method.handlerNotes,
    );
    ctx.stats.methods += 1;
    const kit = kitMarker(method.name, plan.service.model, names);
    if (call.register === undefined) {
      build.inline.push(`${kit}${method.name}: ${entry.text},`);
      if (leafFile !== undefined) {
        addHoistedImports(work, leafFile, entry.imports);
      }
      continue;
    }
    const list = build.modules.get(call.register) ?? [];
    list.push(moduleConst(plan, method, entry, form.isPublic));
    build.modules.set(call.register, list);
    build.moduleExports.push({ name: method.name, file: call.register.getSourceFile() });
    build.inline.push(`${kit}${method.name},`);
    addHoistedImports(work, call.register.getSourceFile(), entry.imports);
  }
  return build;
}

/**
 * Replaces each method module's `registerX(service)` with its method objects.
 * Its calls of other register functions and of aggregators (`converted`) go
 * too: the run turns those into method objects, or removes them.
 */
export function convertModules(
  ctx: RunContext,
  plan: ServicePlan,
  build: ServiceBuild,
  work: Work,
  converted: ConvertedCalls,
): void {
  const quickdraw = infraPaths(ctx).quickdraw;
  for (const [register, consts] of build.modules) {
    const file = register.getSourceFile();
    const fileWork = work.for(file);
    const defineStatements = new Set(
      plan.methods
        .filter((method) => method.call.register === register)
        .map((method) => method.call.call.getParentOrThrow()),
    );
    const calls = converted.of(register);
    const leftovers = register
      .getStatements()
      .filter((statement) => !defineStatements.has(statement) && !calls.statements.has(statement));
    const marker = registerLeftoverMarker(register.getName() ?? "this function", calls.callees);
    const kept = leftovers.length === 0 ? [] : [`${marker}\n${calls.text}`];
    fileWork.edits.push({
      start: startWithComments(register),
      end: register.getEnd(),
      text: [...leadingCommentText(register), ...consts, ...kept].join("\n\n"),
    });
    for (const helper of new Set(
      consts.map((text) =>
        text.includes("satisfies PublicMethodOf<") ? "PublicMethodOf" : "MethodOf",
      ),
    )) {
      fileWork.imports.push({ name: helper, from: quickdraw, typeOnly: true });
    }
    fileWork.imports.push({ name: plan.contractVar, from: ctx.layout.shared.name, typeOnly: true });
    fileWork.format = true;
  }
}
