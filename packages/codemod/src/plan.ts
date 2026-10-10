// Plans each service's contract before anything is written: per method, its
// kind (from its name), the row id 4.x would have checked, its input (the
// moved schema, or a `todoSchema` of the 4.x payload type) and its output
// (`"entity"` when the 4.x response was the service's DTO, else a
// `todoSchema` of the response type). A mutation of one row whose 4.x
// response was `DTO | null` answers `"entity"`: 4.x's `this.update` gave null
// for a missing row, where a tracked write throws `NOT_FOUND`, and only an
// exact `"entity"` output is optimistic by default.

import { join } from "node:path";
import {
  type InterfaceDeclaration,
  Node,
  type TypeAliasDeclaration,
  type TypeNode,
} from "ts-morph";
import { type EntryId, entryKeyOf } from "./access";
import { carveOutOf, regionMarkers, regionOf } from "./carveOuts";
import type { RunContext } from "./context";
import {
  findMethodMap,
  findSharedType,
  implicitEntryId,
  keysOf,
  type MethodMapEntry,
} from "./methodMaps";
import type { MethodCall, ServiceModel } from "./model";
import { markerText } from "./markers";
import { moveSchema, type MovedSchema } from "./schemas";
import { quote } from "./text";

export type MethodKind = "query" | "mutation";

/** One method of a planned contract. */
export interface MethodPlan {
  readonly call: MethodCall;
  readonly name: string;
  readonly kind: MethodKind;
  readonly entryId: EntryId;
  /** Whether the input has an `id` key: the 4.x payload type's, or the inline schema's. */
  readonly inputHasId: boolean;
  readonly input: string;
  /** The `todoSchema` input to fall back to when the moved schema cannot be written. */
  readonly fallbackInput: string;
  readonly output: string;
  /** The schema that moved into the contract, when one did. */
  readonly moved: MovedSchema | undefined;
  /** What the contract's marker says about this method. */
  readonly notes: readonly string[];
  /** The 4.x payload type, which a `todoSchema` input copies. */
  readonly payload: TypeNode | undefined;
  /** The 4.x response type, when the output is a `todoSchema` of it. */
  readonly todoResponse: TypeNode | undefined;
  /** Markers for the service's method object, above its handler. */
  readonly handlerNotes: readonly string[];
}

/** A service's planned contract. */
export interface ServicePlan {
  readonly service: ServiceModel;
  /** `"project"` for `projectService`: the contract file's name. */
  readonly base: string;
  readonly contractVar: string;
  readonly contractFile: string;
  readonly entity:
    | {
        readonly code: string;
        readonly note: string;
        readonly dto: InterfaceDeclaration | TypeAliasDeclaration | undefined;
      }
    | undefined;
  readonly methods: readonly MethodPlan[];
  /** Methods of the 4.x method map that no defineMethod call implements. */
  readonly unimplemented: readonly string[];
  /** The template carve-out (`quickdraw-game`) the 4.x service sat in, if any. */
  readonly carveOut: string | undefined;
}

const QUERY = /^(?:get|list|search|find|count)(?![a-z0-9])/u;

/** `query` when the name starts with get, list, search, find or count; `mutation` otherwise. */
export function classify(name: string): MethodKind {
  return QUERY.test(name) ? "query" : "mutation";
}

function baseName(serviceName: string): string {
  const base = serviceName.replace(/Service$/u, "");
  return base === "" ? serviceName : base;
}

function compact(text: string): string {
  return text.replace(/\s+/gu, "");
}

