// What a Prisma client's own schema says about its models' fields, for the
// storage adapter's `nullable` and `trackable` (`trackPrisma.ts`). Prisma 7's
// generated client carries the schema's text (`config.inlineSchema`), which
// its runtime keeps on every client, extended ones included, as
// `_engineConfig.inlineSchema`. Its runtime data model (`_runtimeDataModel`)
// names each field's kind but not whether the field is optional, and there is
// no runtime DMMF. Reading the text answers with no statement; the probes it
// replaces send a filter or select Prisma refuses, which a client created
// with `log: ["error"]` prints as a `prisma:error` line. Whatever the text
// does not answer (no text, or a model or field it does not declare) is left
// to those probes.
//
// Only what the answers need is read: the field lines of `model` and `view`
// blocks (`name Type`, `Type?` optional, `Type[]` a list), the names of
// `enum`s, and `@ignore`. Comments, block attributes (`@@id`, `@@map`) and
// the other field attributes (`@map`, `@default`) are skipped: the answers
// are by Prisma field name, as the probes ask.

import { modelKey } from "../server/storage";

/** What a client's schema says, by model (either spelling) and Prisma field name. */
export interface PrismaSchemaFacts {
  /** Whether `column` of `model` may hold null; `undefined` when the schema does not say. */
  nullable(model: string, column: string): boolean | undefined;
  /**
   * Whether the tracker can key `model`'s rows by an `id` field: false when
   * the model has none (a composite `@@id`), true for a required `String`,
   * `Int`, `BigInt`, `Float` or enum `id`; `undefined` when the schema does
   * not say, or the answer depends on the rows (an optional `id`).
   */
  trackable(model: string): boolean | undefined;
}

/** One scalar field of a model, as its schema declares it. */
interface SchemaField {
  readonly type: string;
  readonly optional: boolean;
  readonly list: boolean;
}

interface SchemaModel {
  readonly fields: ReadonlyMap<string, SchemaField>;
  readonly trackable: boolean | undefined;
}

interface Block {
  readonly kind: string;
  readonly name: string;
  readonly lines: string[];
}

/** The runtime data model's field kinds of one model: `scalar`, `enum`, `object` (a relation). */
type FieldKinds = ReadonlyMap<string, string>;

const BLOCK_START = /^(\w+)\s+([A-Za-z_]\w*)\s*\{/;

const FIELD = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\([^)]*\))?(\[\])?(\?)?(?=\s|$)/;

const IGNORED = /(?:^|\s)@ignore(?=\s|$|\()/;

/** The `id` types whose values the tracker keys rows by (`idOf`). */
const KEY_TYPES: ReadonlySet<string> = new Set(["String", "Int", "BigInt", "Float"]);

const COLUMN_KINDS: ReadonlySet<string> = new Set(["scalar", "enum"]);

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

/** `line` without its `//` or `///` comment, which never starts inside a string. */
function withoutComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== "\\") {
      inString = !inString;
    } else if (!inString && char === "/" && line[index + 1] === "/") {
      return line.slice(0, index);
    }
  }
  return line;
}

/** The schema's top-level blocks, each with its lines, comments and blank lines dropped. */
function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = withoutComment(raw).trim();
    if (line === "") {
      continue;
    }
    if (open !== undefined) {
      if (line === "}") {
        open = undefined;
      } else {
        open.lines.push(line);
      }
      continue;
    }
    const start = BLOCK_START.exec(line);
    if (start !== null) {
      const block: Block = { kind: start[1] ?? "", name: start[2] ?? "", lines: [] };
      blocks.push(block);
      // `model X {}` closes on the line it opens.
      open = line.slice(start[0].length).trim() === "}" ? undefined : block;
    }
  }
  return blocks;
}

/** The field kinds the runtime data model lists for `model`, or `undefined`. */
function kindsOf(runtimeDataModel: unknown, model: string): FieldKinds | undefined {
  const models: unknown = isObject(runtimeDataModel)
    ? Reflect.get(runtimeDataModel, "models")
    : undefined;
  const entry: unknown =
    isObject(models) && Object.hasOwn(models, model) ? Reflect.get(models, model) : undefined;
  const fields: unknown = isObject(entry) ? Reflect.get(entry, "fields") : undefined;
  if (!Array.isArray(fields)) {
    return undefined;
  }
  const kinds = new Map<string, string>();
  for (const field of fields as unknown[]) {
    const name: unknown = isObject(field) ? Reflect.get(field, "name") : undefined;
    const kind: unknown = isObject(field) ? Reflect.get(field, "kind") : undefined;
    if (typeof name === "string" && typeof kind === "string") {
      kinds.set(name, kind);
    }
  }
  return kinds;
}

