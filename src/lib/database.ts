import type { AppState, ColorItem, OpnameLine, OpnameSession, RestockRecord, UsageRecord } from "../types";
import { createInitialState } from "../data/seed";
import { estimateBeads } from "./beads";
import { supabase } from "./storage";

export type StaffRole = "admin" | "staff" | "viewer";

export interface StaffProfile {
  id: string;
  email: string;
  fullName: string;
  role: StaffRole;
}

type DbColor = {
  id: string;
  code: string;
  name: string;
  hex: string;
  category: string;
  current_stock_grams: number | string;
  estimated_bead_count: number;
  cost_per_gram: number | string;
  minimum_stock_grams: number | string;
  safety_stock_grams: number | string;
  storage_location: string;
  active: boolean;
  previous_stock_grams: number | string;
  last_opname_at: string;
};

const toNumber = (value: number | string | null | undefined) => Number(value ?? 0);

export function canWrite(role?: StaffRole | null) {
  return role === "admin" || role === "staff";
}

export function canAdmin(role?: StaffRole | null) {
  return role === "admin";
}

export async function fetchProfile(): Promise<StaffProfile | null> {
  if (!supabase) return null;
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("id,email,full_name,role")
    .eq("id", userData.user.id)
    .single();
  if (error) throw error;

  return {
    id: data.id,
    email: data.email,
    fullName: data.full_name || data.email,
    role: data.role,
  };
}

export async function fetchStaffProfiles(): Promise<StaffProfile[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("profiles")
    .select("id,email,full_name,role")
    .order("email");
  if (error) throw error;
  return (data ?? []).map((profile: any) => ({
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name || profile.email,
    role: profile.role,
  }));
}

export async function updateStaffRole(profileId: string, role: StaffRole) {
  if (!supabase) return;
  const { error } = await supabase.from("profiles").update({ role }).eq("id", profileId);
  if (error) throw error;
}

export async function fetchRemoteState(): Promise<AppState> {
  if (!supabase) return createInitialState();

  const { data: colors, error: colorsError } = await supabase.from("colors").select("*").order("code");
  if (colorsError) throw colorsError;

  if (!colors?.length) {
    return createInitialState();
  }

  const colorRows = colors as DbColor[];
  const colorIdToCode = new Map(colorRows.map((color) => [color.id, color.code]));
  const appColors = colorRows.map(colorFromDb);

  const [{ data: restocks, error: restockError }, { data: usage, error: usageError }] = await Promise.all([
    supabase.from("restock_records").select("*").order("date", { ascending: false }),
    supabase.from("usage_records").select("*").order("period_end", { ascending: false }),
  ]);
  if (restockError) throw restockError;
  if (usageError) throw usageError;

  return {
    colors: appColors,
    restocks: (restocks ?? []).map((record: any) => ({
      id: record.id,
      date: record.date,
      colorCode: colorIdToCode.get(record.color_id) ?? "",
      quantityGrams: toNumber(record.quantity_grams),
      purchaseCost: toNumber(record.purchase_cost),
      supplier: record.supplier ?? "",
      batchNumber: record.batch_number ?? "",
      notes: record.notes ?? "",
    })).filter((record) => record.colorCode),
    usageRecords: (usage ?? []).map((record: any) => ({
      id: record.id,
      colorCode: colorIdToCode.get(record.color_id) ?? "",
      openingStockGrams: toNumber(record.opening_stock_grams),
      restockGrams: toNumber(record.restock_grams),
      closingStockGrams: toNumber(record.closing_stock_grams),
      usageGrams: toNumber(record.usage_grams),
      periodStart: record.period_start,
      periodEnd: record.period_end,
      opnameSessionId: record.opname_session_id ?? undefined,
    })).filter((record) => record.colorCode),
    opnameSessions: [],
  };
}

export async function seedRemoteColors(colors = createInitialState().colors) {
  if (!supabase) return;
  const { error } = await supabase.from("colors").upsert(colors.map(colorToDb), { onConflict: "code" });
  if (error) throw error;
}

export async function saveRemoteColors(colors: ColorItem[]) {
  if (!supabase) return;
  const { error } = await supabase.from("colors").upsert(colors.map(colorToDb), { onConflict: "code" });
  if (error) throw error;
}

