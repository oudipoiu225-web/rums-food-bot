// src/lib/bot.ts — Telegram bot for rums-food-bot (Food_rums_bot)
import { db } from "@/db";
import { users, profiles, plans, runs, telegramStates } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { encryptSecret, hashPassword } from "@/lib/crypto";
import { probeProfile, executePlan } from "@/lib/rums";
import { schedulePlan } from "@/lib/scheduler";
import { randomBytes } from "crypto";

/* ==================== Telegram API ==================== */

/** Minimal Telegram Bot API shapes — only the fields this bot reads. */
export interface TgChat {
  id: number;
}
export interface TgUser {
  id: number;
  first_name?: string;
}
export interface TgMessage {
  message_id: number;
  chat?: TgChat;
  from?: TgUser;
  text?: string;
}
export interface TgCallbackQuery {
  id: string;
  data?: string;
  from?: TgUser;
  message?: TgMessage;
}
export interface TgUpdate {
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
/** Bot API response envelope. */
export interface TgApiResponse {
  ok?: boolean;
  result?: { message_id?: number } & Record<string, unknown>;
}
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

async function tgApi(method: string, params: Record<string, unknown> = {}): Promise<TgApiResponse | null> {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20000),
    });
    return (await res.json().catch(() => null)) as TgApiResponse | null;
  } catch {
    return null;
  }
}

const tgSend = (chatId: number | string, text: string, extra: Record<string, unknown> = {}) =>
  tgApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });

const tgAnswerCb = (id: string, text = "") =>
  tgApi("answerCallbackQuery", { callback_query_id: id, text });

const tgDelete = (chatId: number | string, messageId: number) =>
  tgApi("deleteMessage", { chat_id: chatId, message_id: messageId });

const tgEditMarkup = (chatId: number | string, messageId: number, markup: unknown) =>
  tgApi("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup });

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function faDigits(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

/* ==================== Menus ==================== */
const MAIN_MENU = {
  keyboard: [
    [{ text: "🍽️ حساب سلف" }, { text: "📋 قانون رزرو" }],
    [{ text: "🧪 تست اتصال" }, { text: "▶️ رزرو دستی" }],
    [{ text: "📊 وضعیت من" }],
  ],
  resize_keyboard: true,
};

const DAYS_FA = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];
const MEALS_FA: Record<string, string> = { lunch: "ناهار", dinner: "شام", breakfast: "صبحانه" };
const MEAL_KEYS = ["lunch", "dinner", "breakfast"];

function dayKeyboard(selected: number[]) {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < 7; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, 7); j++) {
      row.push({
        text: `${selected.includes(j) ? "✅" : "⬜"} ${DAYS_FA[j]}`,
        callback_data: `day:${j}`,
      });
    }
    rows.push(row);
  }
  rows.push([{ text: "✅ تأیید", callback_data: "days_done" }]);
  return { inline_keyboard: rows };
}

function mealKeyboard(selected: string[]) {
  const row = MEAL_KEYS.map((k) => ({
    text: `${selected.includes(k) ? "✅" : "⬜"} ${MEALS_FA[k]}`,
    callback_data: `meal:${k}`,
  }));
  return { inline_keyboard: [row, [{ text: "✅ تأیید", callback_data: "meals_done" }]] };
}

const FOOD_MENU = {
  inline_keyboard: [
    [{ text: "🥇 اولین غذای موجود", callback_data: "food:first" }],
    [{ text: "💰 ارزان‌ترین غذا", callback_data: "food:cheapest" }],
    [{ text: "✏️ نام غذای خاص", callback_data: "food:custom" }],
  ],
};

const RESERVE_MENU = {
  inline_keyboard: [
    [{ text: "▶️ رزرو واقعی", callback_data: "do:real" }],
    [{ text: "🧪 تست (بدون رزرو واقعی)", callback_data: "do:dry" }],
  ],
};

