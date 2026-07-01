import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Boxes,
  Check,
  Download,
  FileSpreadsheet,
  LogOut,
  PackagePlus,
  RefreshCcw,
  Save,
  Search,
  Upload,
  Users,
  WalletCards,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Session } from "@supabase/supabase-js";
import Papa from "papaparse";
import "./styles.css";
import type { AppState, ColorItem, OpnameLine, OpnameSession, RestockRecord } from "./types";
import { createInitialState } from "./data/seed";
import {
  buildForecastRows,
  calculateOpnameLine,
  formatGram,
  formatMoney,
  generateCsv,
  monthlyUsageTrend,
  reorderTimeline,
} from "./lib/analytics";
import { loadState, resetState, saveState, supabase } from "./lib/storage";
import { estimateBeads, gramsToPacks, packsToGrams } from "./lib/beads";
import {
  canAdmin,
  canWrite,
  fetchProfile,
  fetchRemoteState,
  fetchStaffProfiles,
  saveRemoteColors,
  saveRemoteOpname,
  saveRemoteRestock,
  seedRemoteColors,
  updateStaffRole,
  type StaffProfile,
  type StaffRole,
} from "./lib/database";

type View = "dashboard" | "colors" | "opname" | "restock" | "analytics" | "reports" | "staff";

const statusClass: Record<string, string> = {
  "Out of Stock": "danger",
  "Reorder Now": "danger",
  "Reorder Soon": "warning",
  Healthy: "success",
};

