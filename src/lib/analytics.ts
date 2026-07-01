import type { AppState, ColorCategory, ColorItem, ForecastRow, InventoryStatus, OpnameLine, UsageRecord } from "../types";

export const formatGram = (value: number) => `${Math.round(value).toLocaleString()} g`;
export const formatMoney = (value: number) =>
  new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value);

export function getRestockSince(colorCode: string, sinceDate: string, restocks: AppState["restocks"]) {
  const since = new Date(sinceDate).getTime();
  return restocks
    .filter((restock) => restock.colorCode === colorCode && new Date(restock.date).getTime() >= since)
    .reduce((sum, restock) => sum + restock.quantityGrams, 0);
}

export function calculateOpnameLine(color: ColorItem, actualStockGrams: number | "", restocks: AppState["restocks"]): OpnameLine {
  const restockSinceLastOpname = getRestockSince(color.code, color.lastOpnameAt, restocks);
  const actual = actualStockGrams === "" ? color.currentStockGrams : actualStockGrams;
  const calculatedUsage = Math.max(0, color.currentStockGrams + restockSinceLastOpname - actual);
  const expectedStock = color.currentStockGrams + restockSinceLastOpname;

  return {
    colorCode: color.code,
    previousSystemStock: color.currentStockGrams,
    restockSinceLastOpname,
    actualStockGrams,
    calculatedUsage,
    difference: actual - expectedStock,
  };
}

export function statusFor(color: ColorItem, averageDailyUsage: number): InventoryStatus {
  if (color.currentStockGrams <= 0) return "Out of Stock";
  if (color.currentStockGrams <= color.minimumStockGrams) return "Reorder Now";
  if (averageDailyUsage <= 0) return "Healthy";
  const days = (color.currentStockGrams - color.safetyStockGrams) / averageDailyUsage;
  if (days <= 0) return "Reorder Now";
  if (days <= 14) return "Reorder Soon";
  return "Healthy";
}

export function buildForecastRows(state: AppState, days = 30): ForecastRow[] {
  return state.colors.map((color) => {
    const usageGrams = state.usageRecords
      .filter((record) => record.colorCode === color.code)
      .reduce((sum, record) => sum + record.usageGrams, 0);
    const restockGrams = state.restocks
      .filter((record) => record.colorCode === color.code)
      .reduce((sum, record) => sum + record.quantityGrams, 0);
    const averageDailyUsage = usageGrams / days;
    const daysUntilReorder =
      averageDailyUsage > 0 ? Math.max(0, (color.currentStockGrams - color.safetyStockGrams) / averageDailyUsage) : null;
    const need14Days = averageDailyUsage * 14;
    const need30Days = averageDailyUsage * 30;
    const recommendedOrder14 = Math.max(0, need14Days + color.safetyStockGrams - color.currentStockGrams);
    const recommendedOrder30 = Math.max(0, need30Days + color.safetyStockGrams - color.currentStockGrams);

    return {
      color,
      restockGrams,
      usageGrams,
      averageDailyUsage,
      daysUntilReorder,
      status: statusFor(color, averageDailyUsage),
      need14Days,
      need30Days,
      recommendedOrder14,
      recommendedOrder30,
      inventoryValue: color.currentStockGrams * color.costPerGram,
    };
  });
}

export function valueByCategory(rows: ForecastRow[]) {
  return rows.reduce<Record<ColorCategory, number>>((acc, row) => {
    acc[row.color.category] = (acc[row.color.category] ?? 0) + row.inventoryValue;
    return acc;
  }, {} as Record<ColorCategory, number>);
}

export function monthlyUsageTrend(records: UsageRecord[]) {
  const buckets = records.reduce<Record<string, number>>((acc, record, index) => {
    const week = `Week ${1 + (index % 4)}`;
    acc[week] = (acc[week] ?? 0) + record.usageGrams;
    return acc;
  }, {});

  return Object.entries(buckets).map(([period, usage]) => ({ period, usage: Math.round(usage) }));
}

export function reorderTimeline(rows: ForecastRow[]) {
  const buckets = [
    { name: "Now", min: 0, max: 0 },
    { name: "1-7 days", min: 0.01, max: 7 },
    { name: "8-14 days", min: 7.01, max: 14 },
    { name: "15-30 days", min: 14.01, max: 30 },
    { name: "30+ days", min: 30.01, max: Infinity },
  ];

  return buckets.map((bucket) => ({
    period: bucket.name,
    colors: rows.filter((row) => row.daysUntilReorder !== null && row.daysUntilReorder >= bucket.min && row.daysUntilReorder <= bucket.max).length,
  }));
}

export function generateCsv(rows: Record<string, unknown>[], delimiter = ";") {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const body = [headers.join(delimiter), ...rows.map((row) => headers.map((header) => escape(row[header])).join(delimiter))].join("\r\n");
  return `\ufeffsep=${delimiter}\r\n${body}`;
}
