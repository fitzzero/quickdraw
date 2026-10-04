// The model `docs/protocol-v5.md` is rendered from (`protocolRender.ts`),
// assembled from the parsed sources (`protocolSource.ts`): the events of
// `CLIENT_EVENTS` and `SERVER_EVENTS` (`contract/names.ts`) joined with their
// listeners' payload and acknowledgement (`ClientListeners` and
// `ServerListeners` in `protocol/envelope.ts`), the frame types, the
// constants, the room and topic names, the error codes with their HTTP
// statuses and meanings, and the defaults a server applies.

import ts from "typescript";
import {
  docOf,
  interfacesOf,
  literalText,
  printType,
  propertiesOf,
  typesOf,
  unwrap,
  variableOf,
  type Sources,
  type TypeDoc,
} from "./protocolSource";

/** One event, with its listener's payload and acknowledgement. */
export interface EventDoc {
  readonly name: string;
  readonly doc: string;
  readonly payload: string;
  /** Whether the event is acknowledged: never, always, or when the sender asks. */
  readonly ack: "none" | "required" | "optional";
  /** The acknowledgement's type, when there is one. */
  readonly reply: string | undefined;
}

/** A constant, its value as written, and its doc comment. */
export interface ConstantDoc {
  readonly value: string;
  readonly doc: string;
}

/** A room or topic name one of `contract/names.ts`'s functions builds. */
export interface NameDoc {
  readonly name: string;
  /** What it builds: one format, or one per branch (`qd:s:{service}:{stream}` without a scope). */
  readonly formats: readonly string[];
  readonly doc: string;
}

/** One error code, its HTTP status and its meaning. */
export interface ErrorDoc {
  readonly code: string;
  readonly status: string;
  readonly meaning: string;
}

/** Everything the document is written from. */
export interface ProtocolModel {
  /** The exported interfaces and type aliases of the protocol files, by name, in source order. */
  readonly types: ReadonlyMap<string, TypeDoc>;
  readonly clientEvents: readonly EventDoc[];
  readonly serverEvents: readonly EventDoc[];
  /** The constants with a literal value, by name. */
  readonly constants: ReadonlyMap<string, ConstantDoc>;
  readonly names: readonly NameDoc[];
  readonly errors: readonly ErrorDoc[];
  /** `DEFAULT_LIMITS`, flattened: `callTimeoutMs`, `subscriptions.maxInFlight`, ... */
  readonly defaults: ReadonlyMap<string, string>;
  /** The events the socket rate limiter never counts. */
  readonly unlimited: readonly string[];
}

function stringOf(expression: ts.Expression, what: string): string {
  if (!ts.isStringLiteral(expression)) {
    throw new Error(`quickdraw-protocol: ${what} is not a string literal`);
  }
  return expression.text;
}

/** A listener `(frame: X, ack?: Ack<Y>) => void`: its payload, and whether and how it is acknowledged. */
function listenerOf(
  member: ts.TypeElement | undefined,
  what: string,
): Omit<EventDoc, "name" | "doc"> {
  const type = member !== undefined && ts.isPropertySignature(member) ? member.type : undefined;
  if (type === undefined || !ts.isFunctionTypeNode(type)) {
    throw new Error(`quickdraw-protocol: ${what} has no listener (frame, ack?) => void`);
  }
  const [frame, ack] = type.parameters;
  if (frame?.type === undefined) {
    throw new Error(`quickdraw-protocol: ${what}'s listener takes no frame`);
  }
  const payload = printType(frame.type);
  const reply =
    ack?.type !== undefined && ts.isTypeReferenceNode(ack.type)
      ? ack.type.typeArguments?.[0]
      : undefined;
  if (ack === undefined || reply === undefined) {
    return { payload, ack: "none", reply: undefined };
  }
  const kind = ack.questionToken === undefined ? "required" : "optional";
  return { payload, ack: kind, reply: printType(reply) };
}

/** The events of `constant` (`CLIENT_EVENTS`), each joined with its listener in `listeners`. */
function eventsOf(sources: Sources, constant: string, listeners: string): EventDoc[] {
  const declared = interfacesOf(sources).get(listeners);
  if (declared === undefined) {
    throw new Error(`quickdraw-protocol: ${listeners} not found in ${sources.envelope.fileName}`);
  }
  const members = new Map(declared.members.map((member) => [member.name?.getText(), member]));
  return propertiesOf(variableOf(sources.names, constant).value, constant).map((event) => ({
    name: stringOf(event.value, `${constant}.${event.name}`),
    doc: event.doc,
    ...listenerOf(members.get(event.name), `${listeners}.${event.name}`),
  }));
}

/** The names a template literal builds: `qd:e:${service}` is `qd:e:{service}`; a conditional builds two. */
function formatsOf(expression: ts.Expression): string[] | undefined {
  if (ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isTemplateExpression(expression)) {
    const spans = expression.templateSpans.map(
      (span) => `{${span.expression.getText()}}${span.literal.text}`,
    );
    return [`${expression.head.text}${spans.join("")}`];
  }
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = formatsOf(expression.whenTrue);
    const whenFalse = formatsOf(expression.whenFalse);
    return whenTrue === undefined || whenFalse === undefined
      ? undefined
      : [...whenTrue, ...whenFalse];
  }
  return undefined;
}

