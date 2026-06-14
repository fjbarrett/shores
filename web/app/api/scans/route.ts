import { NextResponse } from "next/server";
import { getDashboard } from "@/lib/data";

export const dynamic = "force-dynamic"; // always read the latest file

export async function GET() {
  return NextResponse.json(await getDashboard());
}
