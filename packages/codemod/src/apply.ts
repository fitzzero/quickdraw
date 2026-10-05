// Applying a transform's work to the files: first every text edit, one pass
// per file (each edit was computed from the untouched file), then the
// structural follow-ups: imports to add, moved declarations (and the types
// only a rewritten call named) to drop once nothing uses them, unused imports
// to remove, an import left with only `type` names made `import type`, and
// formatting.

import { Node, type SourceFile } from "ts-morph";
import { ensureImport, relativeSpecifier, removeUnusedImports } from "./imports";
import { applyEdits, type Edit } from "./text";

/** An import a file needs after the edits. */
export interface NeededImport {
  readonly name: string;
  /** A package name, or an absolute file path for a relative import. */
  readonly from: string;
  readonly typeOnly?: boolean;
}

/** What to do to one file. */
export interface FileWork {
  readonly edits: Edit[];
  readonly imports: NeededImport[];
  /** Module-level declarations (consts, functions, interfaces, type aliases) to remove when the file no longer uses them. */
  readonly dropIfUnused: Set<string>;
  /** Whether to format the whole file (files the codemod rewrote heavily). */
  format: boolean;
  /** Whether to remove the imports the file no longer uses. */
  tidy: boolean;
}

/** The work for each file of one transform. */
export class Work {
  private readonly files = new Map<SourceFile, FileWork>();

  for(file: SourceFile): FileWork {
    let work = this.files.get(file);
    if (work === undefined) {
      work = { edits: [], imports: [], dropIfUnused: new Set(), format: false, tidy: false };
      this.files.set(file, work);
    }
    return work;
  }

  /** Applies everything; `withJs(file)` says whether the file's relative imports end in `.js`. */
  apply(withJs: (file: SourceFile) => boolean): SourceFile[] {
    const touched: SourceFile[] = [];
    for (const [file, work] of this.files) {
      if (work.edits.length > 0) {
        file.replaceWithText(applyEdits(file.getFullText(), 0, work.edits));
      }
      for (const needed of work.imports) {
        const source = needed.from.startsWith("/")
          ? relativeSpecifier(file.getFilePath(), needed.from, withJs(file))
          : needed.from;
        if (needed.from !== file.getFilePath()) {
          ensureImport(file, source, needed.name, { typeOnly: needed.typeOnly === true });
        }
      }
      dropUnused(file, work.dropIfUnused);
      if (work.tidy || work.format) {
        removeUnusedImports(file);
        typeOnlyImports(file);
      }
      if (work.format) {
        file.formatText({
          indentSize: 2,
          convertTabsToSpaces: true,
          ensureNewLineAtEndOfFile: true,
        });
        separateImports(file);
      }
      touched.push(file);
    }
    return touched;
  }
}

/**
 * An import whose names are all `type`-marked (`import { type A }`) becomes
 * `import type { A }`: only the inline markers would be erased, leaving an
 * import kept for its side effects (lint: no-import-type-side-effects).
 */
function typeOnlyImports(file: SourceFile): void {
  for (const declaration of file.getImportDeclarations()) {
    const named = declaration.getNamedImports();
    if (
      declaration.isTypeOnly() ||
      declaration.getDefaultImport() !== undefined ||
      declaration.getNamespaceImport() !== undefined ||
      named.length === 0 ||
      !named.every((specifier) => specifier.isTypeOnly())
    ) {
      continue;
    }
    for (const specifier of named) {
      specifier.setIsTypeOnly(false);
    }
    declaration.setIsTypeOnly(true);
  }
}

/** Removes the module-level declarations named in `names` that nothing in the file uses. */
function dropUnused(file: SourceFile, names: ReadonlySet<string>): void {
  for (const name of names) {
    const variable = file.getVariableDeclaration(name);
    const declaration =
      variable ?? file.getFunction(name) ?? file.getInterface(name) ?? file.getTypeAlias(name);
    if (declaration === undefined) {
      continue;
    }
    const nameNode = declaration.getNameNode();
    const used = file
      .getDescendants()
      .some(
        (node) =>
          node.getText() === name && node !== nameNode && node.getKindName() === "Identifier",
      );
    if (used) {
      continue;
    }
    const statement = variable?.getVariableStatement();
    if (statement !== undefined && statement.getDeclarations().length === 1) {
      statement.remove();
    } else if (
      Node.isInterfaceDeclaration(declaration) ||
      Node.isTypeAliasDeclaration(declaration)
    ) {
      removeWithComments(declaration);
    } else if (variable === undefined && !Node.isVariableDeclaration(declaration)) {
      declaration.remove();
    }
  }
}

/**
 * Removes a type declaration with the comments right above it (no blank line
 * between), which describe it, and the blank line after it.
 */
function removeWithComments(declaration: Node): void {
  const file = declaration.getSourceFile();
  const text = file.getFullText();
  let start = declaration.getStart();
  for (const range of declaration.getLeadingCommentRanges().toReversed()) {
    if (/\n\s*\n/u.test(text.slice(range.getEnd(), start))) {
      break;
    }
    start = range.getPos();
  }
  let end = declaration.getEnd();
  for (let newlines = 0; newlines < 2 && text[end] === "\n"; newlines += 1) {
    end += 1;
  }
  file.removeText(start, end);
}

/** Leaves one blank line between the imports and the code after them. */
function separateImports(file: SourceFile): void {
  const last = file.getImportDeclarations().at(-1);
  if (last === undefined) {
    return;
  }
  const after = file.getFullText().slice(last.getEnd(), last.getEnd() + 2);
  if (after.startsWith("\n") && after !== "\n\n" && last.getNextSibling() !== undefined) {
    file.insertText(last.getEnd(), "\n");
  }
}
