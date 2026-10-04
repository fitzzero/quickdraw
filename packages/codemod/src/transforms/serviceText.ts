// The code a migrated service is written as: its access policy line, its
// `qd.defineService(...)` statement, and the exported method objects of its
// method modules.

import type { Node } from "ts-morph";
import type { MethodEntry } from "../handlers";
import { markerText } from "../markers";
import type { ServiceModel } from "../model";
import type { MethodPlan, ServicePlan } from "../plan";
import { lowerFirst, quote } from "../text";

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
    const message = `4.x decided row access in ${overrides.join(" and ")} (now functions in this file): port them to a policy (owner, jsonAcl, members, inherit, anyOf or resolver). Until then this policy grants no row, so only service grants pass`;
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

/** One method of a method module, exported and typed for the service to list. */
export function moduleConst(
  plan: ServicePlan,
  method: MethodPlan,
  entry: MethodEntry,
  isPublic: boolean,
): string {
  return `export const ${method.name} = ${entry.text} satisfies ${isPublic ? "PublicMethodOf" : "MethodOf"}<typeof ${plan.contractVar}, ${quote(method.name)}>;`;
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

/** The marker above a `registerX(service)` function that also did other work. */
export function registerLeftoverMarker(name: string): string {
  return markerText(
    "this",
    `${name} also did more than register methods: a service object is not passed around any more; move what still matters, then delete it`,
  );
}
