// src/lib/bot.ts — Telegram bot for rums-food-bot (نسخه ۲: با انتخاب غذای دقیق)
import { db } from "@/db";
import { users, profiles, plans, reservations, telegramStates, userInfo, foodPreferences, weeklyMenuCache } from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { encryptSecret, hashPassword } from "@/lib/crypto";
import { probeProfile, fetchUserProfileInfo, fetchWeeklyMenu, MEAL_LABEL, MEAL_KEYS, type MealKey } from "@/lib/rums";
// schedulePlan removed - not used in v2
import { randomBytes } from "crypto";
import { addDaysIso, todayIso, isoToJalali, persianWeekday } from "@/lib/jalali";

/* ==================== Telegram API ==================== */
export interface TgChat { id: number; }
export interface TgUser { id: number; first_name?: string; }
export interface TgMessage { message_id: number; chat?: TgChat; from?: TgUser; text?: string; }
export interface TgCallbackQuery { id: string; data?: string; from?: TgUser; message?: TgMessage; }
export interface TgUpdate { message?: TgMessage; callback_query?: TgCallbackQuery; }
export interface TgApiResponse { ok?: boolean; result?: { message_id?: number } & Record<string, unknown>; }

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
  } catch { return null; }
}

const tgSend = (chatId: number | string, text: string, extra: Record<string, unknown> = {}) =>
  tgApi("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
const tgAnswerCb = (id: string, text = "") => tgApi("answerCallbackQuery", { callback_query_id: id, text });

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ==================== منوها ==================== */
const MAIN_MENU = {
  keyboard: [
    [{ text: "👤 اتصال حساب" }, { text: "📋 اطلاعات من" }],
    [{ text: "🍽️ منوی هفته" }, { text: "⚙️ اتوماسیون" }],
    [{ text: "🧪 تست اتصال" }],
  ],
  resize_keyboard: true,
};

const DAYS_FA = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];

/* ==================== مدیریت حساب ==================== */
async function getOrCreateAccount(tgId: string, chatId: number, firstName: string) {
  let [user] = await db.select().from(users).where(eq(users.telegramId, tgId));
  if (!user) {
    const created = await db.insert(users).values({
      email: `tg${tgId}@telegram.local`,
      name: firstName || "کاربر تلگرام",
      passwordHash: hashPassword(randomBytes(16).toString("hex")),
      telegramId: tgId,
    }).returning();
    user = created[0];
  }
  let [profile] = await db.select().from(profiles).where(eq(profiles.userId, user.id));
  if (!profile) {
    const created = await db.insert(profiles).values({ userId: user.id, username: "", telegramChatId: String(chatId) }).returning();
    profile = created[0];
  } else if (!profile.telegramChatId) {
    await db.update(profiles).set({ telegramChatId: String(chatId) }).where(eq(profiles.id, profile.id));
    profile = { ...profile, telegramChatId: String(chatId) };
  }
  return { user, profile };
}

type BotStateRow = { state: string; data: Record<string, unknown> };
async function getState(tgId: string): Promise<BotStateRow> {
  const [s] = await db.select().from(telegramStates).where(eq(telegramStates.telegramId, tgId));
  if (!s) return { state: "idle", data: {} };
  return { state: s.state, data: (s.data as Record<string, unknown>) || {} };
}
async function setState(tgId: string, userId: number, state: string, data: Record<string, unknown> = {}) {
  await db.insert(telegramStates).values({ telegramId: tgId, userId, state, data })
    .onConflictDoUpdate({ target: telegramStates.telegramId, set: { state, data, updatedAt: new Date() } });
}

/* ==================== فلوی شروع ==================== */
async function startFlow(chatId: number, tgId: string, firstName: string) {
  const { user, profile } = await getOrCreateAccount(tgId, chatId, firstName);
  await setState(tgId, user.id, "idle", {});

  // اگه قبلاً لاگین کرده، اسم و موجودی رو نشون بده
  const [info] = await db.select().from(userInfo).where(eq(userInfo.profileId, profile.id));

  await tgSend(chatId,
    `👋 سلام <b>${esc(firstName)}</b>!\n\n` +
    `به ربات رزرو خودکار غذای سلف خوش اومدی 🍽️\n\n` +
    (info?.fullName
      ? `👤 ${esc(info.fullName)}\n💰 موجودی: <b>${(info.balance ?? 0).toLocaleString("fa-IR")}</b> تومان\n\n`
      : `هنوز حسابت رو وصل نکردی. دکمه «👤 اتصال حساب» رو بزن 👇\n\n`) +
    `از منوی زیر انتخاب کن:`,
    { reply_markup: MAIN_MENU });
}

