// What `adminMeta` answers (RFC 0003 section 12.4), worked out once when the
// handlers are made: the entity's fields as the contract half read them from
// its JSON Schema (`contract/kits/adminFields.ts`), configured for an admin
// screen as 4.1's `zodToAdminFields` configured them
// (`legacy-src/server/utils/zodToAdminFields.ts:138-265`):
//
// - hidden fields are left out: 4.1's `acl`, `serviceAccess` and
//   `service_access`, and those `hiddenFields` names; `grants: true` shows
//   and writes the entity's `serviceAccess` (or `service_access`) instead,
//   for callers with a service-wide `Admin` grant only (`runtime.ts`);
// - `id`, `createdAt` and `updatedAt` come first with 4.1's fixed
//   configurations ("ID", "Created At", "Updated At"; `updatedAt` stays out
//   of the table), then the other fields in the schema's order;
// - a label is the field's name in words (`assigneeId` is "Assignee Id");
// - `id` and the timestamps are not editable; JSON fields stay out of the
//   table;
// - `sortable` and `filterable` are the fields the contract declares for
//   `adminList`. 4.1 marked every field but JSON ones sortable, and sorted by
//   whatever a caller sent;
// - `fieldOverrides` changes the rest, but cannot make `id` or a timestamp
//   editable.
//
// It also says which fields the kit's writes refuse: the hidden ones and
// those that are not editable.

import {
  ADMIN_FIELD_TYPES,
  ADMIN_NEVER_WRITABLE,
  type AdminEntityField,
  type AdminFieldConfig,
  type AdminServiceMeta,
} from "../../../contract/kits/adminFields";
import type { AdminSpec } from "../../../contract/kits/admin";

/** Fields 4.1 always hid from admin screens (`legacy-src/server/utils/zodToAdminFields.ts:12`). */
export const ADMIN_HIDDEN_FIELDS: readonly string[] = Object.freeze([
  "acl",
  "serviceAccess",
  "service_access",
]);

/**
 * The fields a user's service-wide grants live in. Hidden unless
 * `admin.handlers(contract, { grants: true })`; then shown and written, but
 * only to callers whose own service-wide grant on the service is `Admin`.
 */
export const ADMIN_GRANT_FIELDS: readonly string[] = Object.freeze([
  "serviceAccess",
  "service_access",
]);

/** The keys `fieldOverrides` may set. */
const OVERRIDE_KEYS: readonly string[] = Object.freeze([
  "type",
  "label",
  "required",
  "editable",
  "showInTable",
  "enumValues",
  "relationService",
]);

/** 4.1's configurations of the row's key and timestamps (`zodToAdminFields.ts:217-247`). */
const DEFAULT_FIELDS: Readonly<Record<string, Omit<AdminFieldConfig, "sortable" | "filterable">>> =
  Object.freeze({
    id: {
      name: "id",
      type: "string",
      label: "ID",
      required: true,
      editable: false,
      showInTable: true,
    },
    createdAt: {
      name: "createdAt",
      type: "date",
      label: "Created At",
      required: true,
      editable: false,
      showInTable: true,
    },
    updatedAt: {
      name: "updatedAt",
      type: "date",
      label: "Updated At",
      required: true,
      editable: false,
      showInTable: false,
    },
  });

type UnknownRecord = Readonly<Record<string, unknown>>;

/** Fails the handlers being made, with a message. */
export type MetaFailure = (message: string) => never;

/** What the handlers' options say about the entity's fields, checked. */
export interface MetaOptions {
  readonly displayName: unknown;
  readonly hiddenFields: unknown;
  readonly fieldOverrides: unknown;
  readonly grants?: unknown;
}

