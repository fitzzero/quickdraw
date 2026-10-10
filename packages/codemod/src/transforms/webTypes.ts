// The 4.x types the web app's rewrite leaves behind (F1.7, F1.9 of the
// quickdraw-chat migration): a local type only a rewritten hook call's type
// arguments named, a one-argument `UseCollectionResult<Item>` (5.0's takes the
// index row too), and the file of types only the deleted wrapper hooks
// imported (the template's hooks/service-types.ts).

import { type CallExpression, Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { Work } from "../apply";
import type { RunContext } from "../context";
import { importOf, isImported } from "../imports";

/** The file's own, unexported interfaces and type aliases a call's type arguments name. */
export function localTypesOf(call: CallExpression): string[] {
  const file = call.getSourceFile();
  return call
    .getTypeArguments()
    .flatMap((argument) => [argument, ...argument.getDescendants()])
    .filter((node) => Node.isTypeReference(node))
    .map((reference) => reference.getTypeName().getText())
    .filter((name) => {
      const declaration = file.getInterface(name) ?? file.getTypeAlias(name);
      return declaration !== undefined && !declaration.isExported();
    });
}

/** 4.x's one-argument `UseCollectionResult<Item>` (quickdraw's client type) gets 5.0's index row. */
export function completeCollectionResults(file: SourceFile, work: Work): void {
  if (!file.getFullText().includes("UseCollectionResult")) {
    return;
  }
  for (const reference of file.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    const name = reference.getTypeName();
    const [item, ...rest] = reference.getTypeArguments();
    if (
      item === undefined ||
      rest.length > 0 ||
      !Node.isIdentifier(name) ||
      importOf(file, name.getText())?.module !== "@fitzzero/quickdraw-core/client" ||
      importOf(file, name.getText())?.imported !== "UseCollectionResult"
    ) {
      continue;
    }
    work.for(file).edits.push({
      start: item.getEnd(),
      end: item.getEnd(),
      text: ", { readonly id: string }",
    });
  }
}

/** Whether a file only declares types (and imports what they need): nothing of it runs. */
function typesOnly(file: SourceFile): boolean {
  return file
    .getStatements()
    .every(
      (statement) =>
        Node.isInterfaceDeclaration(statement) ||
        Node.isTypeAliasDeclaration(statement) ||
        (Node.isImportDeclaration(statement) &&
          (statement.isTypeOnly() ||
            statement.getNamedImports().every((specifier) => specifier.isTypeOnly()))),
    );
}

/**
 * The files of types the deleted wrappers imported (the template's
 * hooks/service-types.ts) that no file imports any more: they go with them.
 */
export function deleteOrphanTypes(ctx: RunContext, imported: ReadonlySet<SourceFile>): void {
  for (const file of imported) {
    if (file.wasForgotten() || !typesOnly(file) || isImported(ctx.project, file)) {
      continue;
    }
    ctx.deleted.add(file.getFilePath());
    file.delete();
  }
}
