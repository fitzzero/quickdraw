// The methods a kit implements, as lint's `prefer-kit` rule finds them
// (`@fitzzero/quickdraw-lint`, `plugin/rules/prefer-kit.mjs`; a test keeps
// the two in step): a kit method's own name (`get`, `list`, `create`,
// `search`, `share`, `adminList`, ...), or a name the service's model forms
// the way a hand-written kit method does (`getTask`, `listTasks`,
// `createTask`, `updateTask`, `deleteTask` for model `"task"`). `remove` is
// the sharing kit's only on a membership model (`projectMember`) or beside
// another sharing method (`share`, `invite`, `listMembers`, ...). A migrated
// method of that shape gets a marker: the kit checks access on every row it
// touches, pages and stays live, and lint warns until the method is replaced
// or says why it is not.

import { markerText } from "./markers";

const CRUD = { kit: "the read/write kit", use: "crud.handlers (crud.contract in the contract)" };
const SEARCH = { kit: "the search kit", use: "search.handlers (search.contract in the contract)" };
const SHARING = {
  kit: "the sharing kit",
  use: "sharing.handlers (sharing.contract in the contract)",
};
const ADMIN = { kit: "the admin kit", use: "admin.handlers (admin.contract in the contract)" };

type Kit = typeof CRUD;

const KIT_METHODS = new Map<string, Kit>([
  ...[
    "get",
    "getMany",
    "list",
    "create",
    "update",
    "delete",
    "reorder",
    "bulkUpdate",
    "bulkDelete",
  ].map((name): [string, Kit] => [name, CRUD]),
  ["search", SEARCH],
  ...[
    "share",
    "shareByName",
    "unshare",
    "listShares",
    "invite",
    "inviteByName",
    "remove",
    "listMembers",
  ].map((name): [string, Kit] => [name, SHARING]),
  ...["adminList", "adminGet", "adminCreate", "adminUpdate", "adminDelete", "adminMeta"].map(
    (name): [string, Kit] => [name, ADMIN],
  ),
]);

/** The sharing kit's other methods: beside one of them, `remove` removes a member. */
const SHARING_SIBLINGS = new Set(
  [...KIT_METHODS]
    .filter(([name, kit]) => kit === SHARING && name !== "remove")
    .map(([name]) => name),
);

/** A model of member rows (`member`, `projectMember`, `membership`): its `remove` removes a member. */
const MEMBERSHIP_MODEL = /member/iu;

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A model name's plural, as a method name spells it: `task` gives `tasks`, `category` `categories`. */
function plural(word: string): string {
  if (/[^aeiou]y$/u.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }
  return /(?:s|x|z|ch|sh)$/u.test(word) ? `${word}es` : `${word}s`;
}

/**
 * The kit method `name` has the shape of, on a service of `model` whose
 * methods are named `methods`; `undefined` for none.
 */
export function kitShapeOf(
  name: string,
  model: string | undefined,
  methods: readonly string[] = [],
): { readonly method: string; readonly kit: string; readonly use: string } | undefined {
  if (model === undefined) {
    return undefined;
  }
  if (
    name === "remove" &&
    !MEMBERSHIP_MODEL.test(model) &&
    !methods.some((method) => SHARING_SIBLINGS.has(method))
  ) {
    return undefined;
  }
  const kit = KIT_METHODS.get(name);
  if (kit !== undefined) {
    return { method: name, ...kit };
  }
  const shapes = new Map([
    [`get${capitalized(model)}`, "get"],
    [`list${capitalized(plural(model))}`, "list"],
    [`create${capitalized(model)}`, "create"],
    [`update${capitalized(model)}`, "update"],
    [`delete${capitalized(model)}`, "delete"],
  ]);
  const method = shapes.get(name);
  return method === undefined ? undefined : { method, ...CRUD };
}

/**
 * The marker above a migrated method of a kit method's shape, on a service
 * whose methods are named `methods`, with its line break; `""` for any other.
 */
export function kitMarker(
  name: string,
  model: string | undefined,
  methods: readonly string[],
): string {
  const shape = kitShapeOf(name, model, methods);
  if (shape === undefined) {
    return "";
  }
  return `${markerText(
    "kit",
    `${name} has the shape of ${shape.kit}'s ${shape.method}, which checks access on every row it touches, pages and stays live: replace it with ${shape.use}, or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)`,
  )}\n`;
}
