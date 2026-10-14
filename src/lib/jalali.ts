/**
 * تبدیل تاریخ میلادی/شمسی + محاسبات مربوط به هفته (بدون وابستگی خارجی)
 * الگوریتم بر پایه‌ی jalaali-js (BSD) پیاده‌سازی شده است.
 */

const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394,
  2456, 3178,
];

const div = (a: number, b: number) => Math.trunc(a / b);
const mod = (a: number, b: number) => a - Math.trunc(a / b) * b;

function jalCal(jy: number): { leap: number; gy: number; march: number } {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jump = 0;
  if (jy < jp || jy >= BREAKS[bl - 1]) throw new Error(`سال شمسی نامعتبر: ${jy}`);
  for (let i = 1; i < bl; i += 1) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

export function jalaliToGregorian(jy: number, jm: number, jd: number) {
  const r = jalCal(jy);
  const jdn = g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
  return d2g(jdn);
}

export function gregorianToJalali(gy: number, gm: number, gd: number) {
  const jdn = g2d(gy, gm, gd);
  const gyy = d2g(jdn).gy;
  let jy = gyy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gyy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (jalCal(jy).leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

const p2 = (n: number) => String(n).padStart(2, "0");

export function isoToJalali(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const j = gregorianToJalali(y, m, d);
  return `${j.jy}/${p2(j.jm)}/${p2(j.jd)}`;
}

export function jalaliToIso(jalali: string): string {
  const parts = jalali
    .split(/[\/\-]/)
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length < 3) throw new Error(`تاریخ نامعتبر: ${jalali}`);
  const g = jalaliToGregorian(parts[0], parts[1], parts[2]);
  return `${g.gy}-${p2(g.gm)}-${p2(g.gd)}`;
}

/** تاریخ امروز به وقت تهران (یا منطقه دلخواه) به شکل YYYY-MM-DD */
export function todayIso(timeZone = "Asia/Tehran"): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

/** ساعت و دقیقه فعلی به وقت منطقه‌ی داده‌شده */
export function nowClock(timeZone = "Asia/Tehran"): { hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const [h, m] = fmt.format(new Date()).split(":").map(Number);
  return { hour: h, minute: m };
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}

export function isoToUtcDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * شماره‌ی روز هفته با مبنای ایرانی: 0=شنبه … 6=جمعه
 */
export function persianWeekday(iso: string): number {
  const jsDay = isoToUtcDate(iso).getUTCDay(); // 0=Sunday
  return (jsDay + 1) % 7;
}

export const WEEKDAY_NAMES = [
  "شنبه",
  "یکشنبه",
  "دوشنبه",
  "سه‌شنبه",
  "چهارشنبه",
  "پنجشنبه",
  "جمعه",
];

/** فاصله‌ی روز تا شنبه‌ی آینده (شروع هفته‌ی ایرانی) */
export function daysUntilSaturday(iso: string): number {
  const wd = persianWeekday(iso);
  return (7 - wd) % 7;
}

export function formatJalaliLong(iso: string): string {
  return `${WEEKDAY_NAMES[persianWeekday(iso)]} ${isoToJalali(iso)}`;
}