function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const [view, setView] = useState<View>("dashboard");
  const [query, setQuery] = useState("");
  const [activeSession, setActiveSession] = useState<OpnameSession>(() => createDraftSession(loadState()));
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(Boolean(supabase));
  const [syncMessage, setSyncMessage] = useState("");

  const writeAllowed = !supabase || canWrite(profile?.role);
  const adminAllowed = !supabase || canAdmin(profile?.role);

  useEffect(() => {
    setState((current) => {
      const needsUpdate = current.colors.some((color) => color.estimatedBeadCount !== estimateBeads(color.currentStockGrams));
      if (!needsUpdate) return current;
      return {
        ...current,
        colors: current.colors.map((color) => ({
          ...color,
          estimatedBeadCount: estimateBeads(color.currentStockGrams),
        })),
      };
    });
  }, []);

  useEffect(() => {
    if (!supabase) saveState(state);
  }, [state]);

  useEffect(() => {
    if (!supabase) return;

    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setAuthLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) {
        setProfile(null);
        setState(createInitialState());
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabase || !session) return;

    let mounted = true;
    async function loadRemote() {
      try {
        setAuthLoading(true);
        setSyncMessage("Loading Supabase data...");
        const nextProfile = await fetchProfile();
        const remoteState = await fetchRemoteState();
        if (!mounted) return;
        setProfile(nextProfile);
        setState(remoteState);
        setActiveSession(createDraftSession(remoteState));
        setSyncMessage(remoteState.colors.length ? "Synced with Supabase" : "No database rows yet");
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : "Failed to load Supabase data");
      } finally {
        if (mounted) setAuthLoading(false);
      }
    }

    loadRemote();
    return () => {
      mounted = false;
    };
  }, [session]);

  const rows = useMemo(() => buildForecastRows(state), [state]);
  const filteredColors = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return state.colors.filter((color) => {
      const matchesQuery = !normalized || color.code.toLowerCase().includes(normalized) || color.name.toLowerCase().includes(normalized);
      return matchesQuery;
    });
  }, [query, state.colors]);

  const filteredOpnameLines = activeSession.lines.filter((line) => filteredColors.some((color) => color.code === line.colorCode));
  const fastest = [...rows].sort((a, b) => b.usageGrams - a.usageGrams)[0];
  const reorderRows = rows.filter((row) => row.status === "Reorder Now" || row.status === "Out of Stock");
  const outRows = rows.filter((row) => row.status === "Out of Stock");
  const purchaseBudget30 = rows.reduce((sum, row) => sum + row.recommendedOrder30 * row.color.costPerGram, 0);
  const totalValue = rows.reduce((sum, row) => sum + row.inventoryValue, 0);
  const totalStock = state.colors.reduce((sum, color) => sum + color.currentStockGrams, 0);
  const statusValue = Object.entries(
    rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + row.inventoryValue;
      return acc;
    }, {}),
  ).map(([name, value]) => ({ name, value }));
  const topUsed = [...rows].sort((a, b) => b.usageGrams - a.usageGrams).slice(0, 10).map((row) => ({
    code: row.color.code,
    usage: Math.round(row.usageGrams),
    fill: row.color.hex,
  }));

  function updateState(updater: (draft: AppState) => AppState) {
    setState((current) => updater(current));
  }

  function updateOpnameLine(colorCode: string, value: string) {
    const actualStockGrams = value === "" ? "" : Number(value);
    const color = state.colors.find((item) => item.code === colorCode);
    if (!color) return;

    setActiveSession((session) => ({
      ...session,
      lines: session.lines.map((line) =>
        line.colorCode === colorCode ? calculateOpnameLine(color, actualStockGrams, state.restocks) : line,
      ),
    }));
  }

  function saveDraft() {
    if (!writeAllowed) return;
    updateState((current) => ({
      ...current,
      opnameSessions: [activeSession, ...current.opnameSessions.filter((session) => session.id !== activeSession.id)],
    }));
  }

  async function confirmOpname() {
    if (!writeAllowed) return;
    const confirmedAt = new Date().toISOString();
    const confirmedLines = activeSession.lines.filter((line) => typeof line.actualStockGrams === "number") as Array<OpnameLine & { actualStockGrams: number }>;
    const usageRecords = confirmedLines.map((line) => ({
      id: `usage-${activeSession.id}-${line.colorCode}`,
      colorCode: line.colorCode,
      openingStockGrams: line.previousSystemStock,
      restockGrams: line.restockSinceLastOpname,
      closingStockGrams: line.actualStockGrams,
      usageGrams: Math.max(0, line.previousSystemStock + line.restockSinceLastOpname - line.actualStockGrams),
      periodStart: state.colors.find((color) => color.code === line.colorCode)?.lastOpnameAt ?? new Date().toISOString(),
      periodEnd: confirmedAt,
      opnameSessionId: activeSession.id,
    }));

    const nextColors = state.colors.map((color) => {
      const line = confirmedLines.find((item) => item.colorCode === color.code);
      if (!line) return color;
      return {
        ...color,
        previousStockGrams: line.previousSystemStock,
        currentStockGrams: line.actualStockGrams,
        estimatedBeadCount: estimateBeads(line.actualStockGrams),
        lastOpnameAt: confirmedAt,
      };
    });
    const confirmedSession = { ...activeSession, status: "confirmed" as const, confirmedAt, lines: activeSession.lines };

    updateState((current) => ({
      ...current,
      colors: nextColors,
      usageRecords: [...usageRecords, ...current.usageRecords],
      opnameSessions: [
        confirmedSession,
        ...current.opnameSessions.filter((session) => session.id !== activeSession.id),
      ],
    }));
    setActiveSession(createDraftSession({ ...state, colors: nextColors }));

    if (supabase) {
      try {
        setSyncMessage("Saving stock opname...");
        await saveRemoteOpname(confirmedSession, nextColors, usageRecords);
        setSyncMessage("Stock opname saved to Supabase");
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : "Failed to save stock opname");
      }
    }
  }

  async function addRestock(record: Omit<RestockRecord, "id">) {
    if (!writeAllowed) return;
    const restock = { ...record, id: crypto.randomUUID() };
    const nextColor = state.colors.find((color) => color.code === record.colorCode);
    if (!nextColor) return;
    const currentValue = nextColor.currentStockGrams * nextColor.costPerGram;
    const newCostPerGram = (currentValue + record.purchaseCost) / Math.max(1, nextColor.currentStockGrams + record.quantityGrams);
    const updatedColor = {
      ...nextColor,
      currentStockGrams: nextColor.currentStockGrams + record.quantityGrams,
      estimatedBeadCount: estimateBeads(nextColor.currentStockGrams + record.quantityGrams),
      costPerGram: Number(newCostPerGram.toFixed(2)),
    };

    updateState((current) => ({
      ...current,
      restocks: [restock, ...current.restocks],
      colors: current.colors.map((color) => color.code === record.colorCode ? updatedColor : color),
    }));

    if (supabase) {
      try {
        setSyncMessage("Saving restock...");
        await saveRemoteRestock(restock, updatedColor);
        setSyncMessage("Restock saved to Supabase");
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : "Failed to save restock");
      }
    }
  }

  function exportRows(format: "csv" | "xlsx" | "pdf") {
    const reportRows = rows.map((row) => ({
      code: row.color.code,
      name: row.color.name,
      stock_grams: row.color.currentStockGrams,
      usage_grams: Math.round(row.usageGrams),
      average_daily_usage: Number(row.averageDailyUsage.toFixed(2)),
      status: row.status,
      recommended_order_14_days: Math.round(row.recommendedOrder14),
      recommended_order_30_days: Math.round(row.recommendedOrder30),
      inventory_value_idr: Math.round(row.inventoryValue),
    }));

    if (format === "xlsx") {
      downloadBlob(buildExcelHtml(reportRows), "makely-inventory-report.xls", "application/vnd.ms-excel");
      return;
    }

    if (format === "pdf") {
      openPrintableReport(reportRows, totalValue, purchaseBudget30);
      return;
    }

    downloadBlob(generateCsv(reportRows), "makely-inventory-report.csv", "text/csv");
  }

  async function importColorMaster(colors: ColorItem[]) {
    if (!writeAllowed) return;
    const colorMap = new Map(colors.map((color) => [color.code, color]));
    updateState((current) => ({
      ...current,
      colors: current.colors.map((color) => colorMap.get(color.code) ?? color),
    }));
    setActiveSession(createDraftSession({ ...state, colors }));

    if (supabase) {
      try {
        setSyncMessage("Saving Color Master...");
        await saveRemoteColors(colors);
        setSyncMessage("Color Master saved to Supabase");
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : "Failed to save Color Master");
      }
    }
  }

  async function handleSeedRemote() {
    if (!adminAllowed) return;
    try {
      const initial = createInitialState();
      setSyncMessage("Seeding 221 colors...");
      await seedRemoteColors(initial.colors);
      const remoteState = await fetchRemoteState();
      setState(remoteState);
      setActiveSession(createDraftSession(remoteState));
      setSyncMessage("221 colors seeded to Supabase");
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Failed to seed Supabase");
    }
  }

  if (authLoading && supabase && !session) {
    return <div className="center-screen">Loading...</div>;
  }

  if (supabase && !session) {
    return <LoginScreen />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>Makely</strong>
            <span>DIY PERLER BEADS STUDIO</span>
          </div>
        </div>
        <nav>
          <NavButton icon={<BarChart3 />} label="Dashboard" view="dashboard" active={view} setView={setView} />
          <NavButton icon={<Boxes />} label="Color Master" view="colors" active={view} setView={setView} />
          <NavButton icon={<Activity />} label="Stock Opname" view="opname" active={view} setView={setView} />
          <NavButton icon={<PackagePlus />} label="Restock" view="restock" active={view} setView={setView} />
          <NavButton icon={<AlertTriangle />} label="Analytics" view="analytics" active={view} setView={setView} />
          <NavButton icon={<FileSpreadsheet />} label="Reports" view="reports" active={view} setView={setView} />
          {supabase && adminAllowed && <NavButton icon={<Users />} label="Staff" view="staff" active={view} setView={setView} />}
        </nav>
        <div className="connection">
          <span className={supabase ? "dot online" : "dot"} />
          {supabase ? `${profile?.role ?? "loading"} · ${profile?.email ?? ""}` : "Demo data mode"}
        </div>
        {supabase && (
          <button className="nav logout" onClick={() => supabase?.auth.signOut()} title="Logout">
            <LogOut />
            <span>Logout</span>
          </button>
        )}
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">Weight-based inventory analytics</p>
            <h1>{titleFor(view)}</h1>
          </div>
          <div className="toolbar">
            <SearchBox value={query} setValue={setQuery} />
          </div>
        </header>
        {syncMessage && <div className="sync-banner">{syncMessage}</div>}
        {supabase && profile?.role === "viewer" && <div className="sync-banner warning">Viewer role: kamu bisa lihat data, tapi tidak bisa import, restock, atau confirm opname.</div>}
        {supabase && adminAllowed && state.colors.length === 221 && state.colors.every((color) => color.currentStockGrams === createInitialState().colors.find((seed) => seed.code === color.code)?.currentStockGrams) && (
          <div className="sync-banner">
            Database masih terlihat seperti seed/demo. Import Color Master CSV untuk data real, atau gunakan tombol seed hanya kalau tabel Supabase masih kosong.
          </div>
        )}

        {view === "dashboard" && (
          <Dashboard
            totalValue={totalValue}
            totalStock={totalStock}
            reorderCount={reorderRows.length}
            outCount={outRows.length}
            fastest={fastest}
            purchaseBudget30={purchaseBudget30}
            topUsed={topUsed}
            timeline={reorderTimeline(rows)}
            statusValue={statusValue}
            trend={monthlyUsageTrend(state.usageRecords)}
          />
        )}

        {view === "colors" && <ColorMaster colors={filteredColors} rows={rows} allColors={state.colors} onImport={importColorMaster} canEdit={writeAllowed} onSeedRemote={handleSeedRemote} canSeed={Boolean(supabase && adminAllowed)} />}
        {view === "opname" && (
          <StockOpname
            colors={state.colors}
            lines={filteredOpnameLines}
            activeSession={activeSession}
            onLineChange={updateOpnameLine}
            onSaveDraft={saveDraft}
            onConfirm={confirmOpname}
            onNewDraft={() => setActiveSession(createDraftSession(state))}
            onImport={(lines) => setActiveSession((session) => ({ ...session, lines }))}
            canEdit={writeAllowed}
          />
        )}
        {view === "restock" && <RestockPanel colors={state.colors} restocks={state.restocks} onAdd={addRestock} canEdit={writeAllowed} />}
        {view === "analytics" && <AnalyticsPanel rows={rows} />}
        {view === "staff" && supabase && adminAllowed && <StaffPanel />}
        {view === "reports" && (
          <ReportsPanel
            rows={rows}
            totalValue={totalValue}
            purchaseBudget30={purchaseBudget30}
            onExport={exportRows}
            onReset={() => {
              if (!adminAllowed) return;
              resetState();
              const fresh = createInitialState();
              setState(fresh);
              setActiveSession(createDraftSession(fresh));
            }}
            canReset={adminAllowed}
          />
        )}
      </main>
    </div>
  );
}

