import type { Rng } from "@book/schema";

export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export function createRng(seed: number): Rng {
  let a = seed | 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Independent deterministic stream per save, turn and purpose, so replays are identical. */
export function rngFor(saveSeed: number, turn: number, salt: string): Rng {
  return createRng(saveSeed ^ hashString(`${turn}:${salt}`));
}
