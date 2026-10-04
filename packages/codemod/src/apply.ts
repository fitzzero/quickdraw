// Applying a transform's work to the files: first every text edit, one pass
// per file (each edit was computed from the untouched file), then the
// structural follow-ups: imports to add, moved declarations to drop once
// nothing uses them, unused imports to remove, and formatting.

import type { SourceFile } from "ts-morph";
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
  /** Module-level declarations to remove when the file no longer uses them. */
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

/** Removes the module-level consts and functions named in `names` that nothing in the file uses. */
function dropUnused(file: SourceFile, names: ReadonlySet<string>): void {
  for (const name of names) {
    const variable = file.getVariableDeclaration(name);
    const declaration = variable ?? file.getFunction(name);
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
    } else if (variable === undefined) {
      file.getFunction(name)?.remove();
    }
  }
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
