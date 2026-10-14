import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { plans, profiles, runs, reservations } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { executePlan } from "@/lib/rums";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const mine = await db.select().from(profiles).where(eq(profiles.userId, user.id));
  const ids = mine.map((p) => p.id);
  const all = ids.length ? await db.select().from(runs).where(and(...ids.map((id) => eq(runs.profileId, id)))).orderBy(desc(runs.startedAt)).limit(50) : [];
  const resv = ids.length ? await db.select().from(reservations).where(and(...ids.map((id) => eq(reservations.profileId, id)))).orderBy(desc(reservations.serviceDate)).limit(100) : [];
  return NextResponse.json({ runs: all, reservations: resv });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { profileId, planId, dryRun } = await req.json();
    const [profile] = await db.select().from(profiles).where(eq(profiles.id, Number(profileId)));
    if (!profile || profile.userId !== user.id) return NextResponse.json({ error: "پروفایل یافت نشد" }, { status: 404 });
    let plan = null;
    if (planId) { const [p] = await db.select().from(plans).where(eq(plans.id, Number(planId))); if (p && p.profileId === profile.id) plan = p; }
    const result = await executePlan({ profile, plan, trigger: "manual", options: { dryRun: Boolean(dryRun) } });
    return NextResponse.json({ ok: true, runId: result.runId, status: result.status, message: result.message, steps: result.steps });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "خطا" }, { status: 500 });
  }
}