// The live data's cache without TanStack (RFC 0003 section 11.5): the
// `LiveCache` (`host.ts`) of a script's live store (`liveStore.ts`), its
// entries in a `Map` by key, each of which a holding (`holding.ts`) listens
// to. An entry lives from the stores' first write of it until `release`, a
// tick after the last holding of its row or scope ended (`registry.ts`), as
// a `QueryClient`'s entry lives while the stores observe it
// (`queryCache.ts`); nothing else collects it. `clear` removes every entry,
// held or not, as another user's hello does (`liveStore.ts`).
//
// React-free, and TanStack-free.

import { notifyEach } from "../watch";
import type { LiveCache, LiveKey } from "./host";

/** A live store's cache: a `LiveCache` whose entries can be listened to and cleared. */
export interface MemoryCache extends LiveCache {
  /** Calls `listener` after the entry under `key` changes or goes; returns the unsubscribe function. */
  listen(key: LiveKey, listener: () => void): () => void;
  /** Removes every entry, held or not, telling the listeners of each. */
  clear(): void;
}

function idOf(key: LiveKey): string {
  return JSON.stringify(key);
}

/** A new, empty cache. */
export function createMemoryCache(): MemoryCache {
  const entries = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const tell = (id: string): void => {
    notifyEach(listeners.get(id) ?? [], (listener) => {
      listener();
    });
  };
  return Object.freeze({
    get: (key: LiveKey): unknown => entries.get(idOf(key)),
    set(key: LiveKey, value: unknown): void {
      const id = idOf(key);
      entries.set(id, value);
      tell(id);
    },
    // Nothing collects an entry here: it lives until `release`.
    hold: (): void => undefined,
    release(key: LiveKey): void {
      const id = idOf(key);
      if (entries.delete(id)) {
        tell(id);
      }
    },
    listen(key: LiveKey, listener: () => void): () => void {
      const id = idOf(key);
      const set = listeners.get(id) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(id, set);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(id) === set) {
          listeners.delete(id);
        }
      };
    },
    clear(): void {
      const ids = [...entries.keys()];
      entries.clear();
      for (const id of ids) {
        tell(id);
      }
    },
  });
}
