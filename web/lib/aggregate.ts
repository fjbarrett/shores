// Pure aggregation of the append-only scan history into a dashboard model.
// No Node APIs here so it is safe to share types with client components.

export type State = "UP" | "DEGRADED" | "DOWN" | "UNKNOWN";

export interface Row {
  checked_at: string;
  provider: string;
  name: string;
  state: State;
  status_state: string;
  status_detail: string;
  http_ok: number;
  http_codes: string;
  dns_ok: number;
  dns_v4: number | null;
  dns_v6: number | null;
  doh_views: number | null;
  ipv6_ok: number | null;
  globe_up: number | string | null;
  globe_total: number | string | null;
  regions_up: number | string | null;
  regions_total: number | string | null;
  vantage: string;
  note: string;
}

// Full nested record from results/runs/<id>.json (written by cloudcheck.py).
export interface RegionItem {
  name: string;
  status: string;
  ok: boolean;
}
export interface ProviderDetail {
  key: string;
  name: string;
  page: string;
  state: State;
  headline?: string;
  note?: string;
  status: { state: string; detail: string; line: string };
  http: { ok: boolean; endpoints: Record<string, { ok: boolean; code: number; note: string }> };
  dns: {
    ok: boolean;
    host: string;
    v4: string[];
    v6: string[];
    doh: Record<string, string[]>;
    perspectives: number;
  };
  ipv6: { ok: boolean; host: string };
  globe:
    | { up: number; total: number; probes: { country: string; city: string; net: string; code: number | null; ok: boolean }[]; error?: string }
    | null;
  regions: { kind: string; up: number; total: number; items: RegionItem[]; error?: string } | null;
}

export interface HistoryPoint {
  checked_at: string;
  state: State;
  regionsUp: number | null;
  regionsTotal: number | null;
  headline: string;
  note: string;
}

export interface ProviderAgg {
  key: string;
  name: string;
  current: Row;
  counts: Record<State, number>;
  uptimePct: number;
  samples: number;
  regionsUp: number | null;
  regionsTotal: number | null;
  history: HistoryPoint[];
  detail?: ProviderDetail | null;
}

export interface RunAgg {
  checked_at: string;
  up: number;
  degraded: number;
  down: number;
  unknown: number;
  total: number;
}

export interface Dashboard {
  generatedAt: string;
  lastScan: string | null;
  totalRuns: number;
  totalRecords: number;
  summary: { up: number; degraded: number; down: number; unknown: number; total: number };
  regions: { up: number; total: number };
  providers: ProviderAgg[];
  runs: RunAgg[];
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const STATES: State[] = ["UP", "DEGRADED", "DOWN", "UNKNOWN"];
// Sort order so anything wrong floats to the top of the grid.
const SEVERITY: Record<State, number> = { DOWN: 0, DEGRADED: 1, UNKNOWN: 2, UP: 3 };

function normState(s: unknown): State {
  return STATES.includes(s as State) ? (s as State) : "UNKNOWN";
}

export function aggregate(rows: Row[]): Dashboard {
  const sorted = [...rows]
    .map((r) => ({ ...r, state: normState(r.state) }))
    .sort((a, b) => a.checked_at.localeCompare(b.checked_at));

  // --- per provider -------------------------------------------------------
  const byProvider = new Map<string, Row[]>();
  for (const r of sorted) {
    const arr = byProvider.get(r.provider) ?? [];
    arr.push(r);
    byProvider.set(r.provider, arr);
  }

  const providers: ProviderAgg[] = [];
  for (const [key, list] of byProvider) {
    const counts: Record<State, number> = { UP: 0, DEGRADED: 0, DOWN: 0, UNKNOWN: 0 };
    for (const r of list) counts[r.state]++;
    const current = list[list.length - 1];
    providers.push({
      key,
      name: current.name || key,
      current,
      counts,
      samples: list.length,
      uptimePct: list.length ? (counts.UP / list.length) * 100 : 0,
      regionsUp: toNum(current.regions_up),
      regionsTotal: toNum(current.regions_total),
      history: list.slice(-90).map((r) => ({
        checked_at: r.checked_at,
        state: r.state,
        regionsUp: toNum(r.regions_up),
        regionsTotal: toNum(r.regions_total),
        headline: r.status_detail || "",
        note: r.note || "",
      })),
    });
  }
  providers.sort(
    (a, b) =>
      SEVERITY[a.current.state] - SEVERITY[b.current.state] ||
      a.name.localeCompare(b.name)
  );

  // --- per run (scan) -----------------------------------------------------
  const byRun = new Map<string, RunAgg>();
  for (const r of sorted) {
    const run = byRun.get(r.checked_at) ?? {
      checked_at: r.checked_at, up: 0, degraded: 0, down: 0, unknown: 0, total: 0,
    };
    run.total++;
    if (r.state === "UP") run.up++;
    else if (r.state === "DEGRADED") run.degraded++;
    else if (r.state === "DOWN") run.down++;
    else run.unknown++;
    byRun.set(r.checked_at, run);
  }
  const runs = [...byRun.values()]
    .sort((a, b) => b.checked_at.localeCompare(a.checked_at))
    .slice(0, 60);

  // --- top-line summary uses each provider's *latest* state ---------------
  const summary = { up: 0, degraded: 0, down: 0, unknown: 0, total: providers.length };
  const regions = { up: 0, total: 0 };
  for (const p of providers) {
    if (p.current.state === "UP") summary.up++;
    else if (p.current.state === "DEGRADED") summary.degraded++;
    else if (p.current.state === "DOWN") summary.down++;
    else summary.unknown++;
    if (p.regionsTotal !== null) {
      regions.total += p.regionsTotal;
      regions.up += p.regionsUp ?? 0;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    lastScan: runs[0]?.checked_at ?? null,
    totalRuns: byRun.size,
    totalRecords: rows.length,
    summary,
    regions,
    providers,
    runs,
  };
}
