import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { handleTelegramUpdate, type TgUpdate } from "@/lib/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || secret !== expected) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  // Process after responding so Telegram doesn't retry on slow handlers.
  after(handleTelegramUpdate(update).catch((e) => console.error("tg update error", e)));
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, webhook: "telegram" });
}
