import { NextResponse } from "next/server";
import { getDashboard } from "@/lib/data";

// Allow the Vercel CDN to serve a cached copy for 60s (with 5-min stale-while-
// revalidate) so a flood of requests can't hammer the shared droplet/DB.
export const revalidate = 60;

export async function GET() {
  try {
    return NextResponse.json(await getDashboard(), {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
    });
  } catch (e) {
    // Never fail the build / a request hard on a transient DB blip; serve a short-
    // lived 503 that ISR will replace with good data within ~60s.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to load" },
      { status: 503, headers: { "Cache-Control": "public, s-maxage=10" } },
    );
  }
}
