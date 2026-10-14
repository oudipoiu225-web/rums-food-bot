import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { plans, profiles } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { schedulePlan } from "@/lib/scheduler";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const [plan] = await db.select().from(plans).where(eq(plans.id, Number(id)));
  if (!plan) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, plan.profileId));
  if (!profile || profile.userId !== user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json();
  const update: Partial<typeof plans.$inferInsert> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.weekdays !== undefined) update.weekdays = body.weekdays;
  if (body.meals !== undefined) update.meals = body.meals;
  if (body.foodPreference !== undefined) update.foodPreference = body.foodPreference;
  if (body.maxPrice !== undefined) update.maxPrice = Number(body.maxPrice);
  if (body.lookAheadDays !== undefined) update.lookAheadDays = Number(body.lookAheadDays);
  if (body.runAtHour !== undefined) update.runAtHour = Number(body.runAtHour);
  if (body.runAtMinute !== undefined) update.runAtMinute = Number(body.runAtMinute);
  if (body.active !== undefined) update.active = Boolean(body.active);
  const [row] = await db.update(plans).set(update).where(eq(plans.id, Number(id))).returning();
  if (body.runAtHour !== undefined || body.runAtMinute !== undefined) await schedulePlan(row.id);
  return NextResponse.json({ plan: row });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const [plan] = await db.select().from(plans).where(eq(plans.id, Number(id)));
  if (!plan) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, plan.profileId));
  if (!profile || profile.userId !== user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  await db.delete(plans).where(eq(plans.id, Number(id)));
  return NextResponse.json({ ok: true });
}