/** The room and topic builders of `contract/names.ts`: the functions that return a template. */
function namesOf(sources: Sources): NameDoc[] {
  return sources.names.statements.flatMap((statement) => {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) {
      return [];
    }
    const [only] = statement.body?.statements ?? [];
    const returned = only !== undefined && ts.isReturnStatement(only) ? only.expression : undefined;
    const formats = returned === undefined ? undefined : formatsOf(returned);
    return formats === undefined
      ? []
      : [{ name: statement.name.text, formats, doc: docOf(statement) }];
  });
}

/** The error codes in `ERROR_CODES` order, with `HTTP_STATUS` and the meanings `ErrorCode`'s doc lists. */
function errorsOf(sources: Sources, types: ReadonlyMap<string, TypeDoc>): ErrorDoc[] {
  const codes = variableOf(sources.errors, "ERROR_CODES").value;
  if (!ts.isArrayLiteralExpression(codes)) {
    throw new Error("quickdraw-protocol: ERROR_CODES is not an array literal");
  }
  const statuses = new Map(
    propertiesOf(variableOf(sources.errors, "HTTP_STATUS").value, "HTTP_STATUS").map((entry) => [
      entry.name,
      literalText(entry.value) ?? "",
    ]),
  );
  const meanings = new Map(
    [...(types.get("ErrorCode")?.doc ?? "").matchAll(/^- `([A-Z_]+)` \(\d+\): (.+)$/gm)].map(
      ([, code = "", meaning = ""]) => [code, meaning],
    ),
  );
  return codes.elements.map((element) => {
    const code = stringOf(element, "an ERROR_CODES entry");
    return { code, status: statuses.get(code) ?? "", meaning: meanings.get(code) ?? "" };
  });
}

/** An object literal of literals, flattened: `{ a: 1, b: { c: 2 } }` gives `a` and `b.c`. */
function flatten(expression: ts.Expression, prefix: string, into: Map<string, string>): void {
  for (const entry of propertiesOf(expression, prefix === "" ? "DEFAULT_LIMITS" : prefix)) {
    if (ts.isObjectLiteralExpression(entry.value)) {
      flatten(entry.value, `${prefix}${entry.name}.`, into);
    } else {
      into.set(`${prefix}${entry.name}`, literalText(entry.value) ?? entry.value.getText());
    }
  }
}

/** The events `UNLIMITED_EVENTS` names, written `CLIENT_EVENTS.<key>`, as event names. */
function unlimitedOf(sources: Sources, events: readonly { readonly name: string }[]): string[] {
  const keys = propertiesOf(variableOf(sources.names, "CLIENT_EVENTS").value, "CLIENT_EVENTS");
  const byKey = new Map(keys.map((key, index) => [key.name, events[index]?.name]));
  const list = variableOf(sources.middleware, "UNLIMITED_EVENTS").value;
  if (!ts.isArrayLiteralExpression(list)) {
    throw new Error("quickdraw-protocol: UNLIMITED_EVENTS is not an array literal");
  }
  return list.elements.map((element) => {
    const name = ts.isPropertyAccessExpression(element) ? byKey.get(element.name.text) : undefined;
    if (name === undefined) {
      throw new Error(
        `quickdraw-protocol: UNLIMITED_EVENTS holds ${element.getText()}, not a client event`,
      );
    }
    return name;
  });
}

/** The constants with literal values in the sources, by name. */
function constantsOf(sources: Sources): Map<string, ConstantDoc> {
  const constants = new Map<string, ConstantDoc>();
  for (const file of Object.values(sources)) {
    for (const statement of file.statements.filter(ts.isVariableStatement)) {
      for (const { name, initializer } of statement.declarationList.declarations) {
        const value = initializer === undefined ? undefined : literalText(unwrap(initializer));
        if (ts.isIdentifier(name) && value !== undefined) {
          constants.set(name.text, { value, doc: docOf(statement) });
        }
      }
    }
  }
  return constants;
}

/** Reads the model of the document from the parsed sources. */
export function protocolModel(sources: Sources): ProtocolModel {
  const types = typesOf(sources, ["version", "envelope", "errors", "access"]);
  const clientEvents = eventsOf(sources, "CLIENT_EVENTS", "ClientListeners");
  const defaults = new Map<string, string>();
  flatten(variableOf(sources.settings, "DEFAULT_LIMITS").value, "", defaults);
  return {
    types,
    clientEvents,
    serverEvents: eventsOf(sources, "SERVER_EVENTS", "ServerListeners"),
    constants: constantsOf(sources),
    names: namesOf(sources),
    errors: errorsOf(sources, types),
    defaults,
    unlimited: unlimitedOf(sources, clientEvents),
  };
}