/**
 * Whether the field `name` of type `type` is a column: as the runtime data
 * model says when it lists the model (a relation is `object`), else unless
 * its type names a model, view or composite type, or is `Unsupported`.
 */
function isColumn(
  name: string,
  type: string,
  kinds: FieldKinds | undefined,
  records: ReadonlySet<string>,
): boolean {
  if (kinds !== undefined) {
    return COLUMN_KINDS.has(kinds.get(name) ?? "");
  }
  return type !== "Unsupported" && !records.has(type);
}

function trackableOf(
  fields: ReadonlyMap<string, SchemaField>,
  kinds: FieldKinds | undefined,
  enums: ReadonlySet<string>,
): boolean | undefined {
  const id = fields.get("id");
  if (id === undefined) {
    // The runtime knows an `id` column the text did not show: let the probe say.
    return kinds !== undefined && COLUMN_KINDS.has(kinds.get("id") ?? "") ? undefined : false;
  }
  if (id.optional || id.list) {
    return undefined;
  }
  return KEY_TYPES.has(id.type) || enums.has(id.type) ? true : undefined;
}

function modelOf(
  block: Block,
  kinds: FieldKinds | undefined,
  records: ReadonlySet<string>,
  enums: ReadonlySet<string>,
): SchemaModel {
  const fields = new Map<string, SchemaField>();
  for (const line of block.lines) {
    const field = FIELD.exec(line);
    const [, name = "", type = "", , list, optional] = field ?? [];
    if (field !== null && !IGNORED.test(line) && isColumn(name, type, kinds, records)) {
      fields.set(name, { type, optional: optional !== undefined, list: list !== undefined });
    }
  }
  return { fields, trackable: trackableOf(fields, kinds, enums) };
}

/**
 * Reads a Prisma schema's text: what each model's fields say about null, and
 * whether the model has an `id` the tracker can key. A relation field is not
 * a column: the runtime data model's kinds say so when given (a client's
 * `_runtimeDataModel`), else a field whose type is a model. A model the text
 * does not declare, or marks `@@ignore`, is not answered.
 */
export function parsePrismaSchema(text: string, runtimeDataModel?: unknown): PrismaSchemaFacts {
  const blocks = blocksOf(text);
  const named = (...kinds: string[]): Set<string> =>
    new Set(blocks.filter((block) => kinds.includes(block.kind)).map((block) => block.name));
  const enums = named("enum");
  const records = named("model", "view", "type");
  const models = new Map<string, SchemaModel>();
  for (const block of blocks) {
    const ignored = block.lines.some((line) => /^@@ignore\b/.test(line));
    if ((block.kind === "model" || block.kind === "view") && !ignored) {
      const kinds = kindsOf(runtimeDataModel, block.name);
      models.set(modelKey(block.name), modelOf(block, kinds, records, enums));
    }
  }
  return Object.freeze({
    nullable(model: string, column: string): boolean | undefined {
      const field = models.get(modelKey(model))?.fields.get(column);
      return field === undefined ? undefined : field.optional && !field.list;
    },
    trackable: (model: string): boolean | undefined => models.get(modelKey(model))?.trackable,
  });
}

/**
 * The schema text a Prisma client carries (`_engineConfig.inlineSchema`, on
 * an extended client too), or `undefined`. Never throws.
 */
export function schemaTextOf(client: unknown): string | undefined {
  try {
    const config: unknown = isObject(client) ? Reflect.get(client, "_engineConfig") : undefined;
    const text: unknown = isObject(config) ? Reflect.get(config, "inlineSchema") : undefined;
    return typeof text === "string" && text !== "" ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The runtime data model a Prisma client carries, or `undefined`. Never throws. */
function runtimeDataModelOf(client: unknown): unknown {
  try {
    const own: unknown = isObject(client) ? Reflect.get(client, "_runtimeDataModel") : undefined;
    if (own !== undefined) {
      return own;
    }
    const config: unknown = isObject(client) ? Reflect.get(client, "_engineConfig") : undefined;
    return isObject(config) ? Reflect.get(config, "runtimeDataModel") : undefined;
  } catch {
    return undefined;
  }
}

/** What `client`'s own schema says, or `undefined` when it carries no schema text. */
export function prismaSchemaOf(client: unknown): PrismaSchemaFacts | undefined {
  const text = schemaTextOf(client);
  return text === undefined ? undefined : parsePrismaSchema(text, runtimeDataModelOf(client));
}