/** `adminMeta`'s answer, and the fields the kit's reads and writes leave alone. */
export interface AdminFields {
  readonly meta: AdminServiceMeta;
  /** The fields the kit leaves out of every row and refuses to write. */
  readonly hidden: ReadonlySet<string>;
  /** The fields shown but not written: `id`, the timestamps, and those an override made read-only. */
  readonly readOnly: ReadonlySet<string>;
  /**
   * With `grants: true`, the grant fields the kit shows and writes: only for
   * callers whose service-wide grant on the service is `Admin`. Empty
   * otherwise (they are hidden).
   */
  readonly grants: ReadonlySet<string>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field's name in words: "createdAt" is "Created At", "user_id" is "User Id" (4.1's `toLabel`). */
export function labelOf(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** A service's name for people: "taskService" is "Tasks" (4.1's `toDisplayName`). */
export function displayNameOf(serviceName: string): string {
  const words = serviceName
    .replace(/Service$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
  return `${words}s`;
}

function checkDisplayName(displayName: unknown, serviceName: string, fail: MetaFailure): string {
  if (displayName === undefined) {
    return displayNameOf(serviceName);
  }
  if (typeof displayName !== "string" || displayName.length === 0) {
    fail("displayName must be a non-empty string");
  }
  return displayName;
}

/** The grant fields `grants: true` shows: those of the entity's fields that hold grants, at least one. */
function checkGrants(
  grants: unknown,
  names: readonly string[],
  fail: MetaFailure,
): ReadonlySet<string> {
  if (grants === undefined || grants === false) {
    return new Set();
  }
  if (grants !== true) {
    fail("grants must be true or false");
  }
  const fields = ADMIN_GRANT_FIELDS.filter((name) => names.includes(name));
  if (fields.length === 0) {
    fail(
      `grants: the entity has no ${ADMIN_GRANT_FIELDS.join(" or ")} field for the kit to show and write`,
    );
  }
  return new Set(fields);
}

/**
 * The fields hidden: 4.1's defaults but the grant fields `grants: true`
 * shows, and `hiddenFields`, which must name fields of the entity but `id`.
 */
function checkHidden(
  hiddenFields: unknown,
  names: readonly string[],
  grants: ReadonlySet<string>,
  fail: MetaFailure,
): ReadonlySet<string> {
  const defaults = ADMIN_HIDDEN_FIELDS.filter((name) => !grants.has(name));
  if (hiddenFields === undefined) {
    return new Set(defaults);
  }
  const valid =
    Array.isArray(hiddenFields) &&
    hiddenFields.every((name) => typeof name === "string") &&
    new Set(hiddenFields).size === hiddenFields.length;
  if (!valid) {
    fail("hiddenFields must be a list of distinct field names");
  }
  for (const name of hiddenFields as string[]) {
    if (name === "id" || !names.includes(name)) {
      fail(`hiddenFields: "${name}" is not a field of the entity that can be hidden`);
    }
    if (grants.has(name)) {
      fail(
        `hiddenFields: "${name}" holds the grants that grants: true shows; leave one of them out`,
      );
    }
  }
  return new Set([...defaults, ...(hiddenFields as string[])]);
}

function overrideProblem(override: UnknownRecord): string | undefined {
  const unknownKey = Object.keys(override).find((key) => !OVERRIDE_KEYS.includes(key));
  if (unknownKey !== undefined) {
    return `has an unknown key "${unknownKey}"; the keys are ${OVERRIDE_KEYS.join(", ")}`;
  }
  const { type, label, enumValues, relationService } = override;
  const flags = ["required", "editable", "showInTable"].filter(
    (key) => override[key] !== undefined && typeof override[key] !== "boolean",
  );
  if (flags.length > 0) {
    return `${flags.join(", ")} must be true or false`;
  }
  const text = (value: unknown): boolean =>
    value === undefined || (typeof value === "string" && value.length > 0);
  const enumOk =
    enumValues === undefined ||
    (Array.isArray(enumValues) && enumValues.every((value) => typeof value === "string"));
  const typeOk = type === undefined || ADMIN_FIELD_TYPES.some((known) => known === type);
  return text(label) && text(relationService) && enumOk && typeOk
    ? undefined
    : "has a type, label, enumValues or relationService of the wrong kind";
}

/** The overrides, per field of the entity that is not hidden. */
function checkOverrides(
  fieldOverrides: unknown,
  names: readonly string[],
  hidden: ReadonlySet<string>,
  fail: MetaFailure,
): Readonly<Record<string, UnknownRecord>> {
  if (fieldOverrides === undefined) {
    return {};
  }
  if (!isRecord(fieldOverrides)) {
    fail("fieldOverrides must map field names to configuration changes");
  }
  for (const [name, override] of Object.entries(fieldOverrides)) {
    if (!names.includes(name) || hidden.has(name)) {
      fail(`fieldOverrides: "${name}" is not a field of the entity the kit shows`);
    }
    const problem = isRecord(override) ? overrideProblem(override) : "must be an object";
    if (problem !== undefined) {
      fail(`fieldOverrides for "${name}" ${problem}`);
    }
    if ((override as UnknownRecord).editable === true && ADMIN_NEVER_WRITABLE.includes(name)) {
      fail(`fieldOverrides: "${name}" is never editable; the database sets it`);
    }
  }
  return fieldOverrides as Readonly<Record<string, UnknownRecord>>;
}

/** One field's configuration, before overrides. */
function derived(field: AdminEntityField): Omit<AdminFieldConfig, "sortable" | "filterable"> {
  const fixed = Object.hasOwn(DEFAULT_FIELDS, field.name) ? DEFAULT_FIELDS[field.name] : undefined;
  if (fixed !== undefined) {
    return fixed;
  }
  return {
    name: field.name,
    type: field.type,
    label: labelOf(field.name),
    required: field.required,
    editable: !ADMIN_NEVER_WRITABLE.includes(field.name),
    showInTable: field.type !== "json",
    ...(field.enumValues === undefined ? {} : { enumValues: field.enumValues }),
  };
}

/** The fields in an admin screen's order: `id`, `createdAt` and `updatedAt` first. */
function ordered(fields: readonly AdminEntityField[]): AdminEntityField[] {
  const first = Object.keys(DEFAULT_FIELDS).flatMap((name) =>
    fields.filter((field) => field.name === name),
  );
  return [...first, ...fields.filter((field) => !first.includes(field))];
}

function frozenConfig(config: AdminFieldConfig): AdminFieldConfig {
  const { enumValues } = config;
  return Object.freeze(
    enumValues === undefined ? config : { ...config, enumValues: Object.freeze([...enumValues]) },
  );
}

/**
 * `adminMeta`'s answer for a service, and the fields its reads and writes
 * leave alone, from what the contract half read of the entity (`spec`) and
 * the handlers' options. Fails through `fail` for options that name no field
 * of the entity, would make `id` or a timestamp editable, or hide a field
 * `adminList` filters or sorts on (a filter on it would tell what it holds).
 */
export function adminFieldsOf(
  serviceName: string,
  spec: Pick<AdminSpec, "fields" | "filter" | "sort">,
  options: MetaOptions,
  fail: MetaFailure,
): AdminFields {
  const names = spec.fields.map((field) => field.name);
  const grants = checkGrants(options.grants, names, fail);
  const hidden = checkHidden(options.hiddenFields, names, grants, fail);
  const listed = [...spec.filter, ...spec.sort].find((name) => hidden.has(name));
  if (listed !== undefined) {
    fail(`"${listed}" is hidden, so adminList may not filter or sort on it`);
  }
  const overrides = checkOverrides(options.fieldOverrides, names, hidden, fail);
  const fields = ordered(spec.fields)
    .filter((field) => !hidden.has(field.name))
    .map((field) =>
      frozenConfig({
        ...derived(field),
        ...overrides[field.name],
        sortable: spec.sort.includes(field.name),
        filterable: spec.filter.includes(field.name),
      }),
    );
  const meta: AdminServiceMeta = Object.freeze({
    serviceName,
    displayName: checkDisplayName(options.displayName, serviceName, fail),
    fields: Object.freeze(fields),
  });
  const readOnly = new Set(fields.filter((field) => !field.editable).map((field) => field.name));
  return Object.freeze({ meta, hidden, readOnly, grants });
}
