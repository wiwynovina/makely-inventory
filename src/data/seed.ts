import type { AppState, ColorCategory, ColorItem, RestockRecord, UsageRecord } from "../types";
import { estimateBeads } from "../lib/beads";
import { makelyColors } from "./makelyColors";

const categories: ColorCategory[] = [
  "Classic",
  "Pastel",
  "Neon",
  "Transparent",
  "Metallic",
  "Earth",
  "Skin Tone",
  "Special",
];

const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

export function buildSeedColors(): ColorItem[] {
  return makelyColors.map((source, index) => {
    const category = categories[index % categories.length];
    const baseStock = 120 + ((index * 37) % 880);
    const previousStock = baseStock + ((index * 11) % 170) - 55;
    const cost = Number((42 + (index % 17) * 2.75 + (category === "Special" ? 18 : 0)).toFixed(2));

    return {
      id: `color-${source.code}`,
      code: source.code,
      name: source.name,
      hex: source.hex,
      category,
      currentStockGrams: Math.max(0, Math.round(baseStock)),
      estimatedBeadCount: estimateBeads(baseStock),
      costPerGram: cost,
      minimumStockGrams: 90 + (index % 5) * 20,
      safetyStockGrams: 140 + (index % 6) * 25,
      storageLocation: `Rack ${String.fromCharCode(65 + (index % 8))}-${1 + (index % 12)}`,
      active: index % 29 !== 0,
      previousStockGrams: Math.max(0, Math.round(previousStock)),
      lastOpnameAt: daysAgo(30 + (index % 12)),
    };
  });
}

export function buildSeedRestocks(colors: ColorItem[]): RestockRecord[] {
  return colors
    .filter((_, index) => index % 3 === 0 || index % 7 === 0)
    .map((color, index) => {
      const quantity = 80 + ((index * 23) % 420);
      return {
        id: `restock-${color.code}`,
        date: daysAgo(2 + (index % 26)),
        colorCode: color.code,
        quantityGrams: quantity,
        purchaseCost: Number((quantity * color.costPerGram * (0.92 + (index % 5) * 0.03)).toFixed(0)),
        supplier: ["BeadSource ID", "Craft Pearl Co", "Makely Central", "Studio Supply"][index % 4],
        batchNumber: `B-${new Date().getFullYear()}-${String(index + 12).padStart(4, "0")}`,
        notes: index % 4 === 0 ? "Priority seasonal refill" : "",
      };
    });
}

export function buildSeedUsage(colors: ColorItem[], restocks: RestockRecord[]): UsageRecord[] {
  return colors.map((color, index) => {
    const restockGrams = restocks
      .filter((restock) => restock.colorCode === color.code)
      .reduce((sum, restock) => sum + restock.quantityGrams, 0);
    const syntheticUsage = Math.max(0, color.previousStockGrams + restockGrams - color.currentStockGrams);

    return {
      id: `usage-${color.code}`,
      colorCode: color.code,
      openingStockGrams: color.previousStockGrams,
      restockGrams,
      closingStockGrams: color.currentStockGrams,
      usageGrams: syntheticUsage + (index % 6 === 0 ? 0 : (index * 13) % 65),
      periodStart: daysAgo(30),
      periodEnd: daysAgo(0),
    };
  });
}

export function createInitialState(): AppState {
  const colors = buildSeedColors();
  const restocks = buildSeedRestocks(colors);
  return {
    colors,
    restocks,
    usageRecords: buildSeedUsage(colors, restocks),
    opnameSessions: [],
  };
}
