import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { verifyPassword } from "@/lib/crypto";
import { createSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json({ error: "ایمیل و رمز الزامی است" }, { status: 400 });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase().trim()));
    if (!user) {
      return NextResponse.json({ error: "حسابی با این ایمیل پیدا نشد" }, { status: 401 });
    }

    if (!verifyPassword(password, user.passwordHash)) {
      return NextResponse.json({ error: "رمز عبور اشتباه است" }, { status: 401 });
    }

    await createSession(user.id);
    return NextResponse.json({ ok: true, userId: user.id });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("DATABASE_URL")) {
      return NextResponse.json({ error: "خطای دیتابیس: DATABASE_URL تنظیم نشده" }, { status: 500 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
