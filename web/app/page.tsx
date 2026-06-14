"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Dashboard, Incident, ProviderAgg, State } from "@/lib/aggregate";
import { ProviderLogo } from "@/lib/provider-logos";

const TONE: Record<State, { dot: string; text: string; badge: string; bar: string }> = {
  UP: {
    dot: "bg-emerald-400",
    text: "text-emerald-400",
    badge: "bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/30",
    bar: "bg-emerald-400",
  },
  DEGRADED: {
    dot: "bg-amber-400",
    text: "text-amber-400",
    badge: "bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/30",
    bar: "bg-amber-400",
  },
  DOWN: {
    dot: "bg-rose-500",
    text: "text-rose-400",
    badge: "bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/30",
    bar: "bg-rose-500",
  },
  UNKNOWN: {
    dot: "bg-slate-500",
    text: "text-slate-400",
    badge: "bg-slate-500/10 text-slate-300 ring-1 ring-slate-500/30",
    bar: "bg-slate-600",
  },
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function ProviderCard({ p }: { p: ProviderAgg }) {
  const t = TONE[p.current.state];
  const c = p.current;
  const headline = p.detail?.headline || c.status_detail || "—";
  const regPct =
    p.regionsTotal && p.regionsTotal > 0 ? ((p.regionsUp ?? 0) / p.regionsTotal) * 100 : null;
  return (
    <Link
      href={`/provider/${p.key}`}
      className="group block w-full rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 text-left transition hover:border-white/20 hover:bg-white/[0.035]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderLogo keyId={p.key} />
          <h3 className="truncate font-medium text-slate-100">{p.name}</h3>
        </div>
        <span
          className={`shrink-0 font-mono text-[11px] font-semibold uppercase tracking-wider ${t.text}`}
        >
          {p.current.state}
        </span>
      </div>

      <p className="mt-1.5 line-clamp-1 text-sm text-slate-400">{headline}</p>

      {regPct !== null && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
            <span>
              <span className="font-mono text-slate-300">{p.regionsUp}</span> / {p.regionsTotal} regions
            </span>
            <span>{regPct.toFixed(0)}%</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full ${regPct >= 100 ? "bg-emerald-400" : "bg-amber-400"}`}
              style={{ width: `${regPct}%` }}
            />
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
        <span>{ago(c.checked_at)}</span>
        <span className="transition group-hover:text-slate-300">details →</span>
      </div>
    </Link>
  );
}

function impactRank(impact: string): number {
  const m: Record<string, number> = {
    critical: 3, major: 3, high: 3, minor: 1, medium: 1, low: 0, maintenance: 0, none: 0,
  };
  return m[impact.toLowerCase()] ?? 1;
}

// Reads every provider's incident feed, picks the single most important *ongoing*
// incident, and shows it as a banner linking to its detail page.
function TopIncident({ providers }: { providers: ProviderAgg[] }) {
  let best: { p: ProviderAgg; inc: Incident; score: number } | null = null;
  for (const p of providers) {
    for (const inc of p.detail?.incidents ?? []) {
      if (inc.status === "resolved" || inc.resolved_at) continue; // ongoing only
      const score = impactRank(inc.impact);
      if (
        !best ||
        score > best.score ||
        (score === best.score && (inc.started_at ?? "") > (best.inc.started_at ?? ""))
      ) {
        best = { p, inc, score };
      }
    }
  }
  if (!best) return null;
  const t = best.score >= 3 ? TONE.DOWN : TONE.DEGRADED;
  return (
    <Link
      href={`/provider/${best.p.key}/incident/${encodeURIComponent(best.inc.id)}`}
      className={`mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl px-4 py-3 transition hover:brightness-110 ${t.badge}`}
    >
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${t.dot}`} />
      <span className="font-medium">{best.p.name}</span>
      <span className="font-mono text-[10px] uppercase tracking-wide opacity-80">{best.inc.impact}</span>
      <span className="min-w-0 flex-1 truncate text-sm opacity-90">{best.inc.name}</span>
      <span className="font-mono text-xs opacity-70">ongoing</span>
    </Link>
  );
}

// Only shown when something is wrong — one independent, clickable pill per
// provider, each tinted by and labeled with its own state.
function StatusBanner({ affected }: { affected: ProviderAgg[] }) {
  if (affected.length === 0) return null;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-1.5">
      {affected.map((p) => {
        const pt = TONE[p.current.state];
        const word = p.current.state === "DEGRADED" ? "degraded" : "down";
        return (
          <Link
            key={p.key}
            href={`/provider/${p.key}`}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition hover:brightness-125 ${pt.badge}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${pt.dot}`} />
            <span className="font-medium">{p.name}</span>
            <span className="font-mono text-[10px] uppercase tracking-wide opacity-70">{word}</span>
          </Link>
        );
      })}
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/scans", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const affected = (data?.providers ?? []).filter((p) => p.current.state !== "UP");

  return (
    <div className="mx-auto w-full max-w-[160rem] flex-1 px-5 py-6">
      <TopIncident providers={data?.providers ?? []} />
      <StatusBanner affected={affected} />

      {error && (
        <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
          {error}
        </div>
      )}

      {/* providers */}
      {data && data.providers.length > 0 ? (
        <section className="mt-6 grid gap-8 grid-cols-[repeat(auto-fill,minmax(min(20rem,100%),1fr))]">
          {data.providers.map((p) => (
            <ProviderCard key={p.key} p={p} />
          ))}
        </section>
      ) : (
        <div className="mt-10 rounded-lg border border-dashed border-white/10 py-16 text-center">
          <p className="text-slate-400">No scans recorded yet.</p>
          <p className="mt-1 text-sm text-slate-600">
            Run <code className="font-mono text-slate-400">./cloudcheck.py</code> or press{" "}
            <span className="text-slate-400">Run scan</span> to populate the dashboard.
          </p>
        </div>
      )}
    </div>
  );
}