/* ==================== فلوی اتصال حساب ==================== */
async function connectFlow(chatId: number, tgId: string, userId: number, profileId: number) {
  await setState(tgId, userId, "await_username", { profileId });
  await tgSend(chatId, `👤 <b>اتصال حساب سلف</b>\n\nنام کاربری سامانه سلف (شماره دانشجویی) رو بفرست:`,
    { reply_markup: { remove_keyboard: true } });
}

async function handleUsername(chatId: number, tgId: string, userId: number, data: Record<string, unknown>, text: string) {
  const username = text.trim();
  if (!username) { await tgSend(chatId, `نام کاربری نمی‌تونه خالی باشه. دوباره بفرست:`); return; }
  await setState(tgId, userId, "await_password", { ...data, username });
  await tgSend(chatId, `🔑 حالا رمز عبورت رو بفرست:\n\n<i>⚠️ رمزت با AES-256 رمزنگاری می‌شه و فقط برای ورود به سامانه سلف استفاده می‌شه.</i>`);
}

async function handlePassword(chatId: number, tgId: string, userId: number, data: Record<string, unknown>, text: string) {
  const password = text.trim();
  const profileId = data.profileId as number;
  const username = data.username as string;

  await tgSend(chatId, `⏳ دارم وصل می‌شم...`);

  // ذخیره موقت و تست لاگین
  await db.update(profiles).set({
    username,
    passwordEnc: encryptSecret(password),
    updatedAt: new Date(),
  }).where(eq(profiles.id, profileId));

  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));

  // گرفتن اطلاعات پروفایل (نام + موجودی)
  const info = await fetchUserProfileInfo(profile);

  if (info) {
    await db.insert(userInfo).values({
      profileId,
      fullName: info.fullName,
      balance: info.balance,
      studentId: info.studentId,
    }).onConflictDoUpdate({
      target: userInfo.profileId,
      set: { fullName: info.fullName, balance: info.balance, studentId: info.studentId, updatedAt: new Date() },
    });

    await setState(tgId, userId, "idle", {});
    await tgSend(chatId,
      `✅ <b>خوش اومدی ${esc(info.fullName)}!</b> 🎉\n\n` +
      `💰 موجودی حسابت: <b>${info.balance.toLocaleString("fa-IR")}</b> تومان\n\n` +
      `حالا می‌تونی:\n` +
      `🍽️ «منوی هفته» رو ببینی\n` +
      `⚙️ «اتوماسیون» رو تنظیم کنی تا خودش برات رزرو کنه`,
      { reply_markup: MAIN_MENU });
  } else {
    await setState(tgId, userId, "idle", {});
    await tgSend(chatId,
      `❌ <b>ورود ناموفق بود.</b>\n\n` +
      `نام کاربری یا رمز اشتباهه، یا سامانه سلف در دسترس نیست.\n` +
      `دوباره «👤 اتصال حساب» رو بزن.`,
      { reply_markup: MAIN_MENU });
  }
}

