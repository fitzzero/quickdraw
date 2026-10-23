// A seeded random for the peer link tests (mulberry32): numbers from 0 to
// 1, the same each run, so a lag's jitter and loss repeat.

/** Random numbers from 0 to 1, the same sequence for the same `seed`. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