function NavButton({ icon, label, view, active, setView }: { icon: React.ReactNode; label: string; view: View; active: View; setView: (view: View) => void }) {
  return (
    <button className={active === view ? "nav active" : "nav"} onClick={() => setView(view)} title={label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SearchBox({ value, setValue }: { value: string; setValue: (value: string) => void }) {
  return (
    <label className="search">
      <Search size={18} />
      <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Search code or name" />
    </label>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setLoading(true);
    setMessage("");

    const result =
      mode === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (result.error) {
      setMessage(result.error.message);
    } else if (mode === "signup") {
      setMessage("Account created. Kalau email confirmation aktif di Supabase, cek inbox dulu.");
    }
    setLoading(false);
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>Makely</strong>
            <span>DIY PERLER BEADS STUDIO</span>
          </div>
        </div>
        <h1>{mode === "login" ? "Staff Login" : "Create Staff Account"}</h1>
        <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} required /></label>
        {message && <p className="login-message">{message}</p>}
        <button className="primary" type="submit" disabled={loading}>{loading ? "Please wait..." : mode === "login" ? "Login" : "Sign up"}</button>
        <button type="button" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "Create account" : "Back to login"}
        </button>
      </form>
    </main>
  );
}

function Dashboard(props: {
  totalValue: number;
  totalStock: number;
  reorderCount: number;
  outCount: number;
  fastest: ReturnType<typeof buildForecastRows>[number];
  purchaseBudget30: number;
  topUsed: Array<{ code: string; usage: number; fill: string }>;
  timeline: Array<{ period: string; colors: number }>;
  statusValue: Array<{ name: string; value: number }>;
  trend: Array<{ period: string; usage: number }>;
}) {
  return (
    <section className="stack">
      <div className="kpi-grid">
        <Kpi icon={<WalletCards />} label="Total inventory value" value={formatMoney(props.totalValue)} />
        <Kpi icon={<Boxes />} label="Total stock" value={formatGram(props.totalStock)} />
        <Kpi icon={<AlertTriangle />} label="Need reorder" value={String(props.reorderCount)} />
        <Kpi icon={<Activity />} label="Out of stock" value={String(props.outCount)} />
        <Kpi icon={<BarChart3 />} label="Fastest used color" value={`${props.fastest.color.code} · ${formatGram(props.fastest.usageGrams)}`} />
        <Kpi icon={<PackagePlus />} label="30-day budget" value={formatMoney(props.purchaseBudget30)} />
      </div>

      <div className="chart-grid">
        <ChartCard title="Top used colors">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={props.topUsed}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="code" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="usage" radius={[6, 6, 0, 0]}>
                {props.topUsed.map((entry) => (
                  <Cell key={entry.code} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Reorder timeline">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={props.timeline}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="period" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="colors" fill="#a8643b" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Inventory value by stock status">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={props.statusValue}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip formatter={(value) => formatMoney(Number(value))} />
              <Bar dataKey="value" fill="#6b4b35" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Monthly usage trend">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={props.trend}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="period" />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="usage" stroke="#d77845" strokeWidth={3} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </section>
  );
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <article className="kpi">
      <div className="kpi-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ColorMaster({
  colors,
  rows,
  allColors,
  onImport,
  canEdit,
  onSeedRemote,
  canSeed,
}: {
  colors: ColorItem[];
  rows: ReturnType<typeof buildForecastRows>;
  allColors: ColorItem[];
  onImport: (colors: ColorItem[]) => void;
  canEdit: boolean;
  onSeedRemote: () => void;
  canSeed: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  function exportMasterCsv() {
    const csv = generateCsv(
      allColors.map((color) => ({
        code: color.code,
        name: color.name,
        hex: color.hex,
        stock_packs: gramsToPacks(color.currentStockGrams),
        current_stock_grams: color.currentStockGrams,
        estimated_bead_count: estimateBeads(color.currentStockGrams),
        cost_per_gram: color.costPerGram,
        minimum_stock_grams: color.minimumStockGrams,
        safety_stock_grams: color.safetyStockGrams,
        storage_location: color.storageLocation,
        active: color.active ? "TRUE" : "FALSE",
      })),
    );
    downloadBlob(csv, "makely-color-master.csv", "text/csv");
  }

  function importMasterCsv(file?: File) {
    if (!file) return;
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      beforeFirstChunk: stripCsvSeparatorHint,
      complete: (result) => {
        const sourceByCode = new Map(allColors.map((color) => [color.code, color]));
        const imported = result.data
          .map((row) => {
            const source = sourceByCode.get(String(row.code ?? "").trim());
            if (!source) return null;
            const stockFromPacks = row.stock_packs?.trim() ? packsToGrams(numberOr(0, row.stock_packs)) : null;
            const stock = stockFromPacks ?? numberOr(source.currentStockGrams, row.current_stock_grams);
            return {
              ...source,
              name: row.name?.trim() || source.name,
              hex: row.hex?.trim() || source.hex,
              currentStockGrams: stock,
              estimatedBeadCount: estimateBeads(stock),
              costPerGram: numberOr(source.costPerGram, row.cost_per_gram),
              minimumStockGrams: numberOr(source.minimumStockGrams, row.minimum_stock_grams),
              safetyStockGrams: numberOr(source.safetyStockGrams, row.safety_stock_grams),
              storageLocation: row.storage_location?.trim() ?? source.storageLocation,
              active: parseBoolean(source.active, row.active),
            };
          })
          .filter((color): color is ColorItem => Boolean(color));

        if (imported.length) {
          const importedByCode = new Map(imported.map((color) => [color.code, color]));
          onImport(allColors.map((color) => importedByCode.get(color.code) ?? color));
        }
      },
    });
  }

  return (
    <section className="stack">
      <div className="opname-actions">
        <div>
          <h2>Master stok aktual</h2>
          <p>Review data di sini. Untuk edit massal, export CSV, isi di Excel, lalu import lagi.</p>
        </div>
        <div className="button-row">
          <button onClick={exportMasterCsv} title="Export color master CSV"><Download size={18} /> Export CSV</button>
          <button onClick={() => fileRef.current?.click()} title="Import edited CSV" disabled={!canEdit}><Upload size={18} /> Import CSV</button>
          {canSeed && <button onClick={onSeedRemote} title="Seed Supabase colors"><Upload size={18} /> Seed DB</button>}
        </div>
        <input ref={fileRef} type="file" accept=".csv" hidden onChange={(event) => importMasterCsv(event.target.files?.[0])} />
      </div>
      <section className="panel">
        <Table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Color</th>
              <th>Stock bks</th>
              <th>Stock g</th>
              <th>Beads</th>
              <th>Cost/g</th>
              <th>Min</th>
              <th>Safety</th>
              <th>Location</th>
              <th>Active</th>
              <th>Reorder</th>
            </tr>
          </thead>
          <tbody>
            {colors.map((color) => {
              const row = rows.find((item) => item.color.code === color.code);
              return (
                <tr key={color.code}>
                  <td className="strong">{color.code}</td>
                  <td>
                    <span className="swatch" style={{ background: color.hex }} />
                    {color.name}
                  </td>
                  <td>{formatPacks(color.currentStockGrams)}</td>
                  <td>{formatGram(color.currentStockGrams)}</td>
                  <td className="strong">{estimateBeads(color.currentStockGrams).toLocaleString()}</td>
                  <td>{formatMoney(color.costPerGram)}</td>
                  <td>{formatGram(color.minimumStockGrams)}</td>
                  <td>{formatGram(color.safetyStockGrams)}</td>
                  <td>{color.storageLocation}</td>
                  <td><span className={`pill ${color.active ? "success" : "warning"}`}>{color.active ? "Active" : "Inactive"}</span></td>
                  <td>
                    <span className={`pill ${statusClass[row?.status ?? "Healthy"]}`}>{row?.status}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </section>
    </section>
  );
}

function StockOpname(props: {
  colors: ColorItem[];
  lines: OpnameLine[];
  activeSession: OpnameSession;
  onLineChange: (colorCode: string, value: string) => void;
  onSaveDraft: () => void;
  onConfirm: () => void;
  onNewDraft: () => void;
  onImport: (lines: OpnameLine[]) => void;
  canEdit: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const completed = props.activeSession.lines.filter((line) => typeof line.actualStockGrams === "number").length;
  const progress = Math.round((completed / props.activeSession.lines.length) * 100);

  function exportTemplate() {
    const csv = generateCsv(
      props.activeSession.lines.map((line) => ({
        color_code: line.colorCode,
        actual_stock_grams: line.actualStockGrams,
      })),
    );
    downloadBlob(csv, "makely-stock-opname-template.csv", "text/csv");
  }

  function importCsv(file?: File) {
    if (!file) return;
    Papa.parse<{ color_code: string; actual_stock_grams: string }>(file, {
      header: true,
      skipEmptyLines: true,
      beforeFirstChunk: stripCsvSeparatorHint,
      complete: (result) => {
        const imported = new Map(result.data.map((row) => [row.color_code, Number(row.actual_stock_grams)]));
        props.onImport(
          props.activeSession.lines.map((line) => {
            if (!imported.has(line.colorCode)) return line;
            const actualStockGrams = imported.get(line.colorCode) ?? "";
            const actual = actualStockGrams === "" ? line.previousSystemStock : actualStockGrams;
            return {
              ...line,
              actualStockGrams,
              calculatedUsage: Math.max(0, line.previousSystemStock + line.restockSinceLastOpname - actual),
              difference: actual - (line.previousSystemStock + line.restockSinceLastOpname),
            };
          }),
        );
      },
    });
  }

  return (
    <section className="stack">
      <div className="opname-actions">
        <div>
          <h2>{props.activeSession.name}</h2>
          <div className="progress">
            <span style={{ width: `${progress}%` }} />
          </div>
          <p>{completed} of {props.activeSession.lines.length} colors entered · {progress}%</p>
        </div>
        <div className="button-row">
          <button onClick={exportTemplate} title="Export CSV template"><Download size={18} /> CSV</button>
          <button onClick={() => fileRef.current?.click()} title="Import CSV" disabled={!props.canEdit}><Upload size={18} /> Import</button>
          <button onClick={props.onSaveDraft} title="Save draft" disabled={!props.canEdit}><Save size={18} /> Draft</button>
          <button className="primary" onClick={props.onConfirm} title="Confirm opname" disabled={!props.canEdit}><Check size={18} /> Confirm</button>
          <button onClick={props.onNewDraft} title="Start new opname"><RefreshCcw size={18} /> New</button>
        </div>
        <input ref={fileRef} type="file" accept=".csv" hidden onChange={(event) => importCsv(event.target.files?.[0])} />
      </div>

      <section className="panel">
        <Table>
          <thead>
            <tr>
              <th>Code</th>
              <th>System stock</th>
              <th>Restock since last opname</th>
              <th>Actual grams</th>
              <th>Calculated usage</th>
              <th>Difference</th>
            </tr>
          </thead>
          <tbody>
            {props.lines.map((line) => (
              <tr key={line.colorCode}>
                <td className="strong">{line.colorCode}</td>
                <td>{formatGram(line.previousSystemStock)}</td>
                <td>{formatGram(line.restockSinceLastOpname)}</td>
                <td>
                  <input
                    className="weight-input"
                    inputMode="decimal"
                    value={line.actualStockGrams}
                    onChange={(event) => props.onLineChange(line.colorCode, event.target.value)}
                    placeholder="0"
                    disabled={!props.canEdit}
                  />
                </td>
                <td>{formatGram(line.calculatedUsage)}</td>
                <td className={line.difference < 0 ? "negative" : "positive"}>{formatGram(line.difference)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </section>
  );
}

function RestockPanel({ colors, restocks, onAdd, canEdit }: { colors: ColorItem[]; restocks: RestockRecord[]; onAdd: (record: Omit<RestockRecord, "id">) => void; canEdit: boolean }) {
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    colorCode: colors[0]?.code ?? "",
    quantityGrams: 100,
    purchaseCost: 7500,
    supplier: "BeadSource ID",
    batchNumber: "",
    notes: "",
  });

  return (
    <section className="grid-two">
      <form
        className="panel form"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd(form);
        }}
      >
        <h2>Add restock</h2>
        <label>Date<input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
        <label>Color code<select value={form.colorCode} onChange={(event) => setForm({ ...form, colorCode: event.target.value })}>{colors.map((color) => <option key={color.code}>{color.code}</option>)}</select></label>
        <label>Quantity grams<input type="number" value={form.quantityGrams} onChange={(event) => setForm({ ...form, quantityGrams: Number(event.target.value) })} /></label>
        <label>Purchase cost<input type="number" value={form.purchaseCost} onChange={(event) => setForm({ ...form, purchaseCost: Number(event.target.value) })} /></label>
        <label>Supplier<input value={form.supplier} onChange={(event) => setForm({ ...form, supplier: event.target.value })} /></label>
        <label>Batch number<input value={form.batchNumber} onChange={(event) => setForm({ ...form, batchNumber: event.target.value })} /></label>
        <label>Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
        <button className="primary" type="submit" disabled={!canEdit}><PackagePlus size={18} /> Add restock</button>
      </form>
      <section className="panel">
        <h2>Recent restocks</h2>
        <Table>
          <thead><tr><th>Date</th><th>Code</th><th>Qty</th><th>Cost</th><th>Supplier</th></tr></thead>
          <tbody>{restocks.slice(0, 18).map((restock) => <tr key={restock.id}><td>{restock.date}</td><td>{restock.colorCode}</td><td>{formatGram(restock.quantityGrams)}</td><td>{formatMoney(restock.purchaseCost)}</td><td>{restock.supplier}</td></tr>)}</tbody>
        </Table>
      </section>
    </section>
  );
}

function AnalyticsPanel({ rows }: { rows: ReturnType<typeof buildForecastRows> }) {
  const zeroUsage = rows.filter((row) => row.usageGrams === 0);
  const slowMoving = rows.filter((row) => row.usageGrams > 0 && row.averageDailyUsage < 1);
  const top10 = [...rows].sort((a, b) => b.usageGrams - a.usageGrams).slice(0, 10);

  return (
    <section className="stack">
      <div className="mini-grid">
        <Kpi icon={<BarChart3 />} label="Top 10 most used" value={formatGram(top10.reduce((sum, row) => sum + row.usageGrams, 0))} />
        <Kpi icon={<Activity />} label="Zero usage colors" value={String(zeroUsage.length)} />
        <Kpi icon={<AlertTriangle />} label="Slow moving colors" value={String(slowMoving.length)} />
      </div>
      <ForecastTable rows={rows} />
    </section>
  );
}

function ForecastTable({ rows }: { rows: ReturnType<typeof buildForecastRows> }) {
  return (
    <section className="panel">
      <h2>Reorder prediction and purchase forecast</h2>
      <Table>
        <thead><tr><th>Code</th><th>Stock</th><th>Usage</th><th>Avg/day</th><th>Days until reorder</th><th>Status</th><th>14-day order</th><th>30-day order</th><th>Value</th></tr></thead>
        <tbody>{rows.slice().sort((a, b) => (a.daysUntilReorder ?? 9999) - (b.daysUntilReorder ?? 9999)).map((row) => <tr key={row.color.code}><td className="strong">{row.color.code}</td><td>{formatGram(row.color.currentStockGrams)}</td><td>{formatGram(row.usageGrams)}</td><td>{row.averageDailyUsage.toFixed(2)} g</td><td>{row.daysUntilReorder === null ? "No usage" : `${row.daysUntilReorder.toFixed(1)} days`}</td><td><span className={`pill ${statusClass[row.status]}`}>{row.status}</span></td><td>{formatGram(row.recommendedOrder14)}</td><td>{formatGram(row.recommendedOrder30)}</td><td>{formatMoney(row.inventoryValue)}</td></tr>)}</tbody>
      </Table>
    </section>
  );
}

function ReportsPanel(props: {
  rows: ReturnType<typeof buildForecastRows>;
  totalValue: number;
  purchaseBudget30: number;
  onExport: (format: "csv" | "xlsx" | "pdf") => void;
  onReset: () => void;
  canReset: boolean;
}) {
  const lowStockValue = props.rows.filter((row) => row.status !== "Healthy").reduce((sum, row) => sum + row.inventoryValue, 0);
  const deadStockValue = props.rows.filter((row) => row.usageGrams === 0).reduce((sum, row) => sum + row.inventoryValue, 0);

  return (
    <section className="stack">
      <div className="button-row">
        <button onClick={() => props.onExport("csv")}><Download size={18} /> Export CSV</button>
        <button onClick={() => props.onExport("xlsx")}><FileSpreadsheet size={18} /> Export Excel</button>
        <button onClick={() => props.onExport("pdf")}><Download size={18} /> Export PDF</button>
        <button onClick={props.onReset} disabled={!props.canReset}><RefreshCcw size={18} /> Reset demo data</button>
      </div>
      <div className="mini-grid">
        <Kpi icon={<WalletCards />} label="Inventory value report" value={formatMoney(props.totalValue)} />
        <Kpi icon={<PackagePlus />} label="Purchase recommendation" value={formatMoney(props.purchaseBudget30)} />
        <Kpi icon={<AlertTriangle />} label="Low stock value" value={formatMoney(lowStockValue)} />
        <Kpi icon={<Activity />} label="Dead stock value" value={formatMoney(deadStockValue)} />
      </div>
      <ForecastTable rows={props.rows} />
    </section>
  );
}

function StaffPanel() {
  const [profiles, setProfiles] = useState<StaffProfile[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    loadProfiles();
  }, []);

  async function loadProfiles() {
    try {
      setMessage("Loading staff...");
      setProfiles(await fetchStaffProfiles());
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load staff");
    }
  }

  async function changeRole(profileId: string, role: StaffRole) {
    try {
      setProfiles((current) => current.map((profile) => profile.id === profileId ? { ...profile, role } : profile));
      await updateStaffRole(profileId, role);
      setMessage("Role updated");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update role");
      await loadProfiles();
    }
  }

  return (
    <section className="stack">
      {message && <div className="sync-banner">{message}</div>}
      <section className="panel">
        <h2>Staff access</h2>
        <Table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile) => (
              <tr key={profile.id}>
                <td className="strong">{profile.email}</td>
                <td>{profile.fullName}</td>
                <td>
                  <select className="role-select" value={profile.role} onChange={(event) => changeRole(profile.id, event.target.value as StaffRole)}>
                    <option value="admin">admin</option>
                    <option value="staff">staff</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
                <td>{roleDescription(profile.role)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </section>
  );
}

function Table({ children }: { children: React.ReactNode }) {
  return <div className="table-wrap"><table>{children}</table></div>;
}

function numberOr(fallback: number, value: string | undefined) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(fallback: boolean, value: string | undefined) {
  if (!value) return fallback;
  return ["true", "yes", "active", "1"].includes(value.trim().toLowerCase());
}

function stripCsvSeparatorHint(chunk: string) {
  return chunk.replace(/^\uFEFF?sep=.+\r?\n/i, "");
}

function formatPacks(grams: number) {
  const packs = gramsToPacks(grams);
  return `${Number(packs.toFixed(2)).toLocaleString()} bks`;
}

function roleDescription(role: StaffRole) {
  if (role === "admin") return "Full access, import data, manage staff";
  if (role === "staff") return "Input restock, opname, import operational data";
  return "Read-only dashboard and reports";
}

function createDraftSession(state: AppState): OpnameSession {
  return {
    id: crypto.randomUUID(),
    name: `Stock Opname ${new Date().toLocaleDateString("id-ID")}`,
    status: "draft",
    createdAt: new Date().toISOString(),
    lines: state.colors.map((color) => calculateOpnameLine(color, "", state.restocks)),
  };
}

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function buildExcelHtml(rows: Record<string, unknown>[]) {
  const headers = Object.keys(rows[0] ?? {});
  const cell = (value: unknown) => String(value ?? "").replace(/[<>&]/g, (match) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[match] ?? match);
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><table><thead><tr>${headers.map((header) => `<th>${cell(header)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${headers.map((header) => `<td>${cell(row[header])}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></body></html>`;
}

function openPrintableReport(rows: Record<string, unknown>[], totalValue: number, purchaseBudget30: number) {
  const reportWindow = window.open("", "_blank", "noopener,noreferrer");
  if (!reportWindow) return;
  const headers = Object.keys(rows[0] ?? {});
  const bodyRows = rows.slice(0, 80);
  const cell = (value: unknown) => String(value ?? "").replace(/[<>&]/g, (match) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[match] ?? match);
  reportWindow.document.write(`<!doctype html>
    <html>
      <head>
        <title>Makely Inventory Report</title>
        <style>
          body { font-family: Arial, sans-serif; color: #2d2119; margin: 24px; }
          h1 { font-size: 22px; margin: 0 0 8px; }
          p { margin: 0 0 18px; }
          table { border-collapse: collapse; width: 100%; font-size: 10px; }
          th, td { border: 1px solid #d8c7b3; padding: 5px; text-align: left; }
          th { background: #fff4e5; }
        </style>
      </head>
      <body>
        <h1>Makely Inventory Analytics Report</h1>
        <p>Total value: ${cell(formatMoney(totalValue))} | 30-day purchase budget: ${cell(formatMoney(purchaseBudget30))}</p>
        <table><thead><tr>${headers.map((header) => `<th>${cell(header)}</th>`).join("")}</tr></thead><tbody>${bodyRows
          .map((row) => `<tr>${headers.map((header) => `<td>${cell(row[header])}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>
        <script>window.print();</script>
      </body>
    </html>`);
  reportWindow.document.close();
}

function titleFor(view: View) {
  return {
    dashboard: "Inventory Dashboard",
    colors: "Color Master Data",
    opname: "Stock Opname",
    restock: "Restock Records",
    analytics: "Usage Analytics",
    reports: "Reports",
    staff: "Staff Roles",
  }[view];
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
