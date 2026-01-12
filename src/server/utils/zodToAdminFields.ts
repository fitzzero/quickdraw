import type { z } from "zod";
import type { AdminFieldConfig, AdminFieldType } from "../../shared/types";

/**
 * Fields that are automatically marked as non-editable.
 */
const NON_EDITABLE_FIELDS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "created_at",
  "updated_at",
]);

/**
 * Fields that should be hidden from admin UI by default.
 */
const DEFAULT_HIDDEN_FIELDS = new Set([
  "acl",
  "serviceAccess",
  "service_access",
]);

/**
 * Convert a field name to a human-readable label.
 * e.g., "createdAt" -> "Created At", "user_id" -> "User Id"
 */
function toLabel(fieldName: string): string {
  return fieldName
    // Handle camelCase
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Handle snake_case
    .replace(/_/g, " ")
    // Capitalize first letter of each word
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Determine the AdminFieldType from a Zod type.
 */
function getFieldType(zodType: z.ZodTypeAny): AdminFieldType {
  const typeName = zodType._def.typeName;

  // Unwrap optional, nullable, default, etc.
  if (
    typeName === "ZodOptional" ||
    typeName === "ZodNullable" ||
    typeName === "ZodDefault"
  ) {
    const inner = zodType._def.innerType as z.ZodTypeAny;
    return getFieldType(inner);
  }

  switch (typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodDate":
      return "date";
    case "ZodEnum":
    case "ZodNativeEnum":
      return "enum";
    case "ZodObject":
    case "ZodArray":
    case "ZodRecord":
      return "json";
    default:
      return "string";
  }
}

/**
 * Extract enum values from a Zod enum type.
 */
function getEnumValues(zodType: z.ZodTypeAny): string[] | undefined {
  const typeName = zodType._def.typeName;

  // Unwrap optional, nullable, default, etc.
  if (
    typeName === "ZodOptional" ||
    typeName === "ZodNullable" ||
    typeName === "ZodDefault"
  ) {
    const inner = zodType._def.innerType as z.ZodTypeAny;
    return getEnumValues(inner);
  }

  if (typeName === "ZodEnum") {
    return zodType._def.values as string[];
  }

  if (typeName === "ZodNativeEnum") {
    const enumObj = zodType._def.values as Record<string, string | number>;
    return Object.values(enumObj).filter(
      (v): v is string => typeof v === "string"
    );
  }

  return undefined;
}

/**
 * Check if a Zod type is optional.
 */
function isOptional(zodType: z.ZodTypeAny): boolean {
  const typeName = zodType._def.typeName;

  if (typeName === "ZodOptional" || typeName === "ZodNullable") {
    return true;
  }

  if (typeName === "ZodDefault") {
    // Has a default value, so effectively optional for input
    return true;
  }

  return false;
}

/**
 * Options for customizing field generation.
 */
export interface ZodToAdminFieldsOptions {
  /** Fields to exclude from the result */
  hiddenFields?: string[];
  /** Override which fields appear in table */
  tableColumns?: string[];
  /** Override specific field configurations */
  fieldOverrides?: Partial<Record<string, Partial<AdminFieldConfig>>>;
}

/**
 * Convert a Zod object schema to AdminFieldConfig array.
 *
 * @param schema - A Zod object schema (z.object({ ... }))
 * @param options - Optional customization
 * @returns Array of AdminFieldConfig for each field
 *
 * @example
 * ```typescript
 * const userSchema = z.object({
 *   id: z.string(),
 *   name: z.string().optional(),
 *   email: z.string().email(),
 *   role: z.enum(["user", "admin"]),
 *   createdAt: z.date(),
 * });
 *
 * const fields = zodToAdminFields(userSchema);
 * // Returns field configs with appropriate types, labels, editability
 * ```
 */
export function zodToAdminFields(
  schema: z.ZodTypeAny,
  options: ZodToAdminFieldsOptions = {}
): AdminFieldConfig[] {
  const { hiddenFields = [], tableColumns, fieldOverrides = {} } = options;

  // Get the shape from the schema
  let shape: Record<string, z.ZodTypeAny> = {};

  // Handle different Zod wrapper types to get to the object shape
  let currentSchema = schema;
  while (currentSchema) {
    const typeName = currentSchema._def.typeName;

    if (typeName === "ZodObject") {
      shape = currentSchema._def.shape() as Record<string, z.ZodTypeAny>;
      break;
    }

    // Unwrap effects, transformations, etc.
    if (
      typeName === "ZodEffects" ||
      typeName === "ZodOptional" ||
      typeName === "ZodNullable"
    ) {
      currentSchema = currentSchema._def.schema || currentSchema._def.innerType;
      continue;
    }

    // Not an object schema
    break;
  }

  const hiddenSet = new Set([...DEFAULT_HIDDEN_FIELDS, ...hiddenFields]);
  const fields: AdminFieldConfig[] = [];

  for (const [name, zodType] of Object.entries(shape)) {
    // Skip hidden fields
    if (hiddenSet.has(name)) {
      continue;
    }

    const fieldType = getFieldType(zodType);
    const required = !isOptional(zodType);
    const editable = !NON_EDITABLE_FIELDS.has(name);
    const enumValues = getEnumValues(zodType);

    // Determine if field should show in table
    let showInTable = true;
    if (tableColumns) {
      showInTable = tableColumns.includes(name);
    } else {
      // Default: hide json fields and very long strings from table
      showInTable = fieldType !== "json";
    }

    const baseConfig: AdminFieldConfig = {
      name,
      type: fieldType,
      label: toLabel(name),
      required,
      editable,
      showInTable,
      sortable: fieldType !== "json" && fieldType !== "relation",
      enumValues,
    };

    // Apply any overrides
    const override = fieldOverrides[name];
    if (override) {
      Object.assign(baseConfig, override);
    }

    fields.push(baseConfig);
  }

  return fields;
}

/**
 * Generate AdminFieldConfig for common entity fields that aren't in the create schema.
 * These are typically auto-generated fields like id, createdAt, updatedAt.
 */
export function getDefaultEntityFields(): AdminFieldConfig[] {
  return [
    {
      name: "id",
      type: "string",
      label: "ID",
      required: true,
      editable: false,
      showInTable: true,
      sortable: true,
    },
    {
      name: "createdAt",
      type: "date",
      label: "Created At",
      required: true,
      editable: false,
      showInTable: true,
      sortable: true,
    },
    {
      name: "updatedAt",
      type: "date",
      label: "Updated At",
      required: true,
      editable: false,
      showInTable: false,
      sortable: true,
    },
  ];
}

/**
 * Merge schema-derived fields with default entity fields.
 * Default fields come first (id, createdAt, updatedAt), then schema fields.
 */
export function mergeWithDefaultFields(
  schemaFields: AdminFieldConfig[],
  options: { includeDefaults?: string[] } = {}
): AdminFieldConfig[] {
  const { includeDefaults = ["id", "createdAt"] } = options;
  const defaultFields = getDefaultEntityFields().filter((f) =>
    includeDefaults.includes(f.name)
  );

  // Remove any fields from schemaFields that are in defaultFields
  const defaultNames = new Set(defaultFields.map((f) => f.name));
  const filteredSchemaFields = schemaFields.filter(
    (f) => !defaultNames.has(f.name)
  );

  return [...defaultFields, ...filteredSchemaFields];
}
