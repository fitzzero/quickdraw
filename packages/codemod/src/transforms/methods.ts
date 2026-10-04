// The methods of a migrated service. A method registered inside its class
// becomes an entry of `defineService`'s `methods`; one a method module
// registered (`registerX(service)`) stays in that module as an exported,
// typed method object, which `methods` lists by name.

import type { FunctionDeclaration, SourceFile } from "ts-morph";
import { accessFor } from "../access";
import type { Work } from "../apply";
import type { RunContext } from "../context";
import { buildMethod } from "../handlers";
import type { ServicePlan } from "../plan";
import type { Hoisted } from "../receiver";
import { infraPaths } from "./infra";
import {
  leadingCommentText,
  moduleConst,
  parsedInputType,
  registerLeftoverMarker,
  startWithComments,
} from "./serviceText";

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

/** Builds every method of the service: inline entries, and method module objects. */
export function buildMethods(
  ctx: RunContext,
  plan: ServicePlan,
  hoisted: ReadonlyMap<string, Hoisted>,
  work: Work,
): ServiceBuild {
  const build: ServiceBuild = {
    inline: [],
    modules: new Map(),
    moduleExports: [],
    anyEntry: false,
  };
  const leafFile = plan.service.chain[0]?.getSourceFile();
  for (const method of plan.methods) {
    const { call } = method;
    const inputType = parsedInputType(plan, method);
    const form = accessFor(
      call.level,
      call.levelText,
      method.entryId,
      plan.service.model !== undefined,
      inputType,
    );
    const landing = call.register?.getSourceFile() ?? leafFile;
    if (form.code.includes("ParsedInputOf<") && landing !== undefined) {
      work
        .for(landing)
        .imports.push({ name: "ParsedInputOf", from: "@fitzzero/quickdraw-core", typeOnly: true });
    }
    build.anyEntry ||= form.entry;
    const entry = buildMethod(call, form, {
      service: plan.service,
      hoisted,
      receiver: call.receiver,
      receiverParam: call.register?.getParameters()[0],
      inHandler: true,
    });
    ctx.stats.methods += 1;
    if (call.register === undefined) {
      build.inline.push(`${method.name}: ${entry.text},`);
      if (leafFile !== undefined) {
        addHoistedImports(work, leafFile, entry.imports);
      }
      continue;
    }
    const list = build.modules.get(call.register) ?? [];
    list.push(moduleConst(plan, method, entry, form.isPublic));
    build.modules.set(call.register, list);
    build.moduleExports.push({ name: method.name, file: call.register.getSourceFile() });
    build.inline.push(`${method.name},`);
    addHoistedImports(work, call.register.getSourceFile(), entry.imports);
  }
  return build;
}

/** Replaces each method module's `registerX(service)` with its method objects. */
export function convertModules(
  ctx: RunContext,
  plan: ServicePlan,
  build: ServiceBuild,
  work: Work,
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
    const leftovers = register
      .getStatements()
      .filter((statement) => !defineStatements.has(statement));
    const kept =
      leftovers.length === 0
        ? []
        : [registerLeftoverMarker(register.getName() ?? "this function"), register.getText()];
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
