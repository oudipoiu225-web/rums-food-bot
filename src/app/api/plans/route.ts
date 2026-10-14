import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { plans, profiles } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { schedulePlan } from "@/lib/scheduler";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const mine = await db.select().from(profiles).where(eq(profiles.userId, user.id));
  const ids = mine.map((p) => p.id);
  const rows = ids.length ? await db.select().from(plans).where(and(...ids.map((id) => eq(plans.profileId, id)))) : [];
  const profileMap = new Map(mine.map((p) => [p.id, p]));
  return NextResponse.json({ plans: rows.map((r) => ({ ...r, profileTitle: profileMap.get(r.profileId)?.title ?? "" })) });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const { profileId, name, weekdays, meals, foodPreference, maxPrice, lookAheadDays, runAtHour, runAtMinute } = body;
    const [profile] = await db.select().from(profiles).where(eq(profiles.id, Number(profileId)));
    if (!profile || profile.userId !== user.id) return NextResponse.json({ error: "پروفایل یافت نشد" }, { status: 404 });
    const [row] = await db.insert(plans).values({
      profileId: Number(profileId),
      name: name ?? "قانون رزرو",
      weekdays: Array.isArray(weekdays) ? weekdays : [0, 1, 2, 3, 4],
      meals: Array.isArray(meals) ? meals : ["lunch"],
      foodPreference: foodPreference ?? "first",
      maxPrice: Number(maxPrice) || 0,
      lookAheadDays: Number(lookAheadDays) || 8,
      runAtHour: Number(runAtHour) ?? 8,
      runAtMinute: Number(runAtMinute) ?? 5,
    }).returning();
    const next = await schedulePlan(row.id);
    return NextResponse.json({ plan: { ...row, nextRunAt: next } });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "خطا" }, { status: 500 });
  }
}