/** The contract output for a 4.x response type; `oneRow` for a mutation whose input names a row. */
function outputFor(
  response: TypeNode | undefined,
  dto: string | undefined,
  hasEntity: boolean,
  oneRow: boolean,
): { code: string; todo: boolean; nonNull?: boolean } {
  if (response === undefined) {
    return { code: "todoSchema<unknown>()", todo: true };
  }
  const text = compact(response.getText());
  if (hasEntity && dto !== undefined) {
    if (text === dto) {
      return { code: quote("entity"), todo: false };
    }
    if (text === `${dto}|null` || text === `null|${dto}`) {
      return oneRow
        ? { code: quote("entity"), todo: false, nonNull: true }
        : { code: 'nullable("entity")', todo: false };
    }
    if (text === `${dto}[]` || text === `Array<${dto}>` || text === `readonly${dto}[]`) {
      return { code: 'listOf("entity")', todo: false };
    }
  }
  return { code: `todoSchema<${response.getText()}>()`, todo: true };
}

/** What the contract and the handler say of a 4.x `DTO | null` mutation of one row, now `"entity"`. */
function nonNullNotes(dto: string): { contract: string; handler: string } {
  return {
    contract: `output: "entity", where 4.x answered ${dto} | null (null for a missing row, which a tracked write answers with NOT_FOUND instead); only an exact "entity" output is optimistic by default. Use nullable("entity") if the handler still answers null`,
    handler: markerText(
      "contract",
      `the contract's output is "entity" (4.x answered ${dto} | null): return the row, and let a missing one fail with NOT_FOUND (db.<model>.update throws it)`,
    ),
  };
}

/** Whether an inline `z.object({ id: ... })` schema has an `id` key. */
function schemaHasId(schema: Node | undefined): boolean {
  if (schema === undefined || !Node.isCallExpression(schema)) {
    return false;
  }
  const [shape] = schema.getArguments();
  return (
    shape !== undefined &&
    Node.isObjectLiteralExpression(shape) &&
    shape.getProperty("id") !== undefined
  );
}

function entryIdOf(call: MethodCall, entry: MethodMapEntry | undefined): EntryId {
  if (call.resolveEntryId !== undefined) {
    const key = entryKeyOf(call.resolveEntryId);
    return key === undefined
      ? { kind: "function", text: call.resolveEntryId.getText() }
      : { kind: "key", key };
  }
  return (
    implicitEntryId(entry?.payload) ??
    (schemaHasId(call.schema) ? { kind: "key", key: "id" } : undefined)
  );
}

function planMethod(
  ctx: RunContext,
  call: MethodCall,
  entry: MethodMapEntry | undefined,
  dto: string | undefined,
  hasEntity: boolean,
  queried: boolean,
): MethodPlan {
  const byName = classify(call.name);
  const kind = queried ? "query" : byName;
  const notes = [
    queried && byName === "mutation"
      ? "query, since the web app reads it with useServiceQuery (its name reads as a mutation)"
      : `${kind}, chosen from its name`,
  ];
  let moved: MovedSchema | undefined;
  const payload = entry?.payload;
  const fallbackInput =
    payload === undefined ? "todoSchema<unknown>()" : `todoSchema<${payload.getText()}>()`;
  let input = fallbackInput;
  const move =
    call.schema === undefined ? undefined : moveSchema(call.schema, call.call.getSourceFile());
  if (move?.ok === true) {
    moved = move.schema;
    input = move.schema.code;
    ctx.stats.schemasMoved += 1;
  } else {
    notes.push(
      move === undefined
        ? "input: todoSchema, as 4.x had no schema"
        : `input: todoSchema, since the 4.x schema stays in the api package (${move.reason})`,
    );
    ctx.stats.todoSchemas += 1;
  }
  const inputHasId = payload?.getType().getProperty("id") !== undefined || schemaHasId(call.schema);
  const output = outputFor(entry?.response, dto, hasEntity, kind === "mutation" && inputHasId);
  if (output.todo) {
    notes.push("output: todoSchema of the 4.x response type");
    ctx.stats.todoSchemas += 1;
  }
  const handlerNotes: string[] = [];
  if (output.nonNull === true) {
    const nonNull = nonNullNotes(dto ?? "the DTO");
    notes.push(nonNull.contract);
    handlerNotes.push(nonNull.handler);
  }
  if (entry === undefined) {
    notes.push("the 4.x method map has no entry for it");
  }
  return {
    call,
    name: call.name,
    kind,
    entryId: entryIdOf(call, entry),
    inputHasId,
    input,
    fallbackInput,
    output: output.code,
    moved,
    notes,
    payload,
    todoResponse: output.todo ? entry?.response : undefined,
    handlerNotes,
  };
}

