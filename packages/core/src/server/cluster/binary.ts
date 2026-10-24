// Binary values in the server-to-server event that carries an app's data, a
// stream's pushed items (`../realtime/streamPushes.ts`). Socket.IO's Redis
// adapter sends a server-side event as JSON (@socket.io/redis-adapter 8.3
// `serverSideEmit`, `JSON.stringify`), where its room broadcasts go as
// msgpack, so a pushed `Buffer` reached the other nodes' sockets as
// `{ type: "Buffer", data: [...] }`, a `Uint8Array` as an object of its
// indexes and an `ArrayBuffer` as `{}`.
//
// A server that sends binary (`createServer({ binary: true })`, the stock
// parser) takes each binary value out of the items before they go (`null` in
// its place) and lists it by its path, its kind and its bytes in base64; the
// receiver puts each back where its path says, so the items reach its
// sockets, and its seeds, as they would from a push on that node. A path
// names where a value was, never what it looked like, so no value of the
// app's is taken for one; the receiver replaces only a `null` its own
// parse holds there. A server that sends JSON only walks nothing: its parser
// writes binary inside a frame as JSON on every node alike.
//
// Binary is what the stock parser sends as such: an `ArrayBuffer` or a view
// of one (`Buffer`, a typed array, `DataView`). A `Blob` stays as it is
// (reading one takes a promise), and so does a value with its own `toJSON`
// (a `Date`): it goes as the JSON it chose.

/** Where a value is in the items: the item's index, then each key or index under it. */
type Path = readonly (string | number)[];

/** One binary value of the items: its path, its kind and its bytes in base64. */
export type BinaryEntry = readonly [path: Path, kind: string, base64: string];

/** The items as a server-side event carries them, and the binary values taken out of them. */
export interface PackedItems {
  readonly items: readonly unknown[];
  readonly bin?: readonly BinaryEntry[];
}

const SENDS_BINARY = new WeakMap<object, boolean>();

/** Registers whether the server `io` sends binary (`createServer({ binary: true })`). */
export function registerBinary(io: object, binary: boolean): void {
  SENDS_BINARY.set(io, binary);
}

/**
 * The views a kind names, rebuilt over the bytes; another kind comes back as
 * a `Uint8Array`. A `Map`, so a kind another node names never reaches a key
 * an object inherits (`constructor`, or one planted on `Object.prototype`).
 */
const VIEWS: ReadonlyMap<string, new (buffer: ArrayBuffer) => ArrayBufferView> = new Map<
  string,
  new (buffer: ArrayBuffer) => ArrayBufferView
>([
  ["Int8Array", Int8Array],
  ["Uint8Array", Uint8Array],
  ["Uint8ClampedArray", Uint8ClampedArray],
  ["Int16Array", Int16Array],
  ["Uint16Array", Uint16Array],
  ["Int32Array", Int32Array],
  ["Uint32Array", Uint32Array],
  ["Float32Array", Float32Array],
  ["Float64Array", Float64Array],
  ["BigInt64Array", BigInt64Array],
  ["BigUint64Array", BigUint64Array],
  ["DataView", DataView],
]);

function isBinary(value: object): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function kindOf(value: ArrayBuffer | ArrayBufferView): string {
  if (value instanceof ArrayBuffer) {
    return "ArrayBuffer";
  }
  return Buffer.isBuffer(value) ? "Buffer" : value.constructor.name;
}

function base64Of(value: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    value instanceof ArrayBuffer
      ? Buffer.from(value)
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return bytes.toString("base64");
}

/**
 * What a walk of the items keeps: the binary values it took out, the
 * containers it is inside, and where it is (copied into an entry only when
 * it takes a value out).
 */
interface Walk {
  readonly entries: BinaryEntry[];
  readonly inside: Set<object>;
  readonly path: (string | number)[];
}

/** A container's `child` under `key` without its binary values; a primitive is never walked. */
function childWithout(child: unknown, key: string | number, walk: Walk): unknown {
  if (typeof child !== "object" || child === null) {
    return child;
  }
  walk.path.push(key);
  const taken = takeOut(child, walk);
  walk.path.pop();
  return taken;
}

