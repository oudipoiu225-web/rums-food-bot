import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const [row] = await db.select().from(profiles).where(eq(profiles.id, Number(id)));
  if (!row || row.userId !== user.id) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ profile: row });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const [existing] = await db.select().from(profiles).where(eq(profiles.id, Number(id)));
  if (!existing || existing.userId !== user.id) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const body = await req.json();
    const update: Partial<typeof profiles.$inferInsert> = {};
    if (body.title !== undefined) update.title = body.title;
    if (body.baseUrl !== undefined) update.baseUrl = body.baseUrl;
    if (body.username !== undefined) update.username = body.username;
    if (body.password) update.passwordEnc = encryptSecret(body.password);
    if (body.captchaMode !== undefined) update.captchaMode = body.captchaMode;
    if (body.sessionCookie !== undefined) update.sessionCookie = body.sessionCookie;
    if (body.telegramToken !== undefined) update.telegramToken = body.telegramToken;
    if (body.telegramChatId !== undefined) update.telegramChatId = body.telegramChatId;
    if (body.active !== undefined) update.active = body.active;
    update.updatedAt = new Date();
    const [row] = await db.update(profiles).set(update).where(eq(profiles.id, Number(id))).returning();
    return NextResponse.json({ profile: row });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "ط·آ®ط·آ·ط·آ§" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const [existing] = await db.select().from(profiles).where(eq(profiles.id, Number(id)));
  if (!existing || existing.userId !== user.id) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await db.delete(profiles).where(eq(profiles.id, Number(id)));
  return NextResponse.json({ ok: true });
}