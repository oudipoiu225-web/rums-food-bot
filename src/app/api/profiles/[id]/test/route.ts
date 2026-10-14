import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { probeProfile } from "@/lib/rums";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, Number(id)));
  if (!profile || profile.userId !== user.id) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const result = await probeProfile(profile);
  await db.update(profiles).set({ lastCheckAt: new Date(), lastCheckStatus: result.reachable ? "reachable" : "unreachable", updatedAt: new Date() }).where(eq(profiles.id, profile.id));
  return NextResponse.json({ reachable: result.reachable, status: result.status, verdict: result.reachable ? "در دسترس" : "دسترس‌ناپذیر" });
}