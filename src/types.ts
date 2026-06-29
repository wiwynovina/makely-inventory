export type ColorCategory =
  | "Classic"
  | "Pastel"
  | "Neon"
  | "Transparent"
  | "Metallic"
  | "Earth"
  | "Skin Tone"
  | "Special";

export type InventoryStatus = "Out of Stock" | "Reorder Now" | "Reorder Soon" | "Healthy";

export interface ColorItem {
  id: string;
  code: string;
  name: string;
  hex: string;
  category: ColorCategory;
  currentStockGrams: number;
  estimatedBeadCount: number;
  costPerGram: number;
  minimumStockGrams: number;
  safetyStockGrams: number;
  storageLocation: string;
  active: boolean;
  previousStockGrams: number;
  lastOpnameAt: string;
}

export interface RestockRecord {
  id: string;
  date: string;
  colorCode: string;
  quantityGrams: number;
  purchaseCost: number;
  supplier: string;
  batchNumber: string;
  notes?: string;
}

export interface UsageRecord {
  id: string;
  colorCode: string;
  openingStockGrams: number;
  restockGrams: number;
  closingStockGrams: number;
  usageGrams: number;
  periodStart: string;
  periodEnd: string;
  opnameSessionId?: string;
}

export interface OpnameLine {
  colorCode: string;
  previousSystemStock: number;
  restockSinceLastOpname: number;
  actualStockGrams: number | "";
  calculatedUsage: number;
  difference: number;
}

export interface OpnameSession {
  id: string;
  name: string;
  status: "draft" | "confirmed";
  createdAt: string;
  confirmedAt?: string;
  lines: OpnameLine[];
}

export interface ForecastRow {
  color: ColorItem;
  restockGrams: number;
  usageGrams: number;
  averageDailyUsage: number;
  daysUntilReorder: number | null;
  status: InventoryStatus;
  need14Days: number;
  need30Days: number;
  recommendedOrder14: number;
  recommendedOrder30: number;
  inventoryValue: number;
}

export interface AppState {
  colors: ColorItem[];
  restocks: RestockRecord[];
  usageRecords: UsageRecord[];
  opnameSessions: OpnameSession[];
}