export async function saveRemoteRestock(record: RestockRecord, color: ColorItem) {
  if (!supabase) return;
  const colorId = await getColorId(record.colorCode);
  const { error: restockError } = await supabase.from("restock_records").insert({
    date: record.date,
    color_id: colorId,
    quantity_grams: record.quantityGrams,
    purchase_cost: record.purchaseCost,
    supplier: record.supplier,
    batch_number: record.batchNumber,
    notes: record.notes ?? "",
  });
  if (restockError) throw restockError;

  const { error: colorError } = await supabase.from("colors").upsert(colorToDb(color), { onConflict: "code" });
  if (colorError) throw colorError;
}

export async function saveRemoteOpname(session: OpnameSession, colors: ColorItem[], usageRecords: UsageRecord[]) {
  if (!supabase) return;
  const { data: sessionRow, error: sessionError } = await supabase
    .from("stock_opname_sessions")
    .insert({
      name: session.name,
      status: "confirmed",
      created_at: session.createdAt,
      confirmed_at: session.confirmedAt,
    })
    .select("id")
    .single();
  if (sessionError) throw sessionError;

  const colorIds = await getColorIds(colors.map((color) => color.code));
  const confirmedLines = session.lines.filter((line) => typeof line.actualStockGrams === "number") as Array<OpnameLine & { actualStockGrams: number }>;

  if (confirmedLines.length) {
    const { error: lineError } = await supabase.from("stock_opname_lines").insert(
      confirmedLines.map((line) => ({
        session_id: sessionRow.id,
        color_id: colorIds.get(line.colorCode),
        previous_system_stock: line.previousSystemStock,
        restock_since_last_opname: line.restockSinceLastOpname,
        actual_stock_grams: line.actualStockGrams,
      })),
    );
    if (lineError) throw lineError;
  }

  if (usageRecords.length) {
    const { error: usageError } = await supabase.from("usage_records").insert(
      usageRecords.map((record) => ({
        color_id: colorIds.get(record.colorCode),
        opening_stock_grams: record.openingStockGrams,
        restock_grams: record.restockGrams,
        closing_stock_grams: record.closingStockGrams,
        period_start: record.periodStart,
        period_end: record.periodEnd,
        opname_session_id: sessionRow.id,
      })),
    );
    if (usageError) throw usageError;
  }

  await saveRemoteColors(colors);
}

async function getColorId(code: string) {
  const ids = await getColorIds([code]);
  const id = ids.get(code);
  if (!id) throw new Error(`Color ${code} not found in database`);
  return id;
}

async function getColorIds(codes: string[]) {
  if (!supabase) return new Map<string, string>();
  const { data, error } = await supabase.from("colors").select("id,code").in("code", codes);
  if (error) throw error;
  return new Map((data ?? []).map((row: any) => [row.code, row.id]));
}

function colorFromDb(color: DbColor): ColorItem {
  const currentStockGrams = toNumber(color.current_stock_grams);
  return {
    id: color.id,
    code: color.code,
    name: color.name,
    hex: color.hex,
    category: color.category as ColorItem["category"],
    currentStockGrams,
    estimatedBeadCount: estimateBeads(currentStockGrams),
    costPerGram: toNumber(color.cost_per_gram),
    minimumStockGrams: toNumber(color.minimum_stock_grams),
    safetyStockGrams: toNumber(color.safety_stock_grams),
    storageLocation: color.storage_location,
    active: color.active,
    previousStockGrams: toNumber(color.previous_stock_grams),
    lastOpnameAt: color.last_opname_at,
  };
}

function colorToDb(color: ColorItem) {
  return {
    code: color.code,
    name: color.name,
    hex: color.hex,
    category: color.category,
    current_stock_grams: color.currentStockGrams,
    estimated_bead_count: estimateBeads(color.currentStockGrams),
    cost_per_gram: color.costPerGram,
    minimum_stock_grams: color.minimumStockGrams,
    safety_stock_grams: color.safetyStockGrams,
    storage_location: color.storageLocation,
    active: color.active,
    previous_stock_grams: color.previousStockGrams,
    last_opname_at: color.lastOpnameAt,
  };
}
