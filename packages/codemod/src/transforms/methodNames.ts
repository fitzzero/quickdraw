// The names of a split service's method objects. A method module's method
// object takes its method's name (`export const renameTask = { access,
// handler }`), and the service file imports it under that name, so
// `methods: { renameTask }` stays shorthand. A 4.x file can bind the name
// already: Conveyor's method modules kept a handler's body in a function
// named after its method, or imported the implementation under that name,
// and its service files imported those implementations too and declared
// wrappers of the methods' names beside the class. Two of a name in one
// scope do not parse, so before anything is planned `freeMethodNames`
// renames what the file owns, with every reference to it:
//
// - in a method module, a function or binding of the method's name becomes
//   `<name>Body`, and an import of it `<name> as <name>Impl`;
// - in the service file, an import of the method's name becomes
//   `<name> as <name>Impl`;
// - in either, a binding inside a function that would shadow the method
//   object (`const { name } = await import(...)`) becomes `{ name: nameImpl }`;
//
// each the first free name from there (`<name>Body2`, ...). What other files
// see keeps its name (`methodObjectNames`, serviceText.ts): a method module
// that exports a helper of the method's name writes the object as
// `<name>Method`, and a service file that declares the name itself imports
// the object as `<name>Method`, listing it as `<name>: <name>Method`. No
// rename asks anything of a person, so none is marked.

import type { Identifier, Node, SourceFile } from "ts-morph";
import {
  exportedNames,
  freeName,
  isExportedBinding,
  isImportBinding,
  moduleBindings,
  nestedBindings,
  renameEdits,
} from "../bindings";
import type { ServiceModel } from "../model";
import { applyEdits, type Edit } from "../text";

/** Renames of one run's bindings, each to a name free in its file. */
class Renames {
  readonly edits = new Map<SourceFile, Edit[]>();
  private readonly taken = new Map<SourceFile, Set<string>>();
  private readonly renamed = new Set<Identifier>();
  private readonly nested = new Map<SourceFile, Map<string, Identifier[]>>();

  /** The bindings of `name` below the module scope of `file`, read once per file: no file changes before `apply`. */
  nestedIn(file: SourceFile, name: string): Identifier[] {
    const byName = this.nested.get(file) ?? nestedBindings(file);
    this.nested.set(file, byName);
    return byName.get(name) ?? [];
  }

  /** The names no rename may take in `file`, `names` added: the run writes them there, or a rename took them. */
  reserve(file: SourceFile, names: readonly string[] = []): Set<string> {
    const taken = this.taken.get(file) ?? new Set<string>();
    this.taken.set(file, taken);
    for (const name of names) {
      taken.add(name);
    }
    return taken;
  }

  /** Renames the binding `binding` declares (once) to `base`, or the first free name after it. */
  rename(binding: Identifier, base: string): void {
    if (this.renamed.has(binding)) {
      return;
    }
    this.renamed.add(binding);
    const file = binding.getSourceFile();
    const taken = this.reserve(file);
    const to = freeName(file, base, taken);
    taken.add(to);
    const edits = renameEdits(binding, to);
    if (edits.length > 0) {
      this.edits.set(file, [...(this.edits.get(file) ?? []), ...edits]);
    }
  }

  /** Writes the renames into their files; whether there were any. */
  apply(): boolean {
    for (const [file, edits] of this.edits) {
      file.replaceWithText(applyEdits(file.getFullText(), 0, edits));
    }
    return this.edits.size > 0;
  }
}

/** The names of a service's methods that method modules register, by module: one call per name, the one `planService` keeps. */
function moduleMethods(service: ServiceModel): Map<SourceFile, string[]> {
  const byName = new Map(service.methods.map((call) => [call.name, call]));
  const modules = new Map<SourceFile, string[]>();
  for (const call of byName.values()) {
    const file = call.register?.getSourceFile();
    if (file !== undefined) {
      modules.set(file, [...(modules.get(file) ?? []), call.name]);
    }
  }
  return modules;
}

/**
 * Frees `name` in its method module, whose `registers` the run replaces: a
 * local function or binding becomes `<name>Body`, an import `<name>Impl`, a
 * nested binding `<name>Impl`. Whether the method object can take the name:
 * not when the module exports something of it, which stays.
 */
function freeInModule(
  file: SourceFile,
  name: string,
  registers: ReadonlySet<Node>,
  renames: Renames,
): boolean {
  const bindings = moduleBindings(file, name, registers);
  if (exportedNames(file).has(name) || bindings.some((binding) => isExportedBinding(binding))) {
    return false;
  }
  for (const binding of bindings) {
    renames.rename(binding, `${name}${isImportBinding(binding) ? "Impl" : "Body"}`);
  }
  for (const local of renames.nestedIn(file, name)) {
    renames.rename(local, `${name}Impl`);
  }
  return true;
}

/**
 * Frees `name`, which a method object is imported under, in the service
 * file: an import becomes `<name>Impl`, a nested binding `<name>Impl`. A
 * declaration of the name stays, and the object is imported under another.
 */
function freeInServiceFile(file: SourceFile, name: string, renames: Renames): void {
  const bindings = moduleBindings(file, name);
  if (bindings.some((binding) => !isImportBinding(binding))) {
    return;
  }
  for (const binding of bindings) {
    renames.rename(binding, `${name}Impl`);
  }
  for (const local of renames.nestedIn(file, name)) {
    renames.rename(local, `${name}Impl`);
  }
}

/**
 * Renames what binds a method object's name in its method module and in its
 * service file (see the top of this file), in the project's files. Whether it
 * renamed anything: a renamed file is parsed again, so the services must be
 * read again.
 */
export function freeMethodNames(services: readonly ServiceModel[]): boolean {
  const renames = new Renames();
  for (const service of services) {
    const registers = new Set<Node>(service.methods.flatMap((method) => method.register ?? []));
    const modules = moduleMethods(service);
    const imported: string[] = [];
    for (const [file, names] of modules) {
      renames.reserve(file, names);
      imported.push(...names.filter((name) => freeInModule(file, name, registers, renames)));
    }
    const leaf = service.chain[0]?.getSourceFile();
    if (leaf !== undefined) {
      renames.reserve(leaf, [...modules.values()].flat());
      for (const name of imported) {
        freeInServiceFile(leaf, name, renames);
      }
    }
  }
  return renames.apply();
}
