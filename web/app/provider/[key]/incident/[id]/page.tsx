import Link from "next/link";
import { notFound } from "next/navigation";
import { getDashboard } from "@/lib/data";

export const dynamic = "force-dynamic";

function impactCls(impact: string): string {
  const i = impact.toLowerCase();
  if (["critical", "major", "high"].includes(i)) return "bg-rose-500/10 text-rose-300 ring-rose-500/30";
  if (["minor", "medium"].includes(i)) return "bg-amber-400/10 text-amber-300 ring-amber-400/30";
  if (i === "maintenance") return "bg-sky-400/10 text-sky-300 ring-sky-400/30";
  return "bg-white/5 text-slate-300 ring-white/10";
}
function fmtDur(ms: number): string {
  if (ms <= 0) return "0s";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
function clock(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function generateMetadata({ params }: { params: Promise<{ key: string; id: string }> }) {
  const { key } = await params;
  return { title: `incident · ${key} · 9s` };
}

export default async function IncidentPage({
  params,
}: {
  params: Promise<{ key: string; id: string }>;
}) {
  const { key, id } = await params;
  const data = await getDashboard();
  const p = data.providers.find((x) => x.key === key);
  const inc = p?.detail?.incidents?.find((i) => i.id === id);
  if (!p || !inc) notFound();

  const ongoing = inc.status !== "resolved" && !inc.resolved_at;
  const start = inc.started_at ? new Date(inc.started_at).getTime() : null;
  const end = inc.resolved_at ? new Date(inc.resolved_at).getTime() : Date.now();
  const dur = start ? fmtDur(end - start) : "—";

  return (
    <div className="mx-auto w-full max-w-[80rem] flex-1 px-5 py-6">
      <Link
        href={`/provider/${key}`}
        className="font-mono text-sm text-slate-500 transition hover:text-slate-300"
      >
        ← {p.name}
      </Link>

      <header className="mt-4 border-b border-white/[0.06] pb-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span
            className={`rounded px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide ring-1 ${impactCls(inc.impact)}`}
          >
            {inc.impact}
          </span>
          <span
            className={`font-mono text-xs uppercase tracking-wider ${ongoing ? "text-amber-400" : "text-emerald-400"}`}
          >
            {ongoing ? "ongoing" : "resolved"}
          </span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-100">{inc.name}</h1>
        <p className="mt-2 font-mono text-xs text-slate-500">
          {clock(inc.started_at)}
          {inc.resolved_at ? ` → ${clock(inc.resolved_at)}` : " → now"} ·{" "}
          <span className="text-slate-300">{dur}</span>
          {ongoing ? " and counting" : ""}
        </p>
      </header>

      {inc.components.length > 0 && (
        <section className="border-t border-white/[0.06] py-5">
          <h2 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Affected components
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {inc.components.map((c, i) => (
              <span key={i} className="rounded bg-white/[0.04] px-2 py-1 text-xs text-slate-300 ring-1 ring-white/10">
                {c}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="border-t border-white/[0.06] py-5">
        <h2 className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Update timeline
        </h2>
        {inc.updates.length === 0 ? (
          <p className="text-sm text-slate-500">No published updates.</p>
        ) : (
          <ol className="space-y-4">
            {inc.updates.map((u, i) => (
              <li key={i} className="border-l-2 border-white/10 pl-4">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono text-xs font-semibold uppercase tracking-wide text-slate-300">
                    {u.status || "update"}
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">{clock(u.at)}</span>
                </div>
                {u.body && <p className="mt-1 whitespace-pre-line text-sm text-slate-400">{u.body}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