/**
 * The entity's keys as an array literal. A key the DTO declares inside a
 * template carve-out other than the service's own keeps that carve-out's
 * markers, on lines of their own, so stripping the carve-out drops it.
 */
function keysCode(
  dto: InterfaceDeclaration | TypeAliasDeclaration,
  keys: readonly string[],
  carveOut: string | undefined,
): string {
  const regionOfKey = (key: string): string | undefined => {
    const declaration = dto.getType().getProperty(key)?.getDeclarations()[0];
    const region = declaration === undefined ? undefined : regionOf(declaration);
    return region === carveOut ? undefined : region;
  };
  const regions = keys.map(regionOfKey);
  if (regions.every((region) => region === undefined)) {
    return `[${keys.map((key) => quote(key)).join(", ")}]`;
  }
  const lines = keys.flatMap((key, index) => {
    const region = regions[index];
    const markers = region === undefined ? undefined : regionMarkers(region);
    return [
      ...(markers !== undefined && regions[index - 1] !== region ? [markers.start] : []),
      `${quote(key)},`,
      ...(markers !== undefined && regions[index + 1] !== region ? [markers.end] : []),
    ];
  });
  return ["[", ...lines, "]"].join("\n");
}

function entityOf(
  ctx: RunContext,
  service: ServiceModel,
  hasEntity: boolean,
  carveOut: string | undefined,
): ServicePlan["entity"] {
  if (!hasEntity) {
    return undefined;
  }
  const dto = findSharedType(ctx.project, ctx.layout, service.dtoName);
  if (dto === undefined) {
    return {
      code: 'todoSchema<{ id: string }>({ keys: ["id"] })',
      dto: undefined,
      note: `the 4.x DTO (${service.dtoName ?? "none"}) is not a type of the shared package: describe the entity, whose keys are the fields subscribers receive`,
    };
  }
  const keys = keysOf(dto);
  const list = keysCode(dto, keys.includes("id") ? keys : ["id", ...keys], carveOut);
  return {
    code: `todoSchema<${dto.getName()}>({ keys: ${list} })`,
    dto,
    note: `the entity is the 4.x DTO ${dto.getName()}: give it a real schema. Its keys are the fields subscribers receive, read from model "${service.model ?? ""}": drop any that is not a column, or give it a projection select and map`,
  };
}

/** Plans the contract of `service`; `queried` holds `service.method` for the methods the web app reads with useServiceQuery. */
export function planService(
  ctx: RunContext,
  service: ServiceModel,
  queried: ReadonlySet<string> = new Set(),
): ServicePlan {
  const map = findMethodMap(ctx.project, ctx.layout, service.methodMapName);
  const hasEntity = !service.rpc && service.model !== undefined;
  const carveOut = carveOutOf(ctx.project, ctx.layout, service);
  const entity = entityOf(ctx, service, hasEntity, carveOut);
  const byName = new Map(service.methods.map((call) => [call.name, call]));
  const methods = [...byName.values()].map((call) =>
    planMethod(
      ctx,
      call,
      map?.entries.get(call.name),
      entity?.dto?.getName(),
      hasEntity,
      queried.has(`${service.serviceName}.${call.name}`),
    ),
  );
  const base = baseName(service.serviceName);
  return {
    service,
    base,
    contractVar: `${base}Contract`,
    contractFile: join(ctx.layout.shared.src, "contracts", `${base}.ts`),
    entity,
    methods,
    unimplemented: [...(map?.entries.keys() ?? [])].filter((name) => !byName.has(name)),
    carveOut,
  };
}
