import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { plans, profiles } from "@/db/schema";
import type { Plan } from "@/db/schema";
import { executePlan } from "@/lib/rums";

const pad = (n: number) => String(n).padStart(2, "0");

function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - date.getTime();
}

/** تبدیل زمان محلی (مثلاً تهران) به Date UTC */
export function zonedToUtc(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  let offset = tzOffsetMs(new Date(guess), timeZone);
  let ts = guess - offset;
  offset = tzOffsetMs(new Date(ts), timeZone);
  ts = guess - offset;
  return new Date(ts);
}

export function computeNextRun(
  plan: Pick<Plan, "runAtHour" | "runAtMinute">,
  timeZone = "Asia/Tehran",
  from: Date = new Date(),
): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(from);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const nowMinutes = get("hour") * 60 + get("minute");
  const targetMinutes = plan.runAtHour * 60 + plan.runAtMinute;

  let day = d;
  if (nowMinutes >= targetMinutes) {
    const base = new Date(Date.UTC(y, mo - 1, d));
    base.setUTCDate(base.getUTCDate() + 1);
    day = base.getUTCDate();
    return zonedToUtc(
      base.getUTCFullYear(),
      base.getUTCMonth() + 1,
      day,
      plan.runAtHour,
      plan.runAtMinute,
      timeZone,
    );
  }
  return zonedToUtc(y, mo, d, plan.runAtHour, plan.runAtMinute, timeZone);
}

export async function refreshNextRun(planId: number) {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) return null;
  const next = computeNextRun(plan);
  await db.update(plans).set({ nextRunAt: next }).where(eq(plans.id, planId));
  return next;
}

export type CronReport = {
  checked: number;
  executed: number;
  results: {
    planId: number;
    profileId: number;
    title: string;
    status: string;
    message: string;
    booked: number;
    failed: number;
    simulated: boolean;
  }[];
};

/**
 * همه‌ی قانون‌های سررسیدشده را اجرا می‌کند.
 * از مسیر /api/cron/run (یا cron خارجی) فراخوانی می‌شود.
 */
export async function runDuePlans(limit = 5): Promise<CronReport> {
  const due = await db
    .select({ plan: plans, profile: profiles })
    .from(plans)
    .innerJoin(profiles, eq(plans.profileId, profiles.id))
    .where(and(eq(plans.active, true), eq(profiles.active, true), lte(plans.nextRunAt, new Date())))
    .orderBy(asc(plans.nextRunAt))
    .limit(limit);

  const report: CronReport = { checked: due.length, executed: 0, results: [] };

  for (const row of due) {
    const result = await executePlan({ profile: row.profile, plan: row.plan, trigger: "cron" });
    report.executed += 1;
    report.results.push({
      planId: row.plan.id,
      profileId: row.profile.id,
      title: row.profile.title,
      status: result.status,
      message: result.message,
      booked: result.booked,
      failed: result.failed,
      simulated: result.simulated,
    });
  }

  const allPlans = await db.select().from(plans).where(eq(plans.active, true));
  for (const plan of allPlans) {
    const next = computeNextRun(plan);
    if (!plan.nextRunAt || plan.nextRunAt.getTime() !== next.getTime()) {
      await db.update(plans).set({ nextRunAt: next }).where(eq(plans.id, plan.id));
    }
  }

  return report;
}

/** تنظیم nextRunAt برای قانون‌های تازه‌ساخته‌شده */
export async function schedulePlan(planId: number) {
  const next = await refreshNextRun(planId);
  return next ? next.toISOString() : null;
}

export const formatIsoDateTime = (d: Date | null | undefined) =>
  d ? `${d.toISOString().slice(0, 16).replace("T", " ")}Z` : "—";

export const twoDigit = pad;
