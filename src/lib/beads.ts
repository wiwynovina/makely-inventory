export const BEADS_PER_GRAM = 100;
export const GRAMS_PER_PACK = 250;

export function estimateBeads(grams: number) {
  return Math.round(grams * BEADS_PER_GRAM);
}

export function packsToGrams(packs: number) {
  return packs * GRAMS_PER_PACK;
}

export function gramsToPacks(grams: number) {
  return grams / GRAMS_PER_PACK;
}
