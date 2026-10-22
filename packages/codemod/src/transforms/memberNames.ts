// The names a service class's members are hoisted to (`hoist.ts`). A member
// takes its own name where the class's code leaves it free (one a local of
// the class names is hoisted as `<name>Of<Class>`), but code outside the
// class can bind that name below module scope: a module function's parameter
// (Conveyor's `reviewCatchUp`, beside the field of that name), or a local of
// a method module's handler. Once the member is a binding of the module,
// declared there or imported, such a binding shadows it, and a handler's
// local would also capture what the handler read through the service
// (`service.limit`, now `limit`). Before anything is planned,
// `freeMemberNames` renames it `<name>Impl`, or the first free name from
// there, with every reference, the rule `freeMethodNames` (methodNames.ts)
// applies to a method object's name: the member keeps its 4.x name, and no
// rename is marked.

import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { Renames } from "../bindings";
import { hoistedNames, setupOnlyMethods } from "../hoist";
import type { ServiceModel } from "../model";

/**
 * The names a service's members are hoisted to, by the files they land in:
 * where a member is declared, where its chain's classes read it (`this.x`,
 * imported when another class of the chain declares it), and the method
 * modules whose handlers read it through the service (`service.x`).
 */
function landings(service: ServiceModel): Map<SourceFile, Set<string>> {
  const hoisted = hoistedNames(service, setupOnlyMethods(service));
  const files = new Map<SourceFile, Set<string>>();
  const land = (file: SourceFile, member: string): void => {
    const name = hoisted.get(member)?.name;
    if (name !== undefined) {
      files.set(file, (files.get(file) ?? new Set<string>()).add(name));
    }
  };
  for (const [member, target] of hoisted) {
    land(target.file, member);
  }
  for (const cls of service.chain) {
    for (const access of cls.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (access.getExpression().getKind() === SyntaxKind.ThisKeyword) {
        land(cls.getSourceFile(), access.getName());
      }
    }
  }
  for (const method of service.methods) {
    const file = method.register?.getSourceFile();
    if (file === undefined || method.handler === undefined) {
      continue;
    }
    for (const access of method.handler.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const receiver = access.getExpression();
      if (Node.isIdentifier(receiver) && receiver.getText() === method.receiver) {
        land(file, access.getName());
      }
    }
  }
  return files;
}

/** Adds to `renames` each binding below module scope that would shadow a member hoisted where it lands. */
export function freeMemberNames(services: readonly ServiceModel[], renames: Renames): void {
  for (const service of services) {
    for (const [file, names] of landings(service)) {
      renames.reserve(file, [...names]);
      for (const name of names) {
        for (const local of renames.nestedIn(file, name)) {
          renames.rename(local, `${name}Impl`);
        }
      }
    }
  }
}