/* ==================== Account & state ==================== */
async function getOrCreateAccount(tgId: string, chatId: number, firstName: string) {
  let [user] = await db.select().from(users).where(eq(users.telegramId, tgId));
  if (!user) {
    const created = await db
      .insert(users)
      .values({
        email: `tg${tgId}@telegram.local`,
        name: firstName || "کاربر تلگرام",
        passwordHash: hashPassword(randomBytes(16).toString("hex")),
        telegramId: tgId,
      })
      .returning();
    user = created[0];
  }
  let [profile] = await db.select().from(profiles).where(eq(profiles.userId, user.id));
  if (!profile) {
    const created = await db
      .insert(profiles)
      .values({ userId: user.id, username: "", telegramChatId: String(chatId) })
      .returning();
    profile = created[0];
  } else if (!profile.telegramChatId) {
    await db.update(profiles).set({ telegramChatId: String(chatId) }).where(eq(profiles.id, profile.id));
    profile = { ...profile, telegramChatId: String(chatId) };
  }
  return { user, profile };
}

async function getOrCreatePlan(profileId: number) {
  let [plan] = await db.select().from(plans).where(eq(plans.profileId, profileId));
  if (!plan) {
    const created = await db
      .insert(plans)
      .values({ profileId, name: "قانون اصلی" })
      .returning();
    plan = created[0];
  }
  return plan;
}

type BotStateRow = { state: string; data: Record<string, unknown> };

async function getState(tgId: string): Promise<BotStateRow> {
  const [s] = await db.select().from(telegramStates).where(eq(telegramStates.telegramId, tgId));
  if (!s) return { state: "idle", data: {} };
  return { state: s.state, data: (s.data as Record<string, unknown>) || {} };
}

async function setState(tgId: string, userId: number, state: string, data: Record<string, unknown> = {}) {
  await db
    .insert(telegramStates)
    .values({ telegramId: tgId, userId, state, data })
    .onConflictDoUpdate({
      target: telegramStates.telegramId,
      set: { state, data, updatedAt: new Date() },
    });
}

function fmtDays(days: number[]): string {
  if (!days.length) return "—";
  return [...days].sort((a, b) => a - b).map((d) => DAYS_FA[d]).join("، ");
}

function fmtMeals(meals: string[]): string {
  if (!meals.length) return "—";
  return meals.map((m) => MEALS_FA[m] || m).join("، ");
}

function fmtFood(plan: { foodPreference: string }): string {
  if (plan.foodPreference === "first") return "اولین غذای موجود";
  if (plan.foodPreference === "cheapest") return "ارزان‌ترین";
  return `خاص: ${plan.foodPreference}`;
}

function fmtTime(h: number, m: number): string {
  return `${h}:${String(m).padStart(2, "0")}`;
}

async function planSummary(planId: number): Promise<string> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) return "تنظیم نشده";
  return (
    `📅 روزها: ${fmtDays((plan.weekdays as number[]) || [])}\n` +
    `🍽️ وعده‌ها: ${fmtMeals((plan.meals as string[]) || [])}\n` +
    `🥘 غذا: ${esc(fmtFood(plan))}\n` +
    `⏰ ساعت اجرا: ${fmtTime(plan.runAtHour, plan.runAtMinute)}`
  );
}

/* ==================== Flows ==================== */
async function startFlow(chatId: number, tgId: string, firstName: string) {
  const { profile } = await getOrCreateAccount(tgId, chatId, firstName);
  const [user] = await db.select().from(users).where(eq(users.telegramId, tgId));
  await setState(tgId, user.id, "idle", {});
  const hasCreds = !!profile.username;
  await tgSend(
    chatId,
    `👋 سلام <b>${esc(firstName)}</b>!\n\n` +
      `به ربات رزرو خودکار غذای سلف خوش اومدی 🍽️\n\n` +
      `اینجا می‌تونی حساب سامانه سلف دانشگاهت رو وصل کنی و قانون رزرو بچینی تا هر روز خودش برات رزرو کنه.\n\n` +
      (hasCreds
        ? `حساب سلف وصله ✅ از منوی زیر انتخاب کن 👇`
        : `برای شروع، دکمه «🍽️ حساب سلف» رو بزن 👇`),
    { reply_markup: MAIN_MENU }
  );
}