/** An array's elements without their binary values, by index as JSON writes them: a copy when any had one. */
function arrayWithout(value: readonly unknown[], walk: Walk): readonly unknown[] {
  let copy: unknown[] | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const child = value[index];
    const taken = childWithout(child, index, walk);
    if (taken !== child) {
      copy ??= [...value];
      copy[index] = taken;
    }
  }
  return copy ?? value;
}

/** An object's own keys without their binary values: a copy when any had one. */
function objectWithout(value: object, walk: Walk): object {
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(value)) {
    const child: unknown = (value as Record<string, unknown>)[key];
    const taken = childWithout(child, key, walk);
    if (taken !== child) {
      copy ??= { ...value };
      copy[key] = taken;
    }
  }
  return copy ?? value;
}

/** `value` with each binary value in it listed in `walk` and replaced by `null`. */
function takeOut(value: object, walk: Walk): unknown {
  if (isBinary(value)) {
    walk.entries.push([[...walk.path], kindOf(value), base64Of(value)]);
    return null;
  }
  // A cycle, which JSON refuses as before, or a value that writes its own JSON.
  const ownJson = typeof (value as { readonly toJSON?: unknown }).toJSON === "function";
  if (ownJson || walk.inside.has(value)) {
    return value;
  }
  walk.inside.add(value);
  const taken = Array.isArray(value) ? arrayWithout(value, walk) : objectWithout(value, walk);
  walk.inside.delete(value);
  return taken;
}

/**
 * `items` as a server-side event of the server `io` carries them: on a
 * server that sends binary, each binary value taken out and listed in
 * `bin`, the items themselves left as they are. Without binary to take
 * out, `items` alone.
 */
export function packItems(io: object, items: readonly unknown[]): PackedItems {
  if (SENDS_BINARY.get(io) !== true) {
    return { items };
  }
  const walk: Walk = { entries: [], inside: new Set(), path: [] };
  const packed = takeOut(items, walk) as readonly unknown[];
  return walk.entries.length === 0 ? { items } : { items: packed, bin: walk.entries };
}

function isEntry(value: unknown): value is BinaryEntry {
  if (!Array.isArray(value) || value.length < 3) {
    return false;
  }
  const [path, kind, base64] = value as readonly unknown[];
  return (
    Array.isArray(path) &&
    path.length > 0 &&
    path.every((key) => typeof key === "string" || typeof key === "number") &&
    typeof kind === "string" &&
    typeof base64 === "string"
  );
}

/** The value an entry lists, rebuilt as its kind. */
function binaryOf(kind: string, base64: string): unknown {
  const bytes = Buffer.from(base64, "base64");
  if (kind === "Buffer") {
    return bytes;
  }
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (kind === "ArrayBuffer") {
    return buffer;
  }
  const View = VIEWS.get(kind) ?? Uint8Array;
  try {
    return new View(buffer);
  } catch {
    // Bytes that do not fill the kind's elements (no sender of this version writes them).
    return new Uint8Array(buffer);
  }
}

/** The container `path` leads to under `root`, through its own keys only; `undefined` off the path. */
function containerAt(root: unknown, path: Path): Record<string | number, unknown> | undefined {
  let at: unknown = root;
  for (const key of path) {
    if (typeof at !== "object" || at === null || !Object.hasOwn(at, key)) {
      return undefined;
    }
    at = (at as Record<string | number, unknown>)[key];
  }
  return typeof at === "object" && at !== null
    ? (at as Record<string | number, unknown>)
    : undefined;
}

/**
 * The items a server-side event carried, each binary value `bin` lists put
 * back where its path says: only over the `null` the sender left there, so
 * a malformed list changes nothing else. The items are the event's own,
 * fresh from its JSON, and are changed in place.
 */
export function unpackItems(items: unknown[], bin: unknown): unknown[] {
  if (!Array.isArray(bin)) {
    return items;
  }
  for (const entry of bin as readonly unknown[]) {
    if (!isEntry(entry)) {
      continue;
    }
    const [path, kind, base64] = entry;
    const key = path[path.length - 1] as string | number;
    const container = containerAt(items, path.slice(0, -1));
    if (container !== undefined && Object.hasOwn(container, key) && container[key] === null) {
      container[key] = binaryOf(kind, base64);
    }
  }
  return items;
}
