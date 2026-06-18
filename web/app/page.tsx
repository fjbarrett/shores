import type { Dashboard } from "@/lib/aggregate";
import { getDashboard } from "@/lib/data";
import { Nav, ProviderGrid, StaleBanner, TopIncident, isCdn, isHidden } from "@/components/dashboard";

// Cache the rendered page for 60s (ISR) instead of hitting the small shared
// droplet on every request — scans only land every 30 min, so 60s staleness is
// invisible, and this removes a cheap traffic-amplification / cost vector.
export const revalidate = 60;

export default async function Home() {
  let data: Dashboard | null = null;
  let error: string | null = null;
  try {
    data = await getDashboard();
  } catch (e) {
    error = e instanceof Error ? e.message : "failed to load";
  }
  const providers = (data?.providers ?? []).filter((p) => !isCdn(p.key) && !isHidden(p.key));

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-6 py-6 lg:px-12">
      <Nav active="platforms" />
      <StaleBanner lastScan={data?.lastScan ?? null} />
      <TopIncident providers={providers} />

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
          {error}
        </div>
      )}

      {providers.length > 0 ? (
        <ProviderGrid providers={providers} />
      ) : !error ? (
        <div className="mt-10 rounded-lg border border-dashed border-white/10 py-16 text-center">
          <p className="text-slate-400">No scans recorded yet.</p>
          <p className="mt-1 text-sm text-slate-600">
            Run <code className="font-mono text-slate-400">./cloudcheck.py</code> to populate the dashboard.
          </p>
        </div>
      ) : null}
    </div>
  );
}
