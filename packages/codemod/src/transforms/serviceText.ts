// The code a migrated service is written as: its access policy line, its
// `qd.defineService(...)` statement, and the exported method objects of its
// method modules, with their names.

import type { Node, SourceFile } from "ts-morph";
import { exportedNames, freeName, moduleBindings } from "../bindings";
import type { MethodEntry } from "../handlers";
import { markerText } from "../markers";
import type { ServiceModel } from "../model";
import type { MethodPlan, ServicePlan } from "../plan";
import { listText, lowerFirst, quote } from "../text";

/** The service object's name: `ProjectService` gives `projectService`. */
export function serviceVar(service: ServiceModel): string {
  return lowerFirst(service.className);
}

export function policyLines(
  service: ServiceModel,
  anyEntry: boolean,
): { lines: string[]; builder: string | undefined } {
  if (service.model === undefined) {
    return { lines: [], builder: undefined };
  }
  const placeholder = "access: resolver({ levelsFor: () => ({}) }),";
  const overrides = [
    "checkAccess",
    "checkEntryACL",
    "checkSubscriptionAccess",
    "checkBatchSubscriptionAccess",
  ].filter((name) => service.overrides.has(name));
  if (overrides.length > 0) {
    const message = `4.x decided row access in ${overrides.join(" and ")} (now functions in this file): port them to a policy (owner, jsonAcl, members, inherit, everyone, anyOf or resolver). Until then this policy grants no row, so only service grants pass`;
    return { lines: [markerText("access-override", message), placeholder], builder: "resolver" };
  }
  if (service.readsAclColumn) {
    const message =
      "4.x's hasEntryACL read the row's `acl` column ([{ userId, level }]), and so does jsonAcl(\"acl\"), with one difference: a user with several entries in a row's list gets the highest of their levels, where 4.x took the first. Check the stored lists for duplicate entries";
    return {
      lines: [markerText("access", message), 'access: jsonAcl("acl"),'],
      builder: "jsonAcl",
    };
  }
  if (anyEntry) {
    const message =
      "4.x had no row-level access here (no hasEntryACL, no checkAccess): only service grants opened rows, which this empty policy keeps. Give it a real policy if rows belong to someone";
    return { lines: [markerText("access", message), placeholder], builder: "resolver" };
  }
  return { lines: [], builder: undefined };
}

/** The start of a node's leading comments, so a replacement takes them along. */
export function startWithComments(node: Node): number {
  const [first] = node.getLeadingCommentRanges();
  return first === undefined ? node.getStart() : first.getPos();
}

/** A node's leading comments as one block (or nothing), to keep above what replaces it. */
export function leadingCommentText(node: Node): string[] {
  const comments = node.getLeadingCommentRanges().map((range) => range.getText());
  return comments.length === 0 ? [] : [comments.join("\n")];
}

/** A module method's object: its name in its module, and the name the service file imports it under. */
export interface ObjectNames {
  readonly object: string;
  readonly local: string;
}

/**
 * The names of a service's method objects, by method: the method's own name,
 * in its module and in the service file, unless the file binds it there
 * still (what `freeMethodNames` keeps, methodNames.ts: a helper the module
 * exports, a declaration of the service file), then `<name>Method`, or the
 * first free name after it.
 */
export function methodObjectNames(plan: ServicePlan): Map<MethodPlan, ObjectNames> {
  const modular = plan.methods.filter((method) => method.call.register !== undefined);
  const registers = new Set<Node>(modular.flatMap((method) => method.call.register ?? []));
  const own = modular.map((method) => method.name);
  const taken = new Map<SourceFile, Set<string>>();
  const names = new Map<MethodPlan, ObjectNames>();
  for (const method of modular) {
    // the defineMethod call sits in its register function, in the method module
    const file = method.call.call.getSourceFile();
    const inFile = taken.get(file) ?? new Set(own);
    taken.set(file, inFile);
    const bound =
      moduleBindings(file, method.name, registers).length > 0 ||
      exportedNames(file).has(method.name);
    const object = bound ? freeName(file, `${method.name}Method`, inFile) : method.name;
    inFile.add(object);
    names.set(method, { object, local: object });
  }
  const leaf = plan.service.chain[0]?.getSourceFile();
  if (leaf === undefined) {
    return names;
  }
  const inLeaf = new Set(own);
  for (const [method, { object }] of names) {
    const free =
      moduleBindings(leaf, object).length === 0 && (object === method.name || !inLeaf.has(object));
    const local = free ? object : freeName(leaf, `${method.name}Method`, inLeaf);
    inLeaf.add(local);
    names.set(method, { object, local });
  }
  return names;
}

/** One method of a method module, exported as `name` and typed for the service to list. */
export function moduleConst(
  plan: ServicePlan,
  method: MethodPlan,
  name: string,
  entry: MethodEntry,
  isPublic: boolean,
): string {
  return `export const ${name} = ${entry.text} satisfies ${isPublic ? "PublicMethodOf" : "MethodOf"}<typeof ${plan.contractVar}, ${quote(method.name)}>;`;
}

/** The `qd.defineService(...)` statement. */
export function defineServiceText(
  plan: ServicePlan,
  inline: readonly string[],
  policy: readonly string[],
  comments: readonly string[],
): string {
  const { service } = plan;
  return [
    ...comments,
    `export const ${serviceVar(service)} = qd.defineService(${plan.contractVar}, {`,
    ...(service.model === undefined ? [] : [`model: ${quote(service.model)},`]),
    ...policy,
    "methods: {",
    ...inline,
    "},",
    "});",
  ].join("\n");
}

/**
 * What the marker above a `registerX(service)` function (or an aggregator)
 * that also did other work says; `removed` names its calls of converted
 * functions, which the run removed.
 */
export function registerLeftoverMessage(name: string, removed: readonly string[] = []): string {
  const calls =
    removed.length === 0
      ? ""
      : ` (the codemod removed its ${removed.length === 1 ? "call" : "calls"} of ${listText(removed)}, whose methods the service lists now)`;
  return `${name} also did more than register methods${calls}: a service object is not passed around any more; move what still matters, then delete it`;
}

/** The marker above a `registerX(service)` function that also did other work. */
export function registerLeftoverMarker(name: string, removed: readonly string[] = []): string {
  return markerText("this", registerLeftoverMessage(name, removed));
}
