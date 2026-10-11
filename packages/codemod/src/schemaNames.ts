// The names moved declarations take in the code the codemod writes. Moved
// code is the 4.x text, which names a declaration by whatever the 4.x file
// called it: an import or re-export alias, or a name that another method
// module's declaration also has. A contract file holds the local declarations
// of every method module of its service, so two modules' `projectIdSchema`
// would be declared twice. Same-named locals that are the same code (the
// same tokens, whatever the layout or comments, naming the same things) are
// written once; any other gets `<name>Of<Module>`. Every reference, the
// schema's own code included, is written under the name its declaration
// takes, so an aliased schema is written by its declared name.

import { basename, parse } from "node:path";
import { ts } from "ts-morph";
import type { MovedDeclaration, MovedSchema, Reference } from "./schemas";
import { upperFirst } from "./text";

/** The names of one contract file's moved declarations. */
export interface DeclarationNames {
  /** Each declaration's key, and the name the file binds it by. */
  readonly names: ReadonlyMap<string, string>;
  /** The local declarations to write, each once, in method order (dependencies first). */
  readonly locals: readonly MovedDeclaration[];
  /** Local declarations not written, since an earlier one of the same name is the same code. */
  readonly merged: number;
  /** The keys of local declarations written under another name than their own. */
  readonly renamed: ReadonlySet<string>;
}

/** `code` with each reference written under the name its declaration takes in `names`. */
export function renderCode(
  code: string,
  references: readonly Reference[],
  names: ReadonlyMap<string, string>,
): string {
  let text = code;
  for (const reference of references.toSorted((a, b) => b.start - a.start)) {
    const name = names.get(reference.key);
    if (name !== undefined) {
      text = text.slice(0, reference.start) + name + text.slice(reference.end);
    }
  }
  return text;
}

/** `Archive` for `.../archive.ts`, `UpdateTask` for `update-task.ts`, `Project` for `project/index.ts`. */
export function moduleOf(file: string): string {
  const { name, dir } = parse(file);
  const base = name === "index" ? basename(dir) : name;
  const words = base.split(/[^A-Za-z0-9]+/u).filter((word) => word !== "");
  return words.length === 0 ? "Module" : words.map((word) => upperFirst(word)).join("");
}

const CLOSERS = new Set([
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
]);

/**
 * The leaf tokens of `code`, without comments, JSDoc or a comma before `)`,
 * `]` or `}`, each reference replaced by `replace(reference)`.
 */
function tokensOf(
  code: string,
  references: readonly Reference[],
  replace: (reference: Reference) => string,
): string {
  const file = ts.createSourceFile("moved.ts", code, ts.ScriptTarget.Latest, true);
  const byStart = new Map(references.map((reference) => [reference.start, reference] as const));
  const leaves: { kind: ts.SyntaxKind; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(file);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken) {
      return;
    }
    const reference = byStart.get(node.getStart(file));
    leaves.push({
      kind: node.kind,
      text: reference === undefined ? node.getText(file) : replace(reference),
    });
  };
  visit(file);
  return JSON.stringify(
    leaves
      .filter(
        (leaf, index) =>
          leaf.kind !== ts.SyntaxKind.CommaToken || !CLOSERS.has(leaves[index + 1]?.kind ?? 0),
      )
      .map((leaf) => leaf.text),
  );
}

/**
 * Names the declarations `schemas` moved, for a contract file that already
 * binds `taken` (its imports and its contract). Helpers keep their names.
 * Locals of one name that are the same code are written once; the first
 * other variant in method order keeps the name, and later ones (or the
 * first, when `taken` has the name) become `<name>Of<Module>`, with `2`,
 * `3` and so on after it when that is taken too.
 */
export function nameDeclarations(
  schemas: readonly MovedSchema[],
  taken: ReadonlySet<string>,
): DeclarationNames {
  const byKey = new Map<string, MovedDeclaration>();
  for (const declaration of schemas.flatMap((schema) => schema.declarations)) {
    if (!byKey.has(declaration.key)) {
      byKey.set(declaration.key, declaration);
    }
  }
  const identities = new Map<string, string>();
  const open = new Set<string>();
  // the code with each reference replaced by the identity of what it names
  const identity = (key: string): string => {
    const known = identities.get(key);
    if (known !== undefined) {
      return known;
    }
    const declaration = byKey.get(key);
    if (declaration === undefined) {
      return key;
    }
    open.add(key);
    const text = tokensOf(declaration.code, declaration.references, (reference) => {
      // its own name, or a cycle back to a declaration being read
      if (open.has(reference.key)) {
        return `@${byKey.get(reference.key)?.name ?? reference.key}`;
      }
      return `{${identity(reference.key)}}`;
    });
    open.delete(key);
    identities.set(key, text);
    return text;
  };

  const names = new Map<string, string>();
  const all = [...byKey.values()];
  for (const helper of all.filter((declaration) => declaration.place === "helper")) {
    names.set(helper.key, helper.name);
  }
  const used = new Set([
    ...taken,
    ...all.filter((declaration) => declaration.place === "local").map(({ name }) => name),
  ]);
  const variants = new Map<string, { identity: string; name: string }[]>();
  const locals: MovedDeclaration[] = [];
  const renamed = new Set<string>();
  let merged = 0;
  for (const local of all.filter((declaration) => declaration.place === "local")) {
    const own = identity(local.key);
    const group = variants.get(local.name) ?? [];
    variants.set(local.name, group);
    const same = group.find((variant) => variant.identity === own);
    if (same !== undefined) {
      names.set(local.key, same.name);
      merged += 1;
      continue;
    }
    let name = local.name;
    if (group.length > 0 || taken.has(name)) {
      const base = `${local.name}Of${moduleOf(local.file)}`;
      name = base;
      for (let suffix = 2; used.has(name); suffix += 1) {
        name = `${base}${String(suffix)}`;
      }
      renamed.add(local.key);
    }
    used.add(name);
    group.push({ identity: own, name });
    names.set(local.key, name);
    locals.push(local);
  }
  return { names, locals, merged, renamed };
}
