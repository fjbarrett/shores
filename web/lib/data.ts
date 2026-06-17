// Server-only: read the scan history written by the scanner. In production this
// reads the self-hosted DigitalOcean Postgres (set DATABASE_URL); with no
// DATABASE_URL it falls back to the local results/ tree so `npm run dev` works
// offline. (Replaces the old Vercel Blob source.)
import { promises as fs } from "fs";
import path from "path";
import { aggregate } from "./aggregate";
import type { Row, ProviderDetail, Dashboard } from "./aggregate";
import { getPool } from "./db";

// Project root holding the scripts + results/. Defaults to the parent of the
// web app (so `npm run dev` inside web/ finds ../results). Override with
// CLOUDCHECK_ROOT, or point straight at the file with CLOUDCHECK_DATA.
export function projectRoot(): string {
  return process.env.CLOUDCHECK_ROOT || path.resolve(process.cwd(), "..");
}

export function historyPath(): string {
  return process.env.CLOUDCHECK_DATA || path.join(projectRoot(), "results", "history.jsonl");
}

export async function readRows(): Promise<Row[]> {
  const pool = getPool();
  if (pool) {
    const { rows } = await pool.query<{ row: Row }>(
      "SELECT row FROM history ORDER BY checked_at"
    );
    return rows.map((r) => r.row);
  }
  // local dev fallback: parse results/history.jsonl off disk
  const text = await fs.readFile(historyPath(), "utf8").catch(() => null);
  if (text == null) return []; // no scans available yet
  const out: Row[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Row);
    } catch {
      // skip a malformed/partial line rather than failing the whole dashboard
    }
  }
  return out;
}

// The newest per-run snapshot holds the full nested detail (regions, per-endpoint
// HTTP, DoH answers, globe probes) that the flat history can't carry.
type Snapshot = { checked_at: string; vantage: string; results: ProviderDetail[] };

export async function readLatestSnapshot(): Promise<Snapshot | null> {
  const pool = getPool();
  if (pool) {
    const { rows } = await pool.query<{ data: Snapshot }>(
      "SELECT data FROM snapshots ORDER BY checked_at DESC LIMIT 1"
    );
    return rows[0]?.data ?? null;
  }
  const dir = path.join(projectRoot(), "results", "runs");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  files.sort(); // run ids are ISO timestamps -> lexical sort = chronological
  const latest = files[files.length - 1];
  try {
    return JSON.parse(await fs.readFile(path.join(dir, latest), "utf8"));
  } catch {
    return null;
  }
}

// Build the aggregated dashboard and attach the full per-provider detail from
// the newest snapshot. Shared by the API routes and the provider pages.
export async function getDashboard(): Promise<Dashboard> {
  const rows = await readRows();
  const agg = aggregate(rows);
  const snap = await readLatestSnapshot();
  if (snap) {
    const byKey = new Map(snap.results.map((d) => [d.key, d]));
    for (const p of agg.providers) p.detail = byKey.get(p.key) ?? null;
  }
  return agg;
}

// --- per-region history --------------------------------------------------- //
// Derived from the most recent snapshots so each region gets its own timeline,
// mirroring the provider history.
export interface RegionPoint {
  t: string;
  ok: boolean;
}
export interface RegionEntry {
  chronic: boolean;
  status: string;
  points: RegionPoint[];
}
export interface RegionFile {
  provider: string;
  name: string;
  kind: string;
  generatedAt?: string;
  regions: Record<string, RegionEntry>;
}

export async function readRegionFile(key: string): Promise<RegionFile | null> {
  const pool = getPool();
  if (pool) {
    const { rows } = await pool.query<{ data: Snapshot }>(
      "SELECT data FROM snapshots ORDER BY checked_at DESC LIMIT 90"
    );
    // query is newest-first; feed the builder oldest-first to match the fs path
    return buildRegionFile(key, rows.map((r) => r.data).reverse());
  }
  return buildRegionFileFromFs(key); // local dev: reconstruct from results/runs
}

// Accumulate a per-region timeline for one provider from snapshots ordered
// oldest -> newest. Shared by the Postgres and local-fs read paths.
function buildRegionFile(key: string, snaps: Snapshot[]): RegionFile | null {
  const out: RegionFile = { provider: key, name: key, kind: "", regions: {} };
  let found = false;
  for (const snap of snaps) {
    const r = snap.results?.find((x) => x.key === key);
    const reg = r?.regions;
    if (!r || !reg || reg.error || !reg.items?.length) continue;
    found = true;
    out.name = r.name;
    out.kind = reg.kind;
    for (const it of reg.items) {
      const e = (out.regions[it.name] ??= { chronic: false, status: "", points: [] });
      e.points.push({ t: snap.checked_at, ok: !!it.ok });
      e.chronic = !!it.chronic;
      e.status = it.status || "";
    }
  }
  return found ? out : null;
}

async function buildRegionFileFromFs(key: string): Promise<RegionFile | null> {
  const dir = path.join(projectRoot(), "results", "runs");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return null;
  }
  const snaps: Snapshot[] = [];
  for (const f of files.slice(-90)) {
    try {
      snaps.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
    } catch {
      // skip unreadable snapshot
    }
  }
  return buildRegionFile(key, snaps);
}
