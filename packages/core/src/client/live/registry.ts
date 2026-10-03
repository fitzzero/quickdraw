// Reference-counted live subscriptions (RFC 0003 sections 6, 7 and 11.5): one
// record per key (a row, a collection scope) however many hooks hold it.
// Ported from 4.1's registry (`legacy-src/client/QuickdrawProvider.tsx:25-68`)
// with two changes:
//
// - the last release closes the record a tick later, unless it is acquired
//   again first, so React's strict mode (which mounts effects twice) and a
//   remount keep the subscription instead of ending and starting it;
// - nothing is cleared when the connection drops. Records outlive a
//   disconnect, and their store subscribes them again on the next connect,
//   from the revisions it holds; 4.1 cleared every record on a disconnect
//   (`legacy-src/client/QuickdrawProvider.tsx:326-330`) and loaded
//   everything again.
//
// React-free.

/** A record held by one user of it: the record, whether this acquisition made it, and the release. */
export interface Holding<Entry> {
  readonly entry: Entry;
  readonly isNew: boolean;
  /** Ends this holding. Calling it again does nothing. */
  release(): void;
}

/** The records of one store, by key. */
export interface Registry<Entry> {
  /** Holds the record of `key`, made with `open` when there is none. */
  acquire(key: string, open: () => Entry): Holding<Entry>;
  /** The record of `key` while it is held; `undefined` once its last holding ended. */
  get(key: string): Entry | undefined;
  /** Every record held now. */
  held(): Entry[];
}

interface Slot<Entry> {
  readonly entry: Entry;
  refs: number;
  closing: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Creates a registry. `close` runs for a record a tick after its last
 * holding ended, unless it was acquired again meanwhile.
 */
export function createRegistry<Entry>(close: (entry: Entry, key: string) => void): Registry<Entry> {
  const slots = new Map<string, Slot<Entry>>();

  function release(key: string, slot: Slot<Entry>): void {
    slot.refs -= 1;
    if (slot.refs > 0) {
      return;
    }
    slot.closing = setTimeout(() => {
      slot.closing = undefined;
      if (slot.refs === 0 && slots.get(key) === slot) {
        slots.delete(key);
        close(slot.entry, key);
      }
    }, 0);
  }

  return Object.freeze({
    acquire(key: string, open: () => Entry): Holding<Entry> {
      let slot = slots.get(key);
      const isNew = slot === undefined;
      if (slot === undefined) {
        slot = { entry: open(), refs: 0, closing: undefined };
        slots.set(key, slot);
      }
      clearTimeout(slot.closing);
      slot.closing = undefined;
      slot.refs += 1;
      const held = slot;
      let released = false;
      return {
        entry: held.entry,
        isNew,
        release: () => {
          if (!released) {
            released = true;
            release(key, held);
          }
        },
      };
    },
    get(key: string): Entry | undefined {
      const slot = slots.get(key);
      return slot !== undefined && slot.refs > 0 ? slot.entry : undefined;
    },
    held: () => [...slots.values()].filter((slot) => slot.refs > 0).map((slot) => slot.entry),
  });
}
