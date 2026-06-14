import type { Dashboard } from "@/lib/aggregate";
import { getDashboard } from "@/lib/data";
import { Nav, ProviderGrid, TopIncident, isCdn } from "@/components/dashboard";

export const dynamic = "force-dynamic"; // always read the latest scan, server-side
export const metadata = { title: "CDNs" };

export default async function CdnsPage() {
  let data: Dashboard | null = null;
  let error: string | null = null;
  try {
    data = await getDashboard();
  } catch (e) {
    error = e instanceof Error ? e.message : "failed to load";
  }
  const providers = (data?.providers ?? []).filter((p) => isCdn(p.key));

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-6 py-6 lg:px-12">
      <Nav active="cdn" />
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
          <p className="text-slate-400">No CDN data yet.</p>
          <p className="mt-1 text-sm text-slate-600">CDN providers appear after the next scan.</p>
        </div>
      ) : null}
    </div>
  );
}
