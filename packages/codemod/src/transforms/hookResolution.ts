// Which 4.x hook a call reaches. Apps call quickdraw's hooks directly
// (`import { useServiceQuery } from "@fitzzero/quickdraw-core/client"`) or
// through their own typed wrappers, re-exported by a barrel:
//
//   // hooks/useService.ts
//   import { useService as useQuickdrawService } from "@fitzzero/quickdraw-core/client";
//   export function useService(serviceName, methodName, options) { return useQuickdrawService(...) }
//
// A wrapper is a function named like a 4.x hook in a file that imports that
// same hook from quickdraw.

import { type FunctionDeclaration, Node, type SourceFile } from "ts-morph";
import { importOf } from "../imports";

const CORE_CLIENT = "@fitzzero/quickdraw-core/client";

/** The 4.x hooks the client transform converts or marks. */
export const WRAPPED = new Set([
  "useService",
  "useServiceMethod",
  "useServiceQuery",
  "useSubscription",
  "useCollection",
  "useRoomEvents",
  "useChannelSend",
]);

/** A resolved hook: quickdraw's name for it, and the app wrapper it went through (`file#name`). */
export interface ResolvedHook {
  readonly hook: string;
  readonly wrapper: string | undefined;
}

/** The hook `fn` wraps, when it is a wrapper. */
function wrappedHook(fn: FunctionDeclaration): string | undefined {
  const name = fn.getName();
  if (name === undefined || !WRAPPED.has(name)) {
    return undefined;
  }
  const file = fn.getSourceFile();
  const wraps = file
    .getImportDeclarations()
    .some(
      (declaration) =>
        declaration.getModuleSpecifierValue() === CORE_CLIENT &&
        declaration.getNamedImports().some((specifier) => specifier.getName() === name),
    );
  return wraps ? name : undefined;
}

/** What `name`, exported by `file`, is: a quickdraw hook, through re-exports and wrappers. */
function resolveExport(file: SourceFile, name: string, depth: number): ResolvedHook | undefined {
  if (depth > 8) {
    return undefined;
  }
  const local = file.getFunction(name);
  if (local !== undefined && local.isExported()) {
    const hook = wrappedHook(local);
    return hook === undefined ? undefined : { hook, wrapper: `${file.getFilePath()}#${name}` };
  }
  for (const declaration of file.getExportDeclarations()) {
    const source = declaration.getModuleSpecifierValue();
    const target = declaration.getModuleSpecifierSourceFile();
    const named = declaration.getNamedExports();
    if (named.length === 0 && target !== undefined) {
      const found = resolveExport(target, name, depth + 1);
      if (found !== undefined) {
        return found;
      }
      continue;
    }
    const specifier = named.find(
      (item) => (item.getAliasNode()?.getText() ?? item.getName()) === name,
    );
    if (specifier === undefined) {
      continue;
    }
    if (source === CORE_CLIENT) {
      return WRAPPED.has(specifier.getName())
        ? { hook: specifier.getName(), wrapper: undefined }
        : undefined;
    }
    return target === undefined ? undefined : resolveExport(target, specifier.getName(), depth + 1);
  }
  return undefined;
}

/** The hook `identifier` (a use of a name in its file) reaches, if any. */
export function resolveHook(identifier: Node): ResolvedHook | undefined {
  if (!Node.isIdentifier(identifier)) {
    return undefined;
  }
  const file = identifier.getSourceFile();
  const name = identifier.getText();
  const imported = importOf(file, name);
  if (imported === undefined) {
    const local = file.getFunction(name);
    const hook = local === undefined ? undefined : wrappedHook(local);
    return hook === undefined ? undefined : { hook, wrapper: `${file.getFilePath()}#${name}` };
  }
  if (imported.module === CORE_CLIENT) {
    return WRAPPED.has(imported.imported)
      ? { hook: imported.imported, wrapper: undefined }
      : undefined;
  }
  const declaration = file
    .getImportDeclarations()
    .find((item) => item.getModuleSpecifierValue() === imported.module);
  const target = declaration?.getModuleSpecifierSourceFile();
  return target === undefined ? undefined : resolveExport(target, imported.imported, 0);
}