/* ==================== اطلاعات من ==================== */
async function myInfoFlow(chatId: number, profileId: number) {
  const [info] = await db.select().from(userInfo).where(eq(userInfo.profileId, profileId));
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));

  if (!info?.fullName) {
    await tgSend(chatId, `هنوز حسابت رو وصل نکردی. اول «👤 اتصال حساب» رو بزن.`, { reply_markup: MAIN_MENU });
    return;
  }

  // رزروهای اخیر
  const recent = await db.select().from(reservations)
    .where(eq(reservations.profileId, profileId))
    .orderBy(desc(reservations.serviceDate))
    .limit(7);

  let msg = `📋 <b>اطلاعات من</b>\n\n` +
    `👤 نام: <b>${esc(info.fullName)}</b>\n` +
    `💰 موجودی: <b>${(info.balance ?? 0).toLocaleString("fa-IR")}</b> تومان\n` +
    `🎓 شماره دانشجویی: <code>${esc(profile.username)}</code>\n\n`;

  if (recent.length) {
    msg += `📅 <b>رزروهای اخیر:</b>\n`;
    for (const r of recent) {
      const mealFa = MEAL_LABEL[r.meal as MealKey] || r.meal;
      msg += `• ${r.jalaliDate} - ${mealFa}: ${esc(r.foodName)} ${r.status === "booked" ? "✅" : "❌"}\n`;
    }
  } else {
    msg += `هنوز رزروی ثبت نشده.`;
  }

  await tgSend(chatId, msg, { reply_markup: MAIN_MENU });
}

/* ==================== منوی هفته ==================== */
async function weekMenuFlow(chatId: number, profileId: number) {
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));
  if (!profile.username) {
    await tgSend(chatId, `اول حسابت رو وصل کن: «👤 اتصال حساب»`, { reply_markup: MAIN_MENU });
    return;
  }

  await tgSend(chatId, `⏳ دارم منوی هفته رو می‌گیرم...`);

  const today = todayIso(profile.timezone);
  const days: string[] = [];
  for (let i = 0; i < 7; i++) days.push(addDaysIso(today, i));

  const items = await fetchWeeklyMenu(profile, days);

  if (!items.length) {
    await tgSend(chatId, `❌ نتونستم منو رو بگیرم. سامانه سلف در دسترس نیست.`, { reply_markup: MAIN_MENU });
    return;
  }

  // کش کردن منو
  const weekStart = days[0];
  await db.insert(weeklyMenuCache).values({ profileId, weekStart, menuData: items })
    .onConflictDoUpdate({ target: [weeklyMenuCache.profileId, weeklyMenuCache.weekStart], set: { menuData: items, cachedAt: new Date() } });

  // گروه‌بندی بر اساس روز
  let msg = `🍽️ <b>منوی هفته</b>\n\n`;
  for (const date of days) {
    const dayItems = items.filter(i => i.date === date);
    if (!dayItems.length) continue;
    const wd = persianWeekday(date);
    msg += `📅 <b>${DAYS_FA[wd]} ${isoToJalali(date)}</b>\n`;
    for (const meal of MEAL_KEYS) {
      const mealItems = dayItems.filter(i => i.meal === meal);
      if (!mealItems.length) continue;
      msg += `  ${MEAL_LABEL[meal]}:\n`;
      for (const item of mealItems.slice(0, 4)) {
        msg += `    • ${esc(item.name)}${item.price ? ` - ${item.price.toLocaleString("fa-IR")} ت` : ""}\n`;
      }
    }
    msg += `\n`;
  }

  await tgSend(chatId, msg, { reply_markup: MAIN_MENU });
}

/* ==================== اتوماسیون ==================== */
function automationMenu() {
  return {
    inline_keyboard: [
      [{ text: "📅 تنظیم غذای هر روز", callback_data: "auto:days" }],
      [{ text: "⏰ تنظیم ساعت اجرا", callback_data: "auto:time" }],
      [{ text: "📋 مشاهده تنظیمات فعلی", callback_data: "auto:view" }],
      [{ text: "🗑️ پاک کردن همه", callback_data: "auto:clear" }],
    ],
  };
}

function timePickerKeyboard() {
  const hours = [5, 6, 7, 8, 9, 10, 12, 14, 18, 20];
  const rows = [];
  for (let i = 0; i < hours.length; i += 3) {
    rows.push(hours.slice(i, i + 3).map(h => ({
      text: `⏰ ساعت ${h}`,
      callback_data: `autotime:${h}`,
    })));
  }
  return { inline_keyboard: rows };
}

