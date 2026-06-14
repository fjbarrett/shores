import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { projectRoot, getDashboard } from "@/lib/data";

const run = promisify(execFile);
export const dynamic = "force-dynamic";

// POST /api/scan — run cloudcheck.py once (it appends to results/history.jsonl)
// and return the freshly aggregated dashboard.
export async function POST() {
  // In remote mode (deployed on Vercel) scans are produced by the Proxmox box
  // on a cron and pushed to Blob — there is no local python here to invoke.
  if (process.env.CLOUDCHECK_HISTORY_URL) {
    return NextResponse.json(
      { error: "Scans run on the Proxmox box every 30 min; this dashboard is read-only." },
      { status: 501 }
    );
  }
  const root = projectRoot();
  const script = path.join(root, "cloudcheck.py");
  try {
    await run("python3", [script, "--no-color"], { cwd: root, timeout: 90_000 });
  } catch (err: unknown) {
    const e = err as { code?: number; killed?: boolean; stderr?: string; message?: string };
    // cloudcheck.py exits 1 when a provider is degraded/down — expected, not an error.
    if (e.killed) {
      return NextResponse.json({ error: "scan timed out" }, { status: 504 });
    }
    if (typeof e.code === "number" && e.code !== 0 && e.code !== 1) {
      return NextResponse.json(
        { error: e.stderr?.trim() || e.message || "scan failed" },
        { status: 500 }
      );
    }
  }
  return NextResponse.json(await getDashboard());
}