async function accountFlow(chatId: number, tgId: string, userId: number, profileId: number) {
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));
  const masked = profile?.username ? ` (فعلی: <code>${esc(profile.username.slice(0, 3))}***</code>)` : "";
  await setState(tgId, userId, "await_student_id", { profileId });
  await tgSend(chatId, `🎓 شماره دانشجوییت رو بفرست:${masked}`, { reply_markup: { remove_keyboard: true } });
}

async function testConnection(chatId: number, profileId: number) {
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));
  if (!profile || !profile.username) {
    await tgSend(chatId, `اول «🍽️ حساب سلف» رو تنظیم کن 👆`, { reply_markup: MAIN_MENU });
    return;
  }
  const waitMsg = await tgSend(chatId, `🧪 در حال تست اتصال به سامانه سلف...`);
  const probe = await probeProfile(profile);
  const status = probe.reachable
    ? `✅ سایت در دسترسه (کد ${probe.status})`
    : `❌ سایت در دسترس نیست${probe.error ? `\nعلت: <code>${esc(probe.error)}</code>` : ""}\n\n💡 سرور ما خارج از ایرانه و سایت دانشگاه آیپی خارجی رو محدود کرده. داریم راه‌حلش رو پیدا می‌کنیم.`;
  try {
    await tgApi("editMessageText", {
      chat_id: chatId,
      message_id: waitMsg?.result?.message_id,
      text: status,
      parse_mode: "HTML",
    });
  } catch {
    await tgSend(chatId, status);
  }
  await tgSend(chatId, `منوی اصلی 👇`, { reply_markup: MAIN_MENU });
}

async function statusFlow(chatId: number, profileId: number) {
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));
  if (!profile) return;
  const plan = await getOrCreatePlan(profileId);
  const [lastRun] = await db.select().from(runs).where(eq(runs.profileId, profileId)).orderBy(desc(runs.id)).limit(1);
  const lines = [
    `📊 <b>وضعیت تو</b>`,
    ``,
    `🎓 شماره دانشجویی: ${profile.username ? `<code>${esc(profile.username)}</code>` : "تنظیم نشده"}`,
    `🍽️ حساب سلف: ${profile.username ? "✅" : "❌"}`,
    `📋 قانون رزرو: ${plan.active ? "✅ فعال" : "⏸️ غیرفعال"}`,
    await planSummary(plan.id),
    ``,
    `🕐 آخرین اجرا: ${lastRun ? `${lastRun.status} (${lastRun.booked} رزرو)` : "—"}`,
    `⏭️ اجرای بعدی: ${plan.nextRunAt ? new Date(plan.nextRunAt).toLocaleString("fa-IR") : "—"}`,
  ];
  await tgSend(chatId, lines.join("\n"), { reply_markup: MAIN_MENU });
}

async function manualReserve(chatId: number, profileId: number) {
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));
  if (!profile?.username) {
    await tgSend(chatId, `اول «🍽️ حساب سلف» رو تنظیم کن 👆`, { reply_markup: MAIN_MENU });
    return;
  }
  await tgSend(chatId, `رزرو دستی — واقعی انجام بشه یا فقط تست؟`, { reply_markup: RESERVE_MENU });
}

async function doReserve(chatId: number, profileId: number, dryRun: boolean) {
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));
  const plan = await getOrCreatePlan(profileId);
  if (!profile) return;
  await tgSend(chatId, dryRun ? `🧪 تست شروع شد...` : `▶️ رزرو شروع شد...`);
  try {
    const result = await executePlan({ profile, plan, trigger: "manual", options: { dryRun } });
    const icon = result.status === "success" ? "✅" : result.status === "partial" ? "⚠️" : "❌";
    await tgSend(
      chatId,
      `${icon} <b>نتیجه ${dryRun ? "تست" : "رزرو"}</b>\n\n` +
        `📝 ${esc(result.message)}\n` +
        `✅ موفق: ${result.booked} | ⏭️ رد شده: ${result.skipped} | ❌ ناموفق: ${result.failed}` +
        (result.simulated ? `\n\n💡 <i>حالت شبیه‌سازی (سایت در دسترس نبود)</i>` : ""),
      { reply_markup: MAIN_MENU }
    );
  } catch (e) {
    await tgSend(chatId, `❌ خطا: <code>${esc(e instanceof Error ? e.message : String(e))}</code>`, {
      reply_markup: MAIN_MENU,
    });
  }
}

