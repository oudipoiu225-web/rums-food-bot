import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * کاربران پنل (هر دانشجو یک حساب)
 */
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name").notNull().default(""),
    // هش رمز با scrypt (فرمت: salt:hash هر دو base64url)
    passwordHash: text("password_hash").notNull(),
    telegramId: text("telegram_id").unique(),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("users_email_idx").on(table.email)],
);

/**
 * وضعیت گفت‌وگوی تلگرام هر کاربر (ماشین حالت ربات)
 */
export const telegramStates = pgTable("telegram_states", {
  telegramId: text("telegram_id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("idle"),
  data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * نشست‌های ورود به پنل
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

/**
 * پروفایل حساب سامانه سلف دانشگاه (self.rums.ac.ir) برای هر کاربر پنل
 */
export const profiles = pgTable(
  "profiles",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("سامانه سلف رفسنجان"),
    baseUrl: text("base_url").notNull().default("https://self.rums.ac.ir"),
    username: text("username").notNull(),
    // رمز عبور سامانه دانشگاه با AES-256-GCM رمزنگاری می‌شود
    passwordEnc: text("password_enc").notNull().default(""),
    // session = استفاده از کوکی نشست | form = فرم بدون کد امنیتی | ocr = تشخیص خودکار
    captchaMode: text("captcha_mode").notNull().default("session"),
    sessionCookie: text("session_cookie"),
    userAgent: text("user_agent")
      .notNull()
      .default(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      ),
    timezone: text("timezone").notNull().default("Asia/Tehran"),
    telegramToken: text("telegram_token"),
    telegramChatId: text("telegram_chat_id"),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    active: boolean("active").notNull().default(true),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastCheckStatus: text("last_check_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("profiles_user_idx").on(table.userId, table.active)],
);

/**
 * قانون رزرو خودکار: کدام روزهای هفته، کدام وعده‌ها و با چه اولویتی
 */
export const plans = pgTable(
  "plans",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // 0 = شنبه ... 6 = جمعه
    weekdays: jsonb("weekdays").$type<number[]>().notNull().default([0, 1, 2, 3, 4]),
    meals: jsonb("meals").$type<string[]>().notNull().default(["lunch"]),
    // first = اولین غذای موجود | cheapest | نام غذای دلخواه
    foodPreference: text("food_preference").notNull().default("first"),
    maxPrice: integer("max_price").notNull().default(0),
    lookAheadDays: integer("look_ahead_days").notNull().default(8),
    runAtHour: integer("run_at_hour").notNull().default(8),
    runAtMinute: integer("run_at_minute").notNull().default(5),
    active: boolean("active").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("plans_profile_idx").on(table.profileId)],
);

/**
 * هر بار اجرای موتور رزرو
 */
export const runs = pgTable(
  "runs",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    planId: integer("plan_id").references(() => plans.id, { onDelete: "set null" }),
    trigger: text("trigger").notNull().default("manual"),
    // running | success | partial | failed
    status: text("status").notNull().default("running"),
    booked: integer("booked").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    simulated: boolean("simulated").notNull().default(false),
    message: text("message"),
    steps: jsonb("steps")
      .$type<{ at: string; level: string; message: string; meta?: Record<string, unknown> }[]>()
      .notNull()
      .default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("runs_profile_idx").on(table.profileId, table.startedAt)],
);

/**
 * رزروهای ثبت‌شده / شناسایی‌شده
 */
export const reservations = pgTable(
  "reservations",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    runId: integer("run_id").references(() => runs.id, { onDelete: "set null" }),
    serviceDate: text("service_date").notNull(), // YYYY-MM-DD میلادی
    jalaliDate: text("jalali_date").notNull(), // YYYY/MM/DD شمسی
    weekday: integer("weekday").notNull().default(0),
    meal: text("meal").notNull(),
    foodName: text("food_name").notNull().default(""),
    price: integer("price").notNull().default(0),
    // booked | already | failed | cancelled
    status: text("status").notNull().default("booked"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("reservations_profile_idx").on(table.profileId, table.serviceDate)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type Reservation = typeof reservations.$inferSelect;

/**
 * اطلاعات پروفایل کاربر از سامانه سلف (نام، موجودی) - بعد از لاگین پر می‌شه
 */
export const userInfo = pgTable(
  "user_info",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" })
      .unique(),
    fullName: text("full_name"),
    balance: integer("balance"), // موجودی به تومان
    studentId: text("student_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * ترجیحات غذایی دقیق: برای هر روز هفته و هر وعده، کدوم غذا
 * dayOfWeek: 0=شنبه، 1=یکشنبه، ... 6=جمعه
 */
export const foodPreferences = pgTable(
  "food_preferences",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    dayOfWeek: integer("day_of_week").notNull(),
    meal: text("meal").notNull(), // breakfast/lunch/dinner
    foodName: text("food_name"),
    foodId: text("food_id"),
    autoReserve: boolean("auto_reserve").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("food_prefs_profile_idx").on(table.profileId, table.dayOfWeek, table.meal).unique()],
);

/**
 * کش منوی هفتگی
 */
export const weeklyMenuCache = pgTable(
  "weekly_menu_cache",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    weekStart: text("week_start").notNull(), // YYYY-MM-DD شنبه
    menuData: jsonb("menu_data").$type<FoodOption[]>().notNull().default([]),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("menu_cache_idx").on(table.profileId, table.weekStart).unique()],
);

export type UserInfo = typeof userInfo.$inferSelect;
export type FoodPreference = typeof foodPreferences.$inferSelect;
export type WeeklyMenuCache = typeof weeklyMenuCache.$inferSelect;
