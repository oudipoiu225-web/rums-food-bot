import { NextResponse } from "next/server";
import { pool } from "@/db";

export async function GET() {
  try {
    await pool.query("SELECT 1");
    return NextResponse.json({ ok: true, db: "connected" });
  } catch (err: unknown) {
    return NextResponse.json({ ok: false, db: "error", message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