/* ==================== Plan setup ==================== */
async function planFlow(chatId: number, tgId: string, userId: number, profileId: number) {
  const plan = await getOrCreatePlan(profileId);
  await setState(tgId, userId, "plan_days", {
    profileId,
    planId: plan.id,
    days: (plan.weekdays as number[]) || [0, 1, 2, 3, 4],
  });
  const st = await getState(tgId);
  await tgSend(chatId, `📅 روزهای هفته برای رزرو رو انتخاب کن:\n(بزن تا فعال/غیرفعال بشه، آخرش ✅ تأیید)`, {
    reply_markup: dayKeyboard(st.data.days as number[]),
  });
}

/* ==================== Message handler ==================== */
export async function handleMessage(msg: TgMessage) {
  const chatId = msg.chat?.id;
  const tgId = String(msg.from?.id);
  const firstName = msg.from?.first_name || "";
  const text = (msg.text || "").trim();
  if (!chatId || !tgId) return;

  const { user, profile } = await getOrCreateAccount(tgId, chatId, firstName);
  const st = await getState(tgId);

  // دستورات اصلی
  if (text === "/start" || text === "شروع") {
    await startFlow(chatId, tgId, firstName);
    return;
  }
  if (text === "🍽️ حساب سلف") {
    await accountFlow(chatId, tgId, user.id, profile.id);
    return;
  }
  if (text === "📋 قانون رزرو") {
    await planFlow(chatId, tgId, user.id, profile.id);
    return;
  }
  if (text === "🧪 تست اتصال") {
    await testConnection(chatId, profile.id);
    return;
  }
  if (text === "▶️ رزرو دستی") {
    await manualReserve(chatId, profile.id);
    return;
  }
  if (text === "📊 وضعیت من") {
    await statusFlow(chatId, profile.id);
    return;
  }

  // وضعیت‌های مکالمه
  if (st.state === "await_student_id") {
    const studentId = faDigits(text).replace(/\s+/g, "");
    if (!studentId) {
      await tgSend(chatId, `شماره دانشجویی معتبر نیست، دوباره بفرست:`);
      return;
    }
    await db.update(profiles).set({ username: studentId }).where(eq(profiles.id, profile.id));
    await setState(tgId, user.id, "await_password", { profileId: profile.id });
    await tgSend(chatId, `🔑 حالا رمز سامانه سلف رو بفرست:\n⚠️ پیامت رو بعد از خوندن پاک می‌کنم.`);
    return;
  }

  if (st.state === "await_password") {
    const password = text;
    if (!password) {
      await tgSend(chatId, `رمز رو بفرست:`);
      return;
    }
    await db
      .update(profiles)
      .set({ passwordEnc: encryptSecret(password) })
      .where(eq(profiles.id, profile.id));
    await setState(tgId, user.id, "idle", {});
    try {
      await tgDelete(chatId, msg.message_id);
    } catch { /* ignore */ }
    await tgSend(chatId, `✅ حسابت ذخیره شد! در حال تست اتصال...`);
    await testConnection(chatId, profile.id);
    return;
  }

  if (st.state === "await_food_name") {
    const name = text.slice(0, 60);
    const planId = st.data.planId as number;
    await db.update(plans).set({ foodPreference: name }).where(eq(plans.id, planId));
    await setState(tgId, user.id, "await_time", { planId, profileId: profile.id });
    await tgSend(chatId, `⏰ ساعت اجرای روزانه رو بفرست (مثلاً <code>8:05</code>):`);
    return;
  }

  if (st.state === "await_time") {
    const m = faDigits(text).match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
    if (!m) {
      await tgSend(chatId, `قالب ساعت درست نیست. مثلاً <code>8:05</code> بفرست:`);
      return;
    }
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) {
      await tgSend(chatId, `ساعت نامعتبره. دوباره بفرست:`);
      return;
    }
    const planId = st.data.planId as number;
    await db.update(plans).set({ runAtHour: h, runAtMinute: min, active: true }).where(eq(plans.id, planId));
    await schedulePlan(planId);
    await setState(tgId, user.id, "idle", {});
    await tgSend(
      chatId,
      `✅ <b>قانون رزرو فعال شد!</b>\n\n${await planSummary(planId)}\n\n🤖 هر روز سر همین ساعت خودکار برات رزرو می‌کنم.`,
      { reply_markup: MAIN_MENU }
    );
    return;
  }

  // پیش‌فرض
  await tgSend(chatId, `از منوی زیر انتخاب کن 👇`, { reply_markup: MAIN_MENU });
}

