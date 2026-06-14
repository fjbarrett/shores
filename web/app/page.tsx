"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dashboard, ProviderAgg, RunAgg, State } from "@/lib/aggregate";
import { ProviderLogo } from "@/lib/provider-logos";

const POLL_MS = 20_000;

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

function MethodChip({ label, ok }: { label: string; ok: boolean | null }) {
  const cls =
    ok === null ? "text-slate-600" : ok ? "text-emerald-400/70" : "text-rose-400";
  const glyph = ok === null ? "·" : ok ? "✓" : "✗";
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide ${cls}`}
    >
      {glyph} {label}
    </span>
  );
}

function ProviderCard({ p }: { p: ProviderAgg }) {
  const t = TONE[p.current.state];
  const c = p.current;
  const globeOk =
    c.globe_total && Number(c.globe_total) > 0
      ? Number(c.globe_up) >= Number(c.globe_total) / 2
      : null;
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
      {c.note && <p className="mt-1 text-xs text-amber-400/90">⚠ {c.note}</p>}

      {regPct !== null && (
        <div className="mt-2.5">
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

      {/* state timeline (oldest → newest) */}
      <div className="mt-3 flex items-end gap-[2px]" title="scan history, oldest → newest">
        {p.history.length === 0 && <span className="text-xs text-slate-600">no history</span>}
        {p.history.slice(-28).map((h, i) => (
          <span
            key={i}
            title={`${h.state} · ${new Date(h.checked_at).toLocaleString()}`}
            className={`h-6 w-[5px] rounded-sm ${TONE[h.state].bar} opacity-80 hover:opacity-100`}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-slate-500">
          <span className={`font-mono font-semibold ${t.text}`}>{p.uptimePct.toFixed(1)}%</span> up
        </span>
        <span className="text-slate-500">{ago(c.checked_at)}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <MethodChip
          label="status"
          ok={c.status_state === "UNKNOWN" || c.status_state === "n/a" ? null : true}
        />
        <MethodChip label="http" ok={!!c.http_ok} />
        <MethodChip label="dns" ok={!!c.dns_ok} />
        <MethodChip label="ipv6" ok={c.ipv6_ok === null ? null : !!c.ipv6_ok} />
        <MethodChip label="globe" ok={globeOk} />
        {c.vantage && c.vantage !== "local" && (
          <span className="font-mono text-[10px] text-sky-400/80">via {c.vantage}</span>
        )}
        <span className="ml-auto text-[11px] text-slate-600 transition group-hover:text-slate-300">
          details →
        </span>
      </div>
    </Link>
  );
}

function StatTile({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
      <div className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
    </div>
  );
}

function RunBar({ run }: { run: RunAgg }) {
  const seg = (n: number, cls: string) =>
    n > 0 ? <span className={cls} style={{ flex: n }} /> : null;
  return (
    <div className="flex h-8 w-3 shrink-0 flex-col-reverse overflow-hidden rounded-sm" title={new Date(run.checked_at).toLocaleString()}>
      {seg(run.up, "bg-emerald-400")}
      {seg(run.degraded, "bg-amber-400")}
      {seg(run.down + run.unknown, "bg-rose-500")}
    </div>
  );
}

// Only shown when something is wrong — links straight to each affected provider.
function StatusBanner({ affected }: { affected: ProviderAgg[] }) {
  if (affected.length === 0) return null;
  const worst: State = affected.some(
    (p) => p.current.state === "DOWN" || p.current.state === "UNKNOWN"
  )
    ? "DOWN"
    : "DEGRADED";
  const t = TONE[worst];
  return (
    <div className={`mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl px-4 py-3 ${t.badge}`}>
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${t.dot}`} />
      {affected.map((p, i) => (
        <span key={p.key} className="text-sm">
          {i > 0 && <span className="opacity-50"> · </span>}
          <Link
            href={`/provider/${p.key}`}
            className="font-medium underline decoration-dotted underline-offset-2 hover:no-underline"
          >
            {p.name}
          </Link>{" "}
          <span className="opacity-80">
            {p.current.state === "DEGRADED" ? "degraded" : "down"}
          </span>
        </span>
      ))}
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(load, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  const s = data?.summary;
  const affected = (data?.providers ?? []).filter((p) => p.current.state !== "UP");

  return (
    <div className="mx-auto w-full max-w-[160rem] flex-1 px-5 py-6">
      {/* header */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.06] pb-5">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="font-mono text-lg font-semibold lowercase tracking-tight">
              fivenines <span className="font-normal text-slate-600">/ cloud status</span>
            </h1>
            <p className="text-xs text-slate-500">
              Independent multi-method up/down checks for the major cloud providers
            </p>
          </div>
        </div>
      </header>

      <StatusBanner affected={affected} />

      {error && (
        <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
          {error}
        </div>
      )}

      {/* summary */}
      <section className="mt-5 grid grid-cols-3 gap-3">
        <StatTile label="Operational" value={s?.up ?? 0} tone="text-emerald-400" />
        <StatTile label="Degraded" value={s?.degraded ?? 0} tone="text-amber-400" />
        <StatTile label="Down" value={(s?.down ?? 0) + (s?.unknown ?? 0)} tone="text-rose-400" />
      </section>

      {/* providers */}
      {data && data.providers.length > 0 ? (
        <section className="mt-6 grid gap-5 grid-cols-[repeat(auto-fill,minmax(min(20rem,100%),1fr))]">
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

      {/* recent scans strip */}
      {data && data.runs.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 font-mono text-[10px] font-medium uppercase tracking-wider text-slate-500">
            Recent scans
          </h2>
          <div className="flex items-end gap-1 overflow-x-auto rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            {[...data.runs].reverse().map((run) => (
              <RunBar key={run.checked_at} run={run} />
            ))}
          </div>
        </section>
      )}

      <footer className="mt-8 border-t border-white/[0.06] pt-4 font-mono text-[11px] text-slate-600">
        {data?.totalRecords ?? 0} records · reading{" "}
        <code className="font-mono">results/history.jsonl</code> · refreshes every {POLL_MS / 1000}s
      </footer>
    </div>
  );
}
