// A stand-in client socket for the peer link tests: what it sends goes to
// the stand-in server (`fakeWire.ts`), and `receive` plays a frame from it.

import type { PeerSignalFrame } from "../../../protocol/envelope";
import type { Wire } from "./fakeWire";

type Listener = (...args: unknown[]) => void;

/** What one fake socket sent: its event and frame. */
export type Sent = readonly [event: string, frame: unknown];

export class FakeSocket {
  connected = true;
  readonly sent: Sent[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly wire: Wire,
    readonly id: string,
    readonly userId: string,
  ) {}

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  emit(event: string, frame: unknown): boolean {
    this.sent.push([event, frame]);
    this.wire.route(this, event, frame);
    return true;
  }

  get volatile(): { emit(event: string, frame: unknown): boolean } {
    return { emit: (event, frame) => this.emit(event, frame) };
  }

  timeout(_ms: number): { emitWithAck(event: string, frame: unknown): Promise<unknown> } {
    return {
      emitWithAck: (event, frame) => {
        this.sent.push([event, frame]);
        return Promise.resolve(this.wire.route(this, event, frame));
      },
    };
  }

  /** A frame from the server. */
  receive(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }

  /** What this socket signalled, in order. */
  signals(): PeerSignalFrame["sig"][] {
    return this.sent
      .filter(([event]) => event === "qd:peer")
      .map(([, frame]) => (frame as PeerSignalFrame).sig);
  }
}
