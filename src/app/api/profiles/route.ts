import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db.select().from(profiles).where(eq(profiles.userId, user.id));
  return NextResponse.json({ profiles: rows });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { title, baseUrl, username, password, captchaMode, sessionCookie, telegramToken, telegramChatId } = await req.json();
    const [row] = await db.insert(profiles).values({
      userId: user.id, title: title ?? "سامانه سلف رفسنجان",
      baseUrl: baseUrl ?? "https://self.rums.ac.ir", username: username ?? "",
      passwordEnc: password ? encryptSecret(password) : "",
      captchaMode: captchaMode ?? "session",
      sessionCookie: sessionCookie ?? null,
      telegramToken: telegramToken ?? null, telegramChatId: telegramChatId ?? null,
    }).returning();
    return NextResponse.json({ profile: row });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "خطا" }, { status: 500 });
  }
}
