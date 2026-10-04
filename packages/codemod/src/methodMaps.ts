// The 4.x method maps and DTOs in the shared package:
//
//   export interface ChatServiceMethods {
//     createChat: { payload: { title: string }; response: { id: string } };
//   }
//
// (or a type alias, or `ServiceMethodMap<{ ... }>`), found by the names the
// service's `BaseService<...>` type arguments give.

import {
  type InterfaceDeclaration,
  Node,
  type Project,
  ts,
  type TypeAliasDeclaration,
  type TypeElementTypes,
  type TypeNode,
} from "ts-morph";
import type { EntryId } from "./access";
import type { Layout } from "./layout";
import { isUnder } from "./project";

/** One method of a method map. */
export interface MethodMapEntry {
  readonly payload: TypeNode | undefined;
  readonly response: TypeNode | undefined;
}

/** A method map: its declaration and its methods by name. */
export interface MethodMap {
  readonly declaration: InterfaceDeclaration | TypeAliasDeclaration;
  readonly entries: ReadonlyMap<string, MethodMapEntry>;
}

/** The interface or type alias named `name` in the shared package. */
export function findSharedType(
  project: Project,
  layout: Layout,
  name: string | undefined,
): InterfaceDeclaration | TypeAliasDeclaration | undefined {
  if (name === undefined || !/^\w+$/u.test(name)) {
    return undefined;
  }
  for (const file of project.getSourceFiles()) {
    if (isUnder(file, layout.shared.src)) {
      const found = file.getInterface(name) ?? file.getTypeAlias(name);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function memberType(members: readonly TypeElementTypes[], key: string): TypeNode | undefined {
  const member = members.find(
    (candidate) => Node.isPropertySignature(candidate) && candidate.getName() === key,
  );
  return member !== undefined && Node.isPropertySignature(member)
    ? member.getTypeNode()
    : undefined;
}

/** The members of the type literal a method map's alias stands for, through `ServiceMethodMap<...>`. */
function aliasMembers(alias: TypeAliasDeclaration): readonly TypeElementTypes[] {
  let node = alias.getTypeNode();
  if (node !== undefined && Node.isTypeReference(node)) {
    node = node.getTypeArguments()[0];
  }
  return node !== undefined && Node.isTypeLiteral(node) ? node.getMembers() : [];
}

/** The method map named `name`, read from its declaration. */
export function findMethodMap(
  project: Project,
  layout: Layout,
  name: string | undefined,
): MethodMap | undefined {
  const declaration = findSharedType(project, layout, name);
  if (declaration === undefined) {
    return undefined;
  }
  const members = Node.isInterfaceDeclaration(declaration)
    ? declaration.getMembers()
    : aliasMembers(declaration);
  const entries = new Map<string, MethodMapEntry>();
  for (const member of members) {
    if (!Node.isPropertySignature(member)) {
      continue;
    }
    const type = member.getTypeNode();
    const inner = type !== undefined && Node.isTypeLiteral(type) ? type.getMembers() : [];
    entries.set(member.getName(), {
      payload: memberType(inner, "payload"),
      response: memberType(inner, "response"),
    });
  }
  return { declaration, entries };
}

/** The keys of a DTO type, as the type checker sees them. */
export function keysOf(declaration: InterfaceDeclaration | TypeAliasDeclaration): string[] {
  return declaration
    .getType()
    .getProperties()
    .map((property) => property.getName());
}

/**
 * The row id a payload carries implicitly: 4.x read `payload.id` when it was
 * a string (`legacy-src/server/ServiceRegistry.ts:313-325`).
 */
export function implicitEntryId(payload: TypeNode | undefined): EntryId {
  if (payload === undefined) {
    return undefined;
  }
  const property = payload.getType().getProperty("id");
  if (property === undefined) {
    return undefined;
  }
  const type = property.getTypeAtLocation(payload).getNonNullableType();
  if (!type.isString() && !type.isStringLiteral()) {
    return undefined;
  }
  return property.hasFlags(ts.SymbolFlags.Optional)
    ? { kind: "optional", key: "id" }
    : { kind: "key", key: "id" };
}
