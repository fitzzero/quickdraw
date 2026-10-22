// A peer link's clock (RFC 0003 section 12.5): each side pings the other on
// `fast` and reads the peer's clock from the pong. A pong of a ping sent at
// `t` (this side's clock), answered at `u` (the peer's) and heard at `at`
// gives a round trip of `at - t` and an offset of `u + rtt / 2 - at`, the
// peer's clock minus this one's, when the two halves of the trip took as
// long. The offset taken is the one of the fastest of the last
// `CLOCK_WINDOW` round trips (the latest of them on a tie), whose halves are
// the likeliest to match: until
// `CLOCK_SYNC_SAMPLES` pongs arrived it is taken as it comes; after, it
// moves toward a new one by at most `CLOCK_SLEW_MS` a pong, so `now()`
// never jumps, unless they differ by more than `CLOCK_JUMP_MS` (the peer's
// clock changed). `rtt` and `jitter` are smoothed as TCP smooths its round
// trip and its deviation.
//
// React-free.

/** A peer's clock, as a link estimates it. */
export interface PeerClock {
  /** The peer's clock now, in milliseconds: this side's `performance.now()` plus `offset`. */
  now(): number;
  /** The peer's clock minus this side's, in milliseconds; 0 before the first pong. */
  readonly offset: number;
  /** The round trip, smoothed, in milliseconds; 0 before the first pong. */
  readonly rtt: number;
  /** How much round trips vary, smoothed, in milliseconds. */
  readonly jitter: number;
  /** True once enough pongs arrived for `offset` to hold: about half a second after the link opens. */
  readonly synced: boolean;
}

/** A clock and how a link feeds it. */
export interface ClockState extends PeerClock {
  /** A pong of the ping sent at `t`, answered at the peer's `u`, heard at `at`. */
  pong(t: number, u: number, at: number): void;
}

/** The round trips the offset is chosen from. */
export const CLOCK_WINDOW = 24;

/** Pongs before the clock is synced; until then the offset is taken as it comes. */
export const CLOCK_SYNC_SAMPLES = 5;

/** How far a synced offset moves toward a new estimate in one pong. */
export const CLOCK_SLEW_MS = 5;

/** A new estimate this far from the offset is taken at once. */
export const CLOCK_JUMP_MS = 250;

/** A round trip longer than this is not read. */
const MAX_RTT_MS = 10_000;

interface Sample {
  readonly rtt: number;
  readonly offset: number;
}

/** The offset of the fastest round trip; of the latest of them, when several tie. */
function fastest(samples: readonly Sample[]): number {
  let best: Sample | undefined;
  for (const sample of samples) {
    if (best === undefined || sample.rtt <= best.rtt) {
      best = sample;
    }
  }
  return best?.offset ?? 0;
}

/** A clock reading this side's time from `local` (`performance.now()` by default). */
export function createClock(local: () => number = () => performance.now()): ClockState {
  const samples: Sample[] = [];
  let pongs = 0;
  let offset = 0;
  let rtt = 0;
  let jitter = 0;
  return {
    now: () => local() + offset,
    get offset() {
      return offset;
    },
    get rtt() {
      return rtt;
    },
    get jitter() {
      return jitter;
    },
    get synced() {
      return pongs >= CLOCK_SYNC_SAMPLES;
    },
    pong(t: number, u: number, at: number): void {
      const trip = at - t;
      if (!(trip >= 0 && trip <= MAX_RTT_MS)) {
        return;
      }
      samples.push({ rtt: trip, offset: u + trip / 2 - at });
      if (samples.length > CLOCK_WINDOW) {
        samples.shift();
      }
      pongs += 1;
      if (pongs === 1) {
        rtt = trip;
        jitter = trip / 2;
      } else {
        jitter += (Math.abs(trip - rtt) - jitter) / 4;
        rtt += (trip - rtt) / 8;
      }
      const target = fastest(samples);
      const step = target - offset;
      offset =
        pongs <= CLOCK_SYNC_SAMPLES || Math.abs(step) > CLOCK_JUMP_MS
          ? target
          : offset + Math.max(-CLOCK_SLEW_MS, Math.min(CLOCK_SLEW_MS, step));
    },
  };
}
