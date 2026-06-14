import Link from "next/link";
import { notFound } from "next/navigation";
import { getDashboard } from "@/lib/data";
import type { Incident, ProviderAgg, ProviderDetail, RegionItem, State } from "@/lib/aggregate";
import { ProviderLogo } from "@/lib/provider-logos";

export const dynamic = "force-dynamic";

const TONE: Record<State, { dot: string; text: string; badge: string; bar: string }> = {
  UP: { dot: "bg-emerald-400", text: "text-emerald-400", badge: "bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/30", bar: "bg-emerald-400" },
  DEGRADED: { dot: "bg-amber-400", text: "text-amber-400", badge: "bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/30", bar: "bg-amber-400" },
  DOWN: { dot: "bg-rose-500", text: "text-rose-400", badge: "bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/30", bar: "bg-rose-500" },
  UNKNOWN: { dot: "bg-slate-500", text: "text-slate-400", badge: "bg-slate-500/10 text-slate-300 ring-1 ring-slate-500/30", bar: "bg-slate-600" },
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const ok = (b: boolean) =>
  b ? <span className="text-emerald-400">✓</span> : <span className="text-rose-400">✗</span>;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-white/[0.06] py-5">
      <h2 className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

// Names like "US-East (Newark) Block Storage" share a "US-East (Newark)" prefix
// — used to group a provider's many components under one region header.
function regionGroupKey(name: string): string | null {
  const m = name.match(/^(.+?\([^)]*\))/);
  return m ? m[1].trim() : null;
}
function shortLabel(name: string, prefix: string): string {
  return name.slice(prefix.length).trim() || "core";
}

