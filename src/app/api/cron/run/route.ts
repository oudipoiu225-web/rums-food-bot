import { NextResponse } from "next/server";
import { runDuePlans } from "@/lib/scheduler";

export async function POST() {
  try {
    const report = await runDuePlans(5);
    return NextResponse.json({ checked: report.checked, executed: report.executed, results: report.results });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "خطا" }, { status: 500 });
  }
}