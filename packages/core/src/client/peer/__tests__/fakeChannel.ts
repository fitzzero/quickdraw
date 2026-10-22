// A stand-in `RTCDataChannel` for the peer link tests (`fakeRtc.ts` pairs
// two): what one side sends reaches the other a task later, while both are
// open.

import type { RtcChannel } from "../rtc";

/** How a channel was made. */
export interface ChannelInit {
  readonly negotiated: true;
  readonly id: number;
  readonly ordered: boolean;
  readonly maxRetransmits?: number;
}

export class FakeChannel implements RtcChannel {
  readyState = "connecting";
  bufferedAmount = 0;
  binaryType = "blob";
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  /** What this side sent, in order. */
  readonly sent: string[] = [];
  other: FakeChannel | undefined;

  constructor(
    readonly label: string,
    readonly init: ChannelInit,
  ) {}

  send(data: string): void {
    if (this.readyState !== "open") {
      throw new Error("InvalidStateError: the channel is not open");
    }
    this.sent.push(data);
    const { other } = this;
    setTimeout(() => {
      if (other?.readyState === "open") {
        other.onmessage?.({ data });
      }
    }, 0);
  }

  close(): void {
    if (this.readyState === "closed") {
      return;
    }
    this.readyState = "closed";
    this.onclose?.({});
    this.other?.close();
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.({});
  }
}