async function automationFlow(chatId: number) {
  await tgSend(chatId,
    `⚙️ <b>اتوماسیون رزرو</b>\n\n` +
    `اینجا می‌تونی برای هر روز هفته و هر وعده، دقیقاً مشخص کنی کدوم غذا خودکار رزرو بشه.\n\n` +
    `مثلاً: «شنبه‌ها ناهار ماکارونی» یا «پنجشنبه‌ها ساعت ۶ شام کباب»`,
    { reply_markup: automationMenu() });
}

function dayPickerKeyboard() {
  const rows = [];
  for (let i = 0; i < 7; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, 7); j++) {
      row.push({ text: DAYS_FA[j], callback_data: `autoday:${j}` });
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function mealPickerKeyboard(day: number) {
  return {
    inline_keyboard: [
      MEAL_KEYS.map(k => ({ text: MEAL_LABEL[k], callback_data: `automeal:${day}:${k}` })),
    ],
  };
}

async function handleAutoDay(chatId: number, msgId: number, cbId: string, day: number) {
  await tgAnswerCb(cbId);
  await tgApi("editMessageText", {
    chat_id: chatId, message_id: msgId,
    text: `📅 <b>${DAYS_FA[day]}</b>\n\nکدوم وعده رو می‌خوای تنظیم کنی؟`,
    parse_mode: "HTML",
    reply_markup: mealPickerKeyboard(day),
  });
}

async function handleAutoMeal(chatId: number, msgId: number, cbId: string, day: number, meal: string, profileId: number) {
  await tgAnswerCb(cbId, "⏳ دارم غذاها رو می‌گیرم...");

  // گرفتن منو از کش یا سامانه
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));
  const today = todayIso(profile.timezone);

  // پیدا کردن تاریخی که همون روز هفته باشه
  let targetDate = "";
  for (let i = 0; i < 14; i++) {
    const d = addDaysIso(today, i);
    if (persianWeekday(d) === day) { targetDate = d; break; }
  }

  const items = await fetchWeeklyMenu(profile, [targetDate]);
  const mealItems = items.filter(i => i.meal === meal && i.date === targetDate);

  if (!mealItems.length) {
    await tgApi("editMessageText", {
      chat_id: chatId, message_id: msgId,
      text: `❌ برای ${DAYS_FA[day]} ${MEAL_LABEL[meal as MealKey]} غذایی پیدا نشد.\nممکنه منو هنوز منتشر نشده باشه.`,
      parse_mode: "HTML",
    });
    return;
  }

  // دکمه‌های انتخاب غذا
  const rows = mealItems.slice(0, 8).map((item, idx) => [{
    text: `${item.available ? "🟢" : "🔴"} ${item.name}${item.price ? ` (${item.price.toLocaleString("fa-IR")})` : ""}`,
    callback_data: `autofood:${day}:${meal}:${idx}`,
  }]);
  rows.push([{ text: "❌ هیچکدوم (رزرو نکن)", callback_data: `autofood:${day}:${meal}:none` }]);

  // ذخیره موقت لیست غذاها در state
  const [user] = await db.select().from(users).where(eq(users.id, profile.userId));
  if (user?.telegramId) {
    await setState(user.telegramId, user.id, "picking_food", { profileId, day, meal, foods: mealItems.map(f => ({ id: f.id, name: f.name })) });
  }

  await tgApi("editMessageText", {
    chat_id: chatId, message_id: msgId,
    text: `🍽️ <b>${DAYS_FA[day]} - ${MEAL_LABEL[meal as MealKey]}</b>\n\nکدوم غذا خودکار رزرو بشه؟`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

async function handleAutoFood(chatId: number, msgId: number, cbId: string, day: number, meal: string, foodIdx: string, tgId: string, userId: number) {
  const { data } = await getState(tgId);
  const profileId = data.profileId as number;
  const foods = data.foods as { id: string; name: string }[];

  await tgAnswerCb(cbId);

  if (foodIdx === "none") {
    await db.delete(foodPreferences).where(
      and(eq(foodPreferences.profileId, profileId), eq(foodPreferences.dayOfWeek, day), eq(foodPreferences.meal, meal))
    );
    await tgApi("editMessageText", {
      chat_id: chatId, message_id: msgId,
      text: `✅ برای <b>${DAYS_FA[day]} ${MEAL_LABEL[meal as MealKey]}</b> رزرو خودکار <b>غیرفعال</b> شد.`,
      parse_mode: "HTML",
    });
  } else {
    const food = foods[parseInt(foodIdx)];
    if (!food) {
      await tgApi("editMessageText", { chat_id: chatId, message_id: msgId, text: `❌ خطا. دوباره تلاش کن.`, parse_mode: "HTML" });
      return;
    }
    await db.insert(foodPreferences).values({ profileId, dayOfWeek: day, meal, foodName: food.name, foodId: food.id, autoReserve: true })
      .onConflictDoUpdate({
        target: [foodPreferences.profileId, foodPreferences.dayOfWeek, foodPreferences.meal],
        set: { foodName: food.name, foodId: food.id, autoReserve: true, updatedAt: new Date() },
      });
    // ساخت/آپدیت plan برای اسکجولر (تا هفتگی اجرا بشه)
    const existingPlans = await db.select().from(plans).where(eq(plans.profileId, profileId));
    if (!existingPlans.length) {
      const { computeNextRun } = await import("@/lib/scheduler");
      const newPlan = {
        profileId, name: "اتوماسیون بات",
        weekdays: [0,1,2,3,4,5,6], meals: ["breakfast","lunch","dinner"],
        foodPreference: "first", runAtHour: 6, runAtMinute: 0, active: true,
      };
      const nextRun = computeNextRun(newPlan, "Asia/Tehran");
      await db.insert(plans).values({ ...newPlan, nextRunAt: nextRun });
    }
    await tgApi("editMessageText", {
      chat_id: chatId, message_id: msgId,
      text: `✅ تنظیم شد!\n\n📅 ${DAYS_FA[day]}\n🍽️ ${MEAL_LABEL[meal as MealKey]}\n🥘 <b>${esc(food.name)}</b>\n\nهر هفته خودکار رزرو می‌شه 🎉`,
      parse_mode: "HTML",
    });
  }
  await setState(tgId, userId, "idle", {});
}

async function viewAutomation(chatId: number, msgId: number, cbId: string, profileId: number) {
  await tgAnswerCb(cbId);
  const prefs = await db.select().from(foodPreferences).where(eq(foodPreferences.profileId, profileId));

  if (!prefs.length) {
    await tgApi("editMessageText", {
      chat_id: chatId, message_id: msgId,
      text: `هنوز چیزی تنظیم نکردی.\n«📅 تنظیم غذای هر روز» رو بزن.`,
      parse_mode: "HTML",
      reply_markup: automationMenu(),
    });
    return;
  }

  let msg = `⚙️ <b>تنظیمات فعلی اتوماسیون:</b>\n\n`;
  const sorted = [...prefs].sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  for (const p of sorted) {
    msg += `📅 ${DAYS_FA[p.dayOfWeek]} - ${MEAL_LABEL[p.meal as MealKey]}: <b>${esc(p.foodName || "?")}</b>\n`;
  }

  await tgApi("editMessageText", { chat_id: chatId, message_id: msgId, text: msg, parse_mode: "HTML", reply_markup: automationMenu() });
}

/* ==================== تست اتصال ==================== */
async function testFlow(chatId: number, profileId: number) {
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, profileId));
  await tgSend(chatId, `⏳ دارم تست می‌کنم...`);
  const result = await probeProfile(profile);
  if (result.reachable) {
    await tgSend(chatId, `✅ <b>اتصال برقرار شد!</b>\n\nسامانه سلف در دسترسه.`, { reply_markup: MAIN_MENU });
  } else {
    await tgSend(chatId, `❌ <b>سایت در دسترس نیست</b>\nعلت: ${esc(result.error || "نامشخص")}`, { reply_markup: MAIN_MENU });
  }
}

