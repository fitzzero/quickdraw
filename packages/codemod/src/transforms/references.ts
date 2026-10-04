// Other files that used a 4.x service class: an import of the class becomes
// an import of the service object, `new ProjectService(prisma)` becomes
// `projectService` (marked: the server registers services differently), and
// the class as a type becomes `typeof projectService`.

import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { Work } from "../apply";
import type { RunContext } from "../context";
import { MarkerSet } from "../markers";
import type { ServicePlan } from "../plan";
import { serviceVar } from "./services";

function rewriteFile(file: SourceFile, plan: ServicePlan, work: Work): void {
  const leaf = plan.service.chain[0];
  const className = plan.service.className;
  const target = serviceVar(plan.service);
  if (leaf === undefined || file === leaf.getSourceFile()) {
    return;
  }
  const specifiers = [
    ...file
      .getImportDeclarations()
      .filter((declaration) => declaration.getModuleSpecifierSourceFile() === leaf.getSourceFile())
      .flatMap((declaration) => declaration.getNamedImports()),
    ...file
      .getExportDeclarations()
      .filter((declaration) => declaration.getModuleSpecifierSourceFile() === leaf.getSourceFile())
      .flatMap((declaration) => declaration.getNamedExports()),
  ].filter((specifier) => specifier.getName() === className);
  if (specifiers.length === 0) {
    return;
  }
  const markers = new MarkerSet(file);
  const fileWork = work.for(file);
  for (const specifier of specifiers) {
    const nameNode = specifier.getNameNode();
    fileWork.edits.push({ start: nameNode.getStart(), end: nameNode.getEnd(), text: target });
  }
  const local =
    specifiers
      .map((specifier) => specifier.getAliasNode()?.getText())
      .find((alias) => alias !== undefined) ?? className;
  const bindingNames = new Set(specifiers.map((specifier) => specifier.getNameNode()));
  for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (
      identifier.getText() !== local ||
      bindingNames.has(identifier) ||
      identifier.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) !== undefined
    ) {
      continue;
    }
    const parent = identifier.getParent();
    if (Node.isNewExpression(parent) && parent.getExpression() === identifier) {
      fileWork.edits.push({ start: parent.getStart(), end: parent.getEnd(), text: target });
      markers.add(
        parent,
        "server",
        `the 4.x service was constructed here (new ${className}(...)): it is the object ${target} now; pass it in qd.createServer({ services: [...] })`,
      );
    } else if (Node.isTypeReference(parent)) {
      fileWork.edits.push({
        start: parent.getStart(),
        end: parent.getEnd(),
        text: `typeof ${target}`,
      });
    } else if (!Node.isExportSpecifier(parent)) {
      markers.add(
        identifier,
        "server",
        `${className} was the 4.x service class; the service is the object ${target} now`,
      );
    }
  }
  fileWork.edits.push(...markers.edits);
  fileWork.tidy = true;
}

/** Rewrites every other file's use of the migrated classes. */
export function rewriteReferences(
  ctx: RunContext,
  plans: readonly ServicePlan[],
  work: Work,
): void {
  for (const file of ctx.project.getSourceFiles()) {
    for (const plan of plans) {
      rewriteFile(file, plan, work);
    }
  }
}