function Regions({ d }: { d: ProviderDetail }) {
  const reg = d.regions;
  if (!reg || reg.error || !reg.total) {
    return (
      <p className="text-sm text-slate-500">
        {reg?.error ? `error: ${reg.error}` : "No per-region data for this provider."}
      </p>
    );
  }
  const pct = (reg.up / reg.total) * 100;
  // 0 = real outage (red), 1 = chronic re-route (amber, excluded), 2 = up
  const rank = (i: RegionItem) => (i.chronic ? 1 : i.ok ? 2 : 0);
  const realDown = reg.items.filter((i) => rank(i) === 0).length;
  const chronic = reg.items.filter((i) => i.chronic).length;
  const listsAll = reg.kind !== "products";

  // Surface problems directly; collapse the healthy majority (grouped by region).
  const problems = reg.items
    .filter((i) => rank(i) !== 2)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const healthy = reg.items.filter((i) => rank(i) === 2);

  const groups = new Map<string, RegionItem[]>();
  const loose: RegionItem[] = [];
  for (const it of healthy) {
    const k = regionGroupKey(it.name);
    const arr = k ? groups.get(k) : null;
    if (k && arr) arr.push(it);
    else if (k) groups.set(k, [it]);
    else loose.push(it);
  }
  // a one-item "group" isn't worth a header — fold it back into the loose list
  for (const [k, items] of [...groups]) {
    if (items.length < 2) {
      loose.push(...items);
      groups.delete(k);
    }
  }
  const groupList = [...groups].sort((a, b) => a[0].localeCompare(b[0]));
  loose.sort((a, b) => a.name.localeCompare(b.name));

  const regionLink = (name: string) => `/provider/${d.key}/region?r=${encodeURIComponent(name)}`;
  const chip = "rounded px-2 py-1 text-xs text-slate-400 ring-1 ring-white/10 transition hover:brightness-150";

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 text-sm">
        <span className="text-slate-300">
          <span className="font-mono font-semibold text-emerald-400">{reg.up}</span>
          <span className="text-slate-500"> / {reg.total} up</span>
          {realDown > 0 && <span className="ml-2 font-mono text-rose-400">{realDown} down</span>}
          {chronic > 0 && (
            <span className="ml-2 font-mono text-amber-400/80" title="down in ~every recent scan — persistently re-routed / under maintenance, so not counted as a live outage">
              {chronic} re-routed (excluded)
            </span>
          )}
          <span className="ml-2 text-xs text-slate-600">({reg.kind})</span>
        </span>
        <span className="text-xs text-slate-500">{pct.toFixed(1)}%</span>
      </div>
      <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-emerald-400" style={{ width: `${pct}%` }} />
      </div>

      {problems.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-1.5">
          {problems.map((it, i) => {
            const cls =
              rank(it) === 0
                ? "bg-rose-500/10 text-rose-300 ring-rose-500/30"
                : "text-amber-300/70 ring-amber-400/20";
            return (
              <Link
                key={i}
                href={regionLink(it.name)}
                title={it.chronic ? `${it.status} · re-routed in ~every recent scan (excluded)` : it.status}
                className={`truncate rounded px-2 py-1 text-xs ring-1 transition hover:brightness-150 ${cls}`}
              >
                {rank(it) === 0 ? "● " : "↻ "}
                {it.name}
              </Link>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-emerald-400/80">
          All {reg.total} {reg.kind} operational.
        </p>
      )}

      {!listsAll && (
        <p className="mt-2 text-xs text-slate-600">
          {reg.up} healthy products not listed individually; showing impacted only.
        </p>
      )}

      {healthy.length > 0 && (
        <details className="group/reg mt-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-slate-400 transition hover:text-slate-200 [&::-webkit-details-marker]:hidden">
            <span className="inline-block text-slate-600 transition group-open/reg:rotate-90">▸</span>
            {problems.length > 0
              ? `Show ${healthy.length} healthy ${reg.kind}`
              : `Show all ${healthy.length} ${reg.kind}`}
          </summary>
          <div className="max-h-[30rem] space-y-3 overflow-y-auto px-3 pb-3">
            {groupList.map(([key, items]) => (
              <div key={key}>
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-xs font-medium text-slate-300">{key}</span>
                  <span className="font-mono text-[10px] text-emerald-400/60">{items.length}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {items
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((it, i) => (
                      <Link key={i} href={regionLink(it.name)} title={it.status} className={chip}>
                        {shortLabel(it.name, key)}
                      </Link>
                    ))}
                </div>
              </div>
            ))}
            {loose.length > 0 && (
              <div>
                {groupList.length > 0 && (
                  <div className="mb-1 text-xs font-medium text-slate-300">Other</div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {loose.map((it, i) => (
                    <Link key={i} href={regionLink(it.name)} title={it.status} className={`truncate ${chip}`}>
                      {it.name}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function impactCls(impact: string): string {
  const i = impact.toLowerCase();
  if (["critical", "major", "high"].includes(i)) return "bg-rose-500/10 text-rose-300 ring-rose-500/30";
  if (["minor", "medium"].includes(i)) return "bg-amber-400/10 text-amber-300 ring-amber-400/30";
  if (i === "maintenance") return "bg-sky-400/10 text-sky-300 ring-sky-400/30";
  return "bg-white/5 text-slate-300 ring-white/10";
}
function isOngoing(inc: Incident): boolean {
  return inc.status !== "resolved" && !inc.resolved_at;
}
function incidentDuration(inc: Incident): string {
  if (!inc.started_at) return "";
  const start = new Date(inc.started_at).getTime();
  const end = inc.resolved_at ? new Date(inc.resolved_at).getTime() : Date.now();
  return fmtDur(end - start);
}

function isImportant(inc: Incident): boolean {
  return isOngoing(inc) || ["critical", "major", "high"].includes(inc.impact.toLowerCase());
}

function Incidents({ providerKey, incidents }: { providerKey: string; incidents: Incident[] }) {
  if (incidents.length === 0) {
    return <p className="text-sm text-slate-500">No incidents in the provider feed.</p>;
  }
  const important = incidents.filter(isImportant);
  const hidden = incidents.length - important.length;
  if (important.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No major or ongoing incidents — {incidents.length} minor/resolved in the feed.
      </p>
    );
  }
  return (
    <>
      <ul className="space-y-2">
      {important.map((inc) => (
        <li key={inc.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ring-1 ${impactCls(inc.impact)}`}>
              {inc.impact}
            </span>
            <Link
              href={`/provider/${providerKey}/incident/${encodeURIComponent(inc.id)}`}
              className="min-w-0 flex-1 truncate font-medium text-slate-200 hover:underline"
            >
              {inc.name}
            </Link>
            {isOngoing(inc) ? (
              <span className="font-mono text-xs text-amber-400">ongoing · {incidentDuration(inc)}</span>
            ) : (
              <span className="font-mono text-xs text-slate-500">{incidentDuration(inc)}</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-slate-500">
            <span>
              {inc.started_at ? clock(inc.started_at) : "—"}
              {inc.resolved_at ? ` → ${clock(inc.resolved_at)}` : " → now"}
            </span>
            {inc.components.length > 0 && (
              <span className="truncate text-slate-600">
                {inc.components.slice(0, 6).join(", ")}
                {inc.components.length > 6 ? " …" : ""}
              </span>
            )}
          </div>
        </li>
      ))}
      </ul>
      {hidden > 0 && (
        <p className="mt-2 text-xs text-slate-600">
          + {hidden} minor / resolved incident{hidden > 1 ? "s" : ""} not shown
        </p>
      )}
    </>
  );
}

function Methods({ d }: { d: ProviderDetail }) {
  const eps = Object.entries(d.http.endpoints);
  const dohEntries = Object.entries(d.dns.doh);
  return (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
      {d.status.state !== "n/a" && (
        <div>
          <div className="mb-1 text-xs font-medium text-slate-400">Status feed</div>
          {(() => {
            const cur = (d.incidents ?? []).find(isOngoing) ?? (d.incidents ?? [])[0];
            return cur ? (
              <Link
                href={`/provider/${d.key}/incident/${encodeURIComponent(cur.id)}`}
                className="font-mono text-xs text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-200"
              >
                {d.status.line}
              </Link>
            ) : (
              <p className="font-mono text-xs text-slate-500">{d.status.line}</p>
            );
          })()}
        </div>
      )}

      <div>
        <div className="mb-1 text-xs font-medium text-slate-400">HTTP reachability</div>
        <ul className="space-y-0.5">
          {eps.map(([url, e]) => (
            <li key={url} className="flex items-center gap-2 font-mono text-xs">
              {ok(e.ok)}
              <span className="text-slate-500">{e.code || "—"}</span>
              <span className="truncate text-slate-400">{url}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium text-slate-400">DNS · {d.dns.host}</div>
        <p className="font-mono text-xs text-slate-500">
          {ok(d.dns.ok)} {d.dns.v4.length} A / {d.dns.v6.length} AAAA
        </p>
        {d.dns.v4.length > 0 && (
          <p className="mt-0.5 font-mono text-[11px] text-slate-600">{d.dns.v4.join(", ")}</p>
        )}
        {dohEntries.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {dohEntries.map(([res, ips]) => (
              <li key={res} className="font-mono text-[11px] text-slate-600">
                <span className="text-slate-400">{res}:</span> {ips.length ? ips.join(", ") : "—"}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 font-mono text-xs text-slate-500">
          {ok(d.ipv6.ok)} IPv6 TCP/443 to {d.ipv6.host}
        </p>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium text-slate-400">Global vantage (Globalping)</div>
        {!d.globe ? (
          <p className="text-xs text-slate-600">Not run — start a scan with the --globe flag.</p>
        ) : d.globe.error ? (
          <p className="text-xs text-slate-600">{d.globe.error}</p>
        ) : (
          <div>
            <p className="mb-1 font-mono text-xs text-slate-500">
              {d.globe.up}/{d.globe.total} probes reachable
            </p>
            <div className="flex flex-wrap gap-1">
              {d.globe.probes.map((p, i) => (
                <span
                  key={i}
                  title={`${p.city} · ${p.net} · ${p.code ?? "—"}`}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-mono ring-1 ${
                    p.ok ? "text-emerald-300 ring-emerald-400/30" : "text-rose-300 ring-rose-500/40"
                  }`}
                >
                  {p.country}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtDur(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const dys = Math.floor(h / 24);
  return h % 24 ? `${dys}d ${h % 24}h` : `${dys}d`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Bare domain of a URL (drops scheme + leading "www."), for link labels.
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function History({ p }: { p: ProviderAgg }) {
  const h = p.history;
  if (h.length === 0) return <p className="text-sm text-slate-500">No history recorded yet.</p>;

  const now = Date.now();
  const firstAt = h[0].checked_at;
  const lastAt = h[h.length - 1].checked_at;
  const windowMs = new Date(lastAt).getTime() - new Date(firstAt).getTime();

  // collapse consecutive same-state scans into segments (oldest → newest)
  type Seg = {
    state: State;
    start: string;
    count: number;
    headline: string;
    regionsUp: number | null;
    regionsTotal: number | null;
    durMs: number;
    ongoing: boolean;
  };
  const segs: Seg[] = [];
  for (const pt of h) {
    const prev = segs[segs.length - 1];
    if (prev && prev.state === pt.state) {
      prev.count++;
      prev.headline = pt.headline || prev.headline;
      prev.regionsUp = pt.regionsUp;
      prev.regionsTotal = pt.regionsTotal;
    } else {
      segs.push({
        state: pt.state,
        start: pt.checked_at,
        count: 1,
        headline: pt.headline,
        regionsUp: pt.regionsUp,
        regionsTotal: pt.regionsTotal,
        durMs: 0,
        ongoing: false,
      });
    }
  }
  for (let i = 0; i < segs.length; i++) {
    const startMs = new Date(segs[i].start).getTime();
    const endMs = i + 1 < segs.length ? new Date(segs[i + 1].start).getTime() : now;
    segs[i].durMs = endMs - startMs;
    segs[i].ongoing = i === segs.length - 1;
  }

  const changes = segs.length - 1;
  const current = segs[segs.length - 1];

  return (
    <div className="space-y-5">
      {/* stat strip */}
      <div className="flex flex-wrap gap-x-8 gap-y-2 font-mono text-xs text-slate-500">
        <span>
          uptime{" "}
          <span className={`font-semibold ${TONE[p.current.state].text}`}>
            {p.uptimePct.toFixed(1)}%
          </span>
        </span>
        <span>
          observed <span className="text-slate-300">{windowMs > 0 ? fmtDur(windowMs) : "—"}</span>
        </span>
        <span>
          state changes <span className="text-slate-300">{changes}</span>
        </span>
        <span>
          current{" "}
          <span className={`font-semibold ${TONE[current.state].text}`}>{current.state}</span> for{" "}
          <span className="text-slate-300">{fmtDur(current.durMs)}</span>
        </span>
      </div>

      {/* full-width timeline */}
      <div>
        <div className="flex h-9 items-stretch gap-[2px]">
          {h.map((pt, i) => (
            <span
              key={i}
              title={`${pt.state} · ${clock(pt.checked_at)}${
                pt.regionsTotal ? ` · ${pt.regionsUp}/${pt.regionsTotal} regions` : ""
              }${pt.headline ? ` · ${pt.headline}` : ""}`}
              className={`flex-1 rounded-sm ${TONE[pt.state].bar} opacity-80 transition hover:opacity-100`}
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
            No transitions — {current.state} across the whole observed window.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {[...segs].reverse().map((s, i) => (
              <li key={i} className="flex items-baseline gap-3 font-mono text-xs">
                <span className={`w-20 shrink-0 font-semibold ${TONE[s.state].text}`}>
                  {s.state}
                </span>
                <span className="w-16 shrink-0 text-slate-400">{fmtDur(s.durMs)}</span>
                <span className="shrink-0 text-slate-600">
                  {clock(s.start)}
                  {s.ongoing ? " → now" : ""}
                </span>
                {s.headline && (
                  <span className="min-w-0 flex-1 truncate text-slate-500">{s.headline}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return { title: `${key} · 9s` };
}

export default async function ProviderPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const data = await getDashboard();
  const p: ProviderAgg | undefined = data.providers.find((x) => x.key === key);
  if (!p) notFound();

  const t = TONE[p.current.state];
  const d = p.detail;

  return (
    <div className="mx-auto w-full max-w-[160rem] flex-1 px-6 py-6 lg:px-12">
      <Link
        href="/"
        className="font-mono text-sm text-slate-500 transition hover:text-slate-300"
      >
        ← all providers
      </Link>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.06] pb-5">
        <div className="flex items-center gap-3">
          <ProviderLogo keyId={p.key} />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{p.name}</h1>
            <p className="text-sm text-slate-400">{d?.headline ?? p.current.status_detail}</p>
            {p.current.note && <p className="mt-0.5 text-xs text-amber-400/90">⚠ {p.current.note}</p>}
          </div>
        </div>
        <span
          className={`font-mono text-sm font-semibold uppercase tracking-wider ${t.text}`}
        >
          {p.current.state}
        </span>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-slate-500">
        <span>
          uptime <span className={`font-mono font-semibold ${t.text}`}>{p.uptimePct.toFixed(1)}%</span>
        </span>
        <span>monitoring since {clock(p.history[0]?.checked_at ?? p.current.checked_at)}</span>
        <span>last checked {ago(p.current.checked_at)}</span>
        {p.current.vantage && p.current.vantage !== "local" && (
          <span className="text-sky-400">via {p.current.vantage}</span>
        )}
        {d && (
          <a href={d.page} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
            {hostOf(d.page)} ↗
          </a>
        )}
      </div>

      {!d ? (
        <p className="mt-8 text-sm text-slate-500">
          Full detail loads from the latest scan snapshot. Run a scan to generate it.
        </p>
      ) : (
        <>
          <Section title="Regions / components">
            <Regions d={d} />
          </Section>
          <Section title="Incidents">
            <Incidents providerKey={p.key} incidents={d.incidents ?? []} />
          </Section>
          <Section title="Methods">
            <Methods d={d} />
          </Section>
        </>
      )}

      <Section title="History">
        <History p={p} />
      </Section>
    </div>
  );
}