/* ==================== هندلر اصلی ==================== */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  // پیام متنی
  const msg = update.message;
  if (msg?.text && msg.chat && msg.from) {
    const chatId = msg.chat.id;
    const tgId = String(msg.from.id);
    const text = msg.text.trim();
    const firstName = msg.from.first_name || "دوست";

    const { user, profile } = await getOrCreateAccount(tgId, chatId, firstName);
    const { state, data } = await getState(tgId);

    // دستورات اصلی منو
    if (text === "/start") { await startFlow(chatId, tgId, firstName); return; }
    if (text === "👤 اتصال حساب") { await connectFlow(chatId, tgId, user.id, profile.id); return; }
    if (text === "📋 اطلاعات من") { await myInfoFlow(chatId, profile.id); return; }
    if (text === "🍽️ منوی هفته") { await weekMenuFlow(chatId, profile.id); return; }
    if (text === "⚙️ اتوماسیون") { await automationFlow(chatId); return; }
    if (text === "🧪 تست اتصال") { await testFlow(chatId, profile.id); return; }

    // ماشین حالت
    if (state === "await_username") { await handleUsername(chatId, tgId, user.id, data, text); return; }
    if (state === "await_password") { await handlePassword(chatId, tgId, user.id, data, text); return; }

    // پیش‌فرض
    await tgSend(chatId, `از منوی زیر انتخاب کن 👇`, { reply_markup: MAIN_MENU });
    return;
  }

  // کال‌بک اینلاین
  const cb = update.callback_query;
  if (cb?.data && cb.message && cb.from) {
    const chatId = cb.message.chat?.id ?? 0;
    const msgId = cb.message.message_id;
    const tgId = String(cb.from.id);
    const [cbData, ...args] = cb.data.split(":");

    const { user, profile } = await getOrCreateAccount(tgId, chatId, cb.from.first_name || "");

    if (cbData === "auto" && args[0] === "days") {
      await tgAnswerCb(cb.id);
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: msgId,
        text: `📅 کدوم روز هفته رو می‌خوای تنظیم کنی؟`, parse_mode: "HTML",
        reply_markup: dayPickerKeyboard(),
      });
    } else if (cbData === "autoday") {
      await handleAutoDay(chatId, msgId, cb.id, parseInt(args[0]));
    } else if (cbData === "automeal") {
      await handleAutoMeal(chatId, msgId, cb.id, parseInt(args[0]), args[1], profile.id);
    } else if (cbData === "autofood") {
      await getState(tgId); // state not needed here
      await handleAutoFood(chatId, msgId, cb.id, parseInt(args[0]), args[1], args[2], tgId, user.id);
    } else if (cbData === "auto" && args[0] === "view") {
      await viewAutomation(chatId, msgId, cb.id, profile.id);
    } else if (cbData === "auto" && args[0] === "time") {
      await tgAnswerCb(cb.id);
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: msgId,
        text: `⏰ <b>ساعت اجرای روزانه رزرو خودکار</b>

هر روز چه ساعتی رزروها انجام بشه؟`,
        parse_mode: "HTML", reply_markup: timePickerKeyboard(),
      });
    } else if (cbData === "autotime") {
      const hour = parseInt(args[0]);
      await tgAnswerCb(cb.id, `✅ ساعت ${hour} تنظیم شد`);
      const existingPlans = await db.select().from(plans).where(eq(plans.profileId, profile.id));
      if (existingPlans.length) {
        const { computeNextRun } = await import("@/lib/scheduler");
        const plan = existingPlans[0];
        const nextRun = computeNextRun({ runAtHour: hour, runAtMinute: 0 }, "Asia/Tehran");
        await db.update(plans).set({ runAtHour: hour, runAtMinute: 0, nextRunAt: nextRun }).where(eq(plans.id, plan.id));
      }
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: msgId,
        text: `✅ ساعت اجرا تنظیم شد: <b>${hour}:00</b>

هر روز این ساعت رزرو خودکار انجام می‌شه.`,
        parse_mode: "HTML", reply_markup: automationMenu(),
      });
    } else if (cbData === "auto" && args[0] === "clear") {
      await tgAnswerCb(cb.id);
      await db.delete(foodPreferences).where(eq(foodPreferences.profileId, profile.id));
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: msgId,
        text: `🗑️ همه تنظیمات اتوماسیون پاک شد.`, parse_mode: "HTML", reply_markup: automationMenu(),
      });
    }
  }
}

// Alias برای سازگاری با webhook قدیمی
export { handleUpdate as handleTelegramUpdate };
