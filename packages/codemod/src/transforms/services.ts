// Each 4.x service class becomes `qd.defineService(contract, { model,
// access, methods })` in the class's file. Methods registered inside the
// class become entries of `methods`; methods registered by a method module
// (`registerX(service)`) stay in that module as exported, typed method
// objects the service lists. The rest of the class is hoisted (`hoist.ts`).

import type { ClassDeclaration, SourceFile } from "ts-morph";
import type { Work } from "../apply";
import type { RunContext } from "../context";
import { hoistClass, hoistedNames, setupOnlyMethods } from "../hoist";
import type { ServicePlan } from "../plan";
import type { Hoisted } from "../receiver";
import { infraPaths } from "./infra";
import { addHoistedImports, buildMethods, convertModules } from "./methods";
import {
  defineServiceText,
  leadingCommentText,
  policyLines,
  startWithComments,
} from "./serviceText";

export { serviceVar } from "./serviceText";

const CORE_SERVER = "@fitzzero/quickdraw-core/server";

function replaceClass(cls: ClassDeclaration, texts: readonly string[], work: Work): void {
  const fileWork = work.for(cls.getSourceFile());
  fileWork.edits.push({
    start: startWithComments(cls),
    end: cls.getEnd(),
    text: texts.join("\n\n"),
  });
  fileWork.format = true;
}

/** Migrates one service: its classes, its method modules, and the imports they need. */
function migrateService(ctx: RunContext, plan: ServicePlan, work: Work): void {
  const { service } = plan;
  const [leaf, ...ancestors] = service.chain;
  if (leaf === undefined) {
    return;
  }
  const setupOnly = setupOnlyMethods(service);
  const hoisted = hoistedNames(service, setupOnly);
  const paths = infraPaths(ctx);
  // The hoisted code first: a file whose helpers use the tracked `db` imports
  // it, and its handlers use that one.
  const dbFiles = new Set<SourceFile>();
  for (const cls of ancestors) {
    const imports: Hoisted[] = [];
    const hoistedCode = hoistClass(cls, service, hoisted, setupOnly, imports);
    replaceClass(cls, [...leadingCommentText(cls), ...hoistedCode.texts], work);
    addHoistedImports(work, cls.getSourceFile(), imports);
    if (hoistedCode.usesDb) {
      work.for(cls.getSourceFile()).imports.push({ name: "db", from: paths.db });
      dbFiles.add(cls.getSourceFile());
    }
  }
  const imports: Hoisted[] = [];
  const leafCode = hoistClass(leaf, service, hoisted, setupOnly, imports);
  if (leafCode.usesDb) {
    dbFiles.add(leaf.getSourceFile());
  }
  const build = buildMethods(ctx, plan, hoisted, work, dbFiles);
  const policy = policyLines(service, build.anyEntry);
  replaceClass(
    leaf,
    [
      ...leafCode.texts,
      defineServiceText(plan, build.inline, policy.lines, leadingCommentText(leaf)),
    ],
    work,
  );
  const leafFile = leaf.getSourceFile();
  addHoistedImports(work, leafFile, imports);
  const leafWork = work.for(leafFile);
  leafWork.imports.push(
    { name: "qd", from: paths.quickdraw },
    { name: plan.contractVar, from: ctx.layout.shared.name },
  );
  if (policy.builder !== undefined) {
    leafWork.imports.push({ name: policy.builder, from: CORE_SERVER });
  }
  if (leafCode.usesDb) {
    leafWork.imports.push({ name: "db", from: paths.db });
  }
  for (const exported of build.moduleExports) {
    leafWork.imports.push({ name: exported.name, from: exported.file.getFilePath() });
  }
  convertModules(ctx, plan, build, work);
  dropMovedSchemas(plan, work);
  ctx.stats.services += 1;
}

/** Schemas copied into the contract leave the api files that no longer use them. */
function dropMovedSchemas(plan: ServicePlan, work: Work): void {
  for (const method of plan.methods) {
    const file = method.call.call.getSourceFile();
    for (const declaration of method.moved?.declarations ?? []) {
      if (declaration.place === "local") {
        work.for(file).dropIfUnused.add(declaration.name);
      }
    }
  }
}

/** Migrates every planned service. */
export function migrateServices(ctx: RunContext, plans: readonly ServicePlan[], work: Work): void {
  for (const plan of plans) {
    migrateService(ctx, plan, work);
  }
}
