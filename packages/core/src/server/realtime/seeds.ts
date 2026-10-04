// The seeds of streams (RFC 0003 section 12.5): the latest `seed` items of
// each scope of each stream, kept in memory on this process so a new
// subscriber starts with recent history. A restart empties them, and each
// node of a cluster keeps its own from the pushes it received since it
// started (every node receives every push of a stream that keeps a seed:
// `streams.ts`), so a node that started after the pushes has none of them.
// A stream whose service computes its seed (`streams: { <name>: { seed } }`)
// keeps nothing here: each subscribe asks the app for the current state, on
// whichever node it arrives. Durable history is the app's: store the rows
// and expose a collection.
//
// Bounded twice: a scope keeps at most its stream's `seed` items (at most
// 1,000), and a stream keeps at most `STREAM_MAX_SCOPES` scopes, dropping the
// one pushed to least recently. Scopes are `Map` keys, so a scope named
// `__proto__` is an ordinary one.

import type { ServiceStream, StreamSeedContext } from "./types";
import { checkOutgoing, checksItems } from "./validate";

/** The most scopes one stream keeps a seed for; the scope pushed to least recently goes first. */
export const STREAM_MAX_SCOPES = 10_000;

/**
 * The seed `stream`'s service computes for one subscriber (`streams: {
 * <name>: { seed } }`), each item checked against the stream's schema, and
 * the checked items are what is sent, as `push` sends (unchecked as `push`
 * leaves them, for a stream that validates in development only). The function is
 * called before this awaits anything: in the caller's tick, the one it
 * joined the socket to the feed in. A function that returns something other
 * than an array, or an item that does not fit, throws for `INTERNAL`.
 */
export async function computeSeed(
  service: string,
  stream: ServiceStream,
  scope: string | undefined,
  ctx: StreamSeedContext,
  outputValidation: boolean,
): Promise<unknown[]> {
  const compute = stream.computeSeed;
  const items: unknown = await compute?.(scope, ctx);
  const label = `The seed of ${service}.${stream.name}`;
  if (!Array.isArray(items)) {
    throw new TypeError(`${label}: its seed function must return an array of items`);
  }
  if (!checksItems(stream, outputValidation)) {
    return items as unknown[];
  }
  return items.map((item: unknown, index) =>
    checkOutgoing(stream.item, item, `Item ${String(index)} of ${label}`),
  );
}

/** The key of a global stream's one feed among a stream's scopes. */
const GLOBAL_FEED = "";

/** The key of one stream among a dispatcher's streams. */
export function streamKey(service: string, stream: string): string {
  return `${service}\u0000${stream}`;
}

/** The seeds of one dispatcher's streams. */
export class StreamSeeds {
  /** Per stream (`service\0stream`), each scope's latest items, the scope pushed to last at the end. */
  readonly #streams = new Map<string, Map<string, unknown[]>>();

  /** Keeps `item` as the newest of a scope's seed of at most `size` items. */
  push(stream: string, scope: string | undefined, item: unknown, size: number): void {
    if (size <= 0) {
      return;
    }
    const scopes = this.#streams.get(stream) ?? new Map<string, unknown[]>();
    this.#streams.set(stream, scopes);
    const key = scope ?? GLOBAL_FEED;
    const items = scopes.get(key) ?? [];
    // Moved to the end: the scope pushed to last.
    scopes.delete(key);
    scopes.set(key, items);
    items.push(item);
    if (items.length > size) {
      items.splice(0, items.length - size);
    }
    if (scopes.size > STREAM_MAX_SCOPES) {
      const oldest = scopes.keys().next();
      if (oldest.done !== true) {
        scopes.delete(oldest.value);
      }
    }
  }

  /** A scope's seed, oldest first: a copy. */
  seed(stream: string, scope: string | undefined): unknown[] {
    return [...(this.#streams.get(stream)?.get(scope ?? GLOBAL_FEED) ?? [])];
  }

  /** How many scopes of a stream have a seed. */
  scopes(stream: string): number {
    return this.#streams.get(stream)?.size ?? 0;
  }
}
