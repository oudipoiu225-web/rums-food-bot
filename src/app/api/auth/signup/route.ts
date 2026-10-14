import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword } from "@/lib/crypto";
import { createSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { email, password, name } = await req.json();
    if (!email || !password) return NextResponse.json({ error: "ایمیل و رمز الزامی است" }, { status: 400 });
    const [existing] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    if (existing) return NextResponse.json({ error: "این ایمیل قبلاً ثبت شده" }, { status: 409 });
    const [user] = await db.insert(users).values({ email: email.toLowerCase(), name: name ?? "", passwordHash: hashPassword(password) }).returning({ id: users.id });
    await createSession(user.id);
    return NextResponse.json({ ok: true, userId: user.id });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "خطا" }, { status: 500 });
  }
}