/* ==================== Callback handler ==================== */
export async function handleCallback(cb: TgCallbackQuery) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const tgId = String(cb.from?.id);
  const data = cb.data || "";
  if (!chatId || !tgId) return;
  await tgAnswerCb(cb.id);

  const [user] = await db.select().from(users).where(eq(users.telegramId, tgId));
  if (!user) return;
  const st = await getState(tgId);
  const [action, param] = data.split(":");

  if (action === "day" && st.state === "plan_days") {
    const days = [...((st.data.days as number[]) || [])];
    const n = parseInt(param, 10);
    const i = days.indexOf(n);
    if (i >= 0) days.splice(i, 1);
    else days.push(n);
    await setState(tgId, user.id, "plan_days", { ...st.data, days });
    if (messageId) await tgEditMarkup(chatId, messageId, dayKeyboard(days));
    return;
  }

  if (data === "days_done" && st.state === "plan_days") {
    const days = (st.data.days as number[]) || [];
    const planId = st.data.planId as number;
    await db.update(plans).set({ weekdays: days }).where(eq(plans.id, planId));
    const plan = await getOrCreatePlan(st.data.profileId as number);
    await setState(tgId, user.id, "plan_meals", {
      ...st.data,
      meals: (plan.meals as string[]) || ["lunch"],
    });
    const nst = await getState(tgId);
    await tgApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `🍽️ وعده‌های غذایی رو انتخاب کن:`,
      parse_mode: "HTML",
      reply_markup: mealKeyboard(nst.data.meals as string[]),
    });
    return;
  }

  if (action === "meal" && st.state === "plan_meals") {
    const meals = [...((st.data.meals as string[]) || [])];
    const i = meals.indexOf(param);
    if (i >= 0) meals.splice(i, 1);
    else meals.push(param);
    await setState(tgId, user.id, "plan_meals", { ...st.data, meals });
    if (messageId) await tgEditMarkup(chatId, messageId, mealKeyboard(meals));
    return;
  }

  if (data === "meals_done" && st.state === "plan_meals") {
    const meals = (st.data.meals as string[]) || [];
    const planId = st.data.planId as number;
    await db.update(plans).set({ meals }).where(eq(plans.id, planId));
    await setState(tgId, user.id, "plan_food", st.data);
    await tgApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `🥘 غذات چطور انتخاب بشه؟`,
      parse_mode: "HTML",
      reply_markup: FOOD_MENU,
    });
    return;
  }

  if (action === "food" && st.state === "plan_food") {
    const planId = st.data.planId as number;
    if (param === "custom") {
      await setState(tgId, user.id, "await_food_name", st.data);
      await tgSend(chatId, `✏️ اسم غذای موردنظرت رو بفرست (مثلاً <code>چلوکباب</code>):`);
    } else {
      await db.update(plans).set({ foodPreference: param }).where(eq(plans.id, planId));
      await setState(tgId, user.id, "await_time", st.data);
      await tgSend(chatId, `⏰ ساعت اجرای روزانه رو بفرست (مثلاً <code>8:05</code>):`);
    }
    return;
  }

  if (action === "do") {
    const [profile] = await db.select().from(profiles).where(eq(profiles.userId, user.id));
    if (!profile) return;
    await doReserve(chatId, profile.id, param === "dry");
    return;
  }
}

/* ==================== Entry ==================== */
export async function handleTelegramUpdate(update: TgUpdate) {
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    }
  } catch (e) {
    console.error("telegram update error:", e);
  }
}
