/**
 * Deterministic, coordinate-addressed noise.
 *
 * Material mixes and scatter must be reproducible: the same blueprint and seed
 * has to yield the same wall texture every time, otherwise previews lie and
 * undo/redo drift. So we hash coordinates instead of keeping RNG state.
 */

/**
 * 32-bit integer hash of a coordinate triple.
 *
 * The seed is multiplied before it meets the coordinates, not merely XORed
 * into them. XOR alone is a permutation of the low bits, so seeds 1, 2 and 3
 * would draw from the very same multiset of hash values over a coordinate
 * range — different-looking patterns with identical statistics, and a "reroll
 * with another seed" that quietly changes nothing.
 */
export function hash3(x: number, y: number, z: number, seed = 0): number {
  let h = Math.imul((seed | 0) ^ 0x27d4eb2f, 0x9e3779b1);
  h ^= Math.imul(x | 0, 0x85ebca6b);
  h = (h << 13) | (h >>> 19);
  h ^= Math.imul(y | 0, 0xc2b2ae35);
  h = (h << 17) | (h >>> 15);
  h ^= Math.imul(z | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x3d4d51c3);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Coordinate hash normalised to [0, 1). */
export function noise01(x: number, y: number, z: number, seed = 0): number {
  return hash3(x, y, z, seed) / 4294967296;
}

/** A small stateful PRNG for non-spatial randomness (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick an index from `weights` using a value in [0,1). */
export function weightedIndex(weights: number[], r: number): number {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (total <= 0) return 0;
  let acc = 0;
  const target = r * total;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i] > 0 ? weights[i] : 0;
    if (target < acc) return i;
  }
  return weights.length - 1;
}
