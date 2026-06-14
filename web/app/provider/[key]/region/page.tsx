import Link from "next/link";
import { notFound } from "next/navigation";
import { readRegionFile } from "@/lib/data";
import type { RegionPoint } from "@/lib/data";

export const dynamic = "force-dynamic";

type Mark = "UP" | "DOWN";
const TONE: Record<Mark, { text: string; bar: string }> = {
  UP: { text: "text-emerald-400", bar: "bg-emerald-400" },
  DOWN: { text: "text-rose-400", bar: "bg-rose-500" },
};
const mark = (ok: boolean): Mark => (ok ? "UP" : "DOWN");

function fmtDur(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
function clock(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function History({ points }: { points: RegionPoint[] }) {
  const now = Date.now();
  const firstAt = points[0].t;
  const okCount = points.filter((p) => p.ok).length;
  const uptime = (okCount / points.length) * 100;

  type Seg = { m: Mark; start: string; durMs: number; ongoing: boolean };
  const segs: Seg[] = [];
  for (const p of points) {
    const prev = segs[segs.length - 1];
    if (prev && prev.m === mark(p.ok)) continue;
    segs.push({ m: mark(p.ok), start: p.t, durMs: 0, ongoing: false });
  }
  for (let i = 0; i < segs.length; i++) {
    const startMs = new Date(segs[i].start).getTime();
    const endMs = i + 1 < segs.length ? new Date(segs[i + 1].start).getTime() : now;
    segs[i].durMs = endMs - startMs;
    segs[i].ongoing = i === segs.length - 1;
  }
  const current = segs[segs.length - 1];
  const windowMs = new Date(points[points.length - 1].t).getTime() - new Date(firstAt).getTime();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-x-8 gap-y-2 font-mono text-xs text-slate-500">
        <span>
          uptime <span className={`font-semibold ${TONE[current.m].text}`}>{uptime.toFixed(1)}%</span>
        </span>
        <span>
          observed <span className="text-slate-300">{windowMs > 0 ? fmtDur(windowMs) : "—"}</span>
        </span>
        <span>
          state changes <span className="text-slate-300">{segs.length - 1}</span>
        </span>
        <span>
          current <span className={`font-semibold ${TONE[current.m].text}`}>{current.m}</span> for{" "}
          <span className="text-slate-300">{fmtDur(current.durMs)}</span>
        </span>
      </div>

      <div>
        <div className="flex h-9 items-stretch gap-[2px]">
          {points.map((p, i) => (
            <span
              key={i}
              title={`${mark(p.ok)} · ${clock(p.t)}`}
              className={`flex-1 rounded-sm ${TONE[mark(p.ok)].bar} opacity-80 transition hover:opacity-100`}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-600">
          <span>{clock(firstAt)}</span>
          <span>now</span>
        </div>
      </div>

      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-slate-600">
          state changes
        </div>
        {segs.length <= 1 ? (
          <p className="font-mono text-xs text-slate-600">
            No transitions — {current.m} across the whole observed window.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {[...segs].reverse().map((s, i) => (
              <li key={i} className="flex items-baseline gap-3 font-mono text-xs">
                <span className={`w-16 shrink-0 font-semibold ${TONE[s.m].text}`}>{s.m}</span>
                <span className="w-16 shrink-0 text-slate-400">{fmtDur(s.durMs)}</span>
                <span className="shrink-0 text-slate-600">
                  {clock(s.start)}
                  {s.ongoing ? " → now" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ r?: string }>;
}) {
  const { key } = await params;
  const { r } = await searchParams;
  return { title: `${r ?? "region"} · ${key} · fivenines` };
}

export default async function RegionPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ r?: string }>;
}) {
  const { key } = await params;
  const { r } = await searchParams;
  if (!r) notFound();
  const file = await readRegionFile(key);
  const entry = file?.regions?.[r];
  if (!file || !entry || entry.points.length === 0) notFound();

  const last = entry.points[entry.points.length - 1];
  const lastAt = last.t;
  // GCP's "regions" are really products/services (listed only during an incident);
  // statuspage providers expose components; the rest are probed geographic regions.
  const noun = file.kind === "products" ? "service" : file.kind === "components" ? "component" : "region";

  return (
    <div className="mx-auto w-full max-w-[100rem] flex-1 px-5 py-6">
      <Link
        href={`/provider/${key}`}
        className="font-mono text-sm text-slate-500 transition hover:text-slate-300"
      >
        ← {file.name}
      </Link>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.06] pb-5">
        <div>
          <p className="font-mono text-xs text-slate-500">{file.name} · {noun}</p>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-slate-100">{r}</h1>
          {entry.status && <p className="mt-1 text-sm text-slate-400">{entry.status}</p>}
        </div>
        <div className="text-right">
          <span className={`font-mono text-sm font-semibold uppercase tracking-wider ${TONE[mark(last.ok)].text}`}>
            {mark(last.ok)}
          </span>
          {entry.chronic && (
            <p
              className="mt-1 font-mono text-[11px] text-amber-400/80"
              title="down in ~every recent scan — persistently re-routed / under maintenance, so excluded from the provider's outage count"
            >
              ↻ re-routed (excluded)
            </p>
          )}
        </div>
      </header>

      <div className="mt-4 mb-6 text-sm text-slate-500">
        last checked {ago(lastAt)} · {noun}
        {file.kind === "products" && (
          <span className="text-slate-600"> — a Google Cloud service, listed only while it has an open incident</span>
        )}
      </div>

      <History points={entry.points} />
    </div>
  );
}
