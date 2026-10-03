// The seeds of streams (RFC 0003 section 12.5): the latest `seed` items of
// each scope of each stream, kept in memory on this process so a new
// subscriber starts with recent history. A restart empties them, and each
// process of a cluster keeps its own (an item pushed on one node is sent to
// every node's subscribers, but seeds only the node that pushed it). Durable
// history is the app's: store the rows and expose a collection.
//
// Bounded twice: a scope keeps at most its stream's `seed` items (at most
// 1,000), and a stream keeps at most `STREAM_MAX_SCOPES` scopes, dropping the
// one pushed to least recently. Scopes are `Map` keys, so a scope named
// `__proto__` is an ordinary one.

/** The most scopes one stream keeps a seed for; the scope pushed to least recently goes first. */
export const STREAM_MAX_SCOPES = 10_000;

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
