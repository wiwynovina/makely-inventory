import { createClient } from "@supabase/supabase-js";
import type { AppState } from "../types";
import { createInitialState } from "../data/seed";
import { estimateBeads } from "./beads";

const STORAGE_KEY = "makely-inventory-state-v3-letter-codes";

export const supabase =
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)
    : null;

export function loadState(): AppState {
  const cached = localStorage.getItem(STORAGE_KEY);
  if (!cached) return createInitialState();

  try {
    const parsed = JSON.parse(cached) as AppState;
    if (parsed.colors.length !== 221 || parsed.colors.some((color) => !/^[A-Z][0-9]{2}$/.test(color.code))) {
      return createInitialState();
    }
    return {
      ...parsed,
      colors: parsed.colors.map((color) => ({
        ...color,
        estimatedBeadCount: estimateBeads(color.currentStockGrams),
      })),
    };
  } catch {
    return createInitialState();
  }
}

export function saveState(state: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetState() {
  localStorage.removeItem(STORAGE_KEY);
}
