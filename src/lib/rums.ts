import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { plans, profiles, reservations, runs, foodPreferences } from "@/db/schema";
import type { Plan, Profile } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import {
  addDaysIso,
  isoToJalali,
  jalaliToGregorian,
  persianWeekday,
  todayIso,
  WEEKDAY_NAMES,
} from "@/lib/jalali";
import { ProxyAgent } from "undici";

export type MealKey = "breakfast" | "lunch" | "dinner";

export const MEAL_LABEL: Record<MealKey, string> = {
  breakfast: "صبحانه",
  lunch: "ناهار",
  dinner: "شام",
};

export const MEAL_KEYS: MealKey[] = ["breakfast", "lunch", "dinner"];

export type FoodOption = {
  id: string;
  name: string;
  meal: MealKey;
  date: string; // YYYY-MM-DD میلادی
  price: number;
  available: boolean;
  selfName?: string;
};

export type Step = {
  at: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
  meta?: Record<string, unknown>;
};

export type EndpointTemplate = {
  method?: string;
  url: string;
  bodyType?: "json" | "form";
  /** مقادیر می‌توانند از {{username}} {{password}} {{date}} {{meal}} {{foodId}} استفاده کنند */
  fields?: Record<string, string>;
};

export type LearnedEndpoints = {
  login?: EndpointTemplate;
  menu?: EndpointTemplate;
  reserve?: EndpointTemplate;
};

export type EngineOptions = {
  dryRun?: boolean;
  forceSimulate?: boolean;
  timeoutMs?: number;
};

/** برای میزبان‌هایی که از سرور ما در دسترس نیستند، سریع‌تر جا بزنیم */
const DEFAULT_TIMEOUT = 8_000;

/** Iranian egress: when RUMS_PROXY is set (e.g. http://ip:port), all RumsHttp
 *  traffic goes through undici ProxyAgent (self.rums.ac.ir is unreachable
 *  from foreign IPs). */
const RUMS_PROXY = (process.env.RUMS_PROXY ?? "").trim();

/** Iranian relay: when RUMS_RELAY_URL and RUMS_RELAY_KEY are set, all RumsHttp
 *  traffic goes through the PHP relay on the Iranian hosting instead of direct.
 *  This solves the geoblock (self.rums.ac.ir unreachable from foreign IPs). */
const RUMS_RELAY_URL = (process.env.RUMS_RELAY_URL ?? "https://medicalcentre.ir/rums-proxy/relay.php").trim();
const RUMS_RELAY_KEY = (process.env.RUMS_RELAY_KEY ?? "ISXJ-W60yae_9aK9FE9yGQiPoisRX6R4XuXSNYUyVfg").trim();
let proxyAgent: ProxyAgent | null = null;
function getProxyDispatcher(): ProxyAgent | undefined {
  if (!RUMS_PROXY) return undefined;
  if (!proxyAgent) proxyAgent = new ProxyAgent(RUMS_PROXY);
  return proxyAgent;
}

/* ------------------------------------------------------------------ */
/* ابزارهای عمومی                                                      */
/* ------------------------------------------------------------------ */

export function normalizeBaseUrl(raw: string): string {
  let base = (raw || "").trim();
  if (!base) base = "https://self.rums.ac.ir";
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/+$/, "");
}

function resolveUrl(base: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

/** الگوهای پرکاربرد سامانه‌های خودخوری ایرانی (اتوماسیون ستاره و مشابه) */
export const CANDIDATE_PATHS = {
  login: [
    "/api/auth/login",
    "/api/login",
    "/Account/Login",
    "/identity/login",
    "/login",
    "/Home/Login",
  ],
  menu: [
    "/api/food/week",
    "/api/reserve/week",
    "/Reserve/Week",
    "/Self/Reserve",
    "/FoodReservation/Week",
    "/Nobat/Reserve",
  ],
  reserve: [
    "/api/reserve",
    "/Reserve/Add",
    "/Self/Reserve/Add",
    "/Nobat/Reserve/Add",
  ],
  captcha: ["/captcha", "/Captcha/Image", "/Home/Captcha", "/identity/captcha"],
};

/* ------------------------------------------------------------------ */
/* کلاینت HTTP با کوکی‌جار                                             */
/* ------------------------------------------------------------------ */

export class RumsHttp {
  readonly base: string;
  private jar = new Map<string, string>();
  readonly headers: Record<string, string>;
  lastError: string | null = null;
  reachable = false;

  constructor(base: string, opts: { cookie?: string | null; userAgent?: string } = {}) {
    this.base = normalizeBaseUrl(base);
    this.headers = {
      "user-agent":
        opts.userAgent ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      accept: "application/json, text/plain, text/html;q=0.9,*/*;q=0.8",
      "accept-language": "fa-IR,fa;q=0.9,en;q=0.8",
      "x-requested-with": "XMLHttpRequest",
    };
    if (opts.cookie) this.importCookieHeader(opts.cookie);
  }

  importCookieHeader(header: string) {
    header
      .split(/;\s*/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .forEach((chunk) => {
        const idx = chunk.indexOf("=");
        if (idx > 0) this.jar.set(chunk.slice(0, idx), chunk.slice(idx + 1));
      });
  }

  cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get cookieCount() {
    return this.jar.size;
  }

  private storeCookies(res: Response) {
    const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  /** Send request through the Iranian relay instead of direct */
  private async relayRequest(
    url: string,
    init: RequestInit = {},
    timeoutMs = DEFAULT_TIMEOUT,
  ): Promise<{ ok: boolean; status: number; text: string; url: string } | null> {
    // استخراج path از URL
    let path = url;
    try {
      const u = new URL(resolveUrl(this.base, url));
      path = u.pathname + u.search;
    } catch { /* use as-is */ }
    
    const method = (init.method ?? "GET").toUpperCase();
    let body: string | null = null;
    if (init.body) {
      body = typeof init.body === "string" ? init.body : String(init.body);
    }
    
    const headers: Record<string, string> = {};
    const h = init.headers as Record<string, string> | undefined;
    if (h) {
      for (const [k, v] of Object.entries(h)) {
        const kl = k.toLowerCase();
        if (["host", "content-length", "connection", "cookie"].includes(kl)) continue;
        headers[k] = String(v);
      }
    }
    
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(RUMS_RELAY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: RUMS_RELAY_KEY,
          method,
          path,
          body,
          headers,
          cookies: this.cookieHeader() || "",
        }),
        signal: controller.signal,
      });
      
      if (!res.ok) {
        this.lastError = `Relay HTTP ${res.status}`;
        return null;
      }
      
      const data = await res.json() as {
        ok: boolean; status: number; body: string;
        cookies?: string[]; error?: string;
      };
      
      if (!data.ok) {
        this.lastError = `Relay error: ${data.error}`;
        return null;
      }
      
      // ذخیره کوکی‌های جدید
      if (data.cookies) {
        for (const c of data.cookies) {
          // ساخت Response مصنوعی برای storeCookies
          const fakeHeaders = new Headers();
          fakeHeaders.append("set-cookie", c);
          this.storeCookies({ headers: fakeHeaders } as Response);
        }
      }
      
      this.reachable = true;
      this.lastError = null;
      const target = resolveUrl(this.base, url);
      return {
        ok: data.status >= 200 && data.status < 400,
        status: data.status,
        text: data.body ?? "",
        url: target,
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async request(
    url: string,
    init: RequestInit = {},
    timeoutMs = DEFAULT_TIMEOUT,
  ): Promise<{ ok: boolean; status: number; text: string; url: string } | null> {
    // اگر رله تنظیم شده، از اون استفاده کن
    if (RUMS_RELAY_URL && RUMS_RELAY_KEY) {
      return this.relayRequest(url, init, timeoutMs);
    }
    const target = resolveUrl(this.base, url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(target, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        ...(RUMS_PROXY ? { dispatcher: getProxyDispatcher() } : {}),
        headers: {
          ...this.headers,
          ...(this.cookieHeader() ? { cookie: this.cookieHeader() } : {}),
          ...((init.headers as Record<string, string>) ?? {}),
        },
      } as RequestInit & { dispatcher?: unknown });
      this.storeCookies(res);
      const text = await res.text().catch(() => "");
      this.reachable = true;
      this.lastError = null;
      return { ok: res.ok, status: res.status, text, url: target };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  json(body: unknown, method = "POST"): RequestInit {
    return {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  form(fields: Record<string, string>, method = "POST"): RequestInit {
    return {
      method,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    };
  }
}

/* ------------------------------------------------------------------ */
/* طھط´ط®غŒطµ/غŒط§ط¯ع¯غŒط±غŒ ظ…ط³غŒط±ظ‡ط§                                               */
/* ------------------------------------------------------------------ */

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}

function applyTemplate(ep: EndpointTemplate, vars: Record<string, string>): RequestInit {
  const method = (ep.method ?? "POST").toUpperCase();
  const fields: Record<string, string> = {};
  Object.entries(ep.fields ?? {}).forEach(([k, v]) => {
    fields[k] = renderTemplate(String(v), vars);
  });
  if (ep.bodyType === "json") {
    return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(fields) };
  }
  return {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

/** ط§ط³طھط®ط±ط§ط¬ ظپغŒظ„ط¯ظ‡ط§غŒ غŒع© ظپط±ظ… HTML (ظ†ط§ظ…/ط§ع©ط´ظ†/ظ…ظ‚ط¯ط§ط±ظ‡ط§غŒ ظ…ط®ظپغŒ) */
export function parseForms(html: string) {
  const forms: { action: string; method: string; fields: Record<string, string> }[] = [];
  const formRe = /<form\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = formRe.exec(html))) {
    const tag = match[0];
    const action = /action\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    const method = /method\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "get";
    const start = match.index;
    const end = html.indexOf("</form>", start);
    const inner = end > 0 ? html.slice(start, end) : "";
    const fields: Record<string, string> = {};
    const inputRe = /<input\b[^>]*>/gi;
    let input: RegExpExecArray | null;
    while ((input = inputRe.exec(inner))) {
      const t = input[0];
      const name = /name\s*=\s*["']([^"']+)["']/i.exec(t)?.[1];
      if (!name) continue;
      const type = (/type\s*=\s*["']([^"']+)["']/i.exec(t)?.[1] ?? "text").toLowerCase();
      if (type === "submit" || type === "button") continue;
      const value = /value\s*=\s*["']([^"']*)["']/i.exec(t)?.[1] ?? "";
      fields[name] = value;
    }
    forms.push({ action, method, fields });
  }
  return forms;
}


/* ------------------------------------------------------------------ */
/* ط¯ط§ط¯ظ‡â€ŒغŒ ظ†ظ…ظˆظ†ظ‡ ط¨ط±ط§غŒ ط­ط§ظ„طھ ط´ط¨غŒظ‡â€Œط³ط§ط²غŒ                                     */
/* ------------------------------------------------------------------ */

const SAMPLE_FOODS: Record<MealKey, { name: string; price: number }[]> = {
  breakfast: [
    { name: "املت گوشت", price: 18000 },
    { name: "پنیر و گردو + نان بربری", price: 14000 },
    { name: "عدسی و نان", price: 15000 },
  ],
  lunch: [
    { name: "چلو کباب کوبیده", price: 65000 },
    { name: "قورمه سبزی با برنج", price: 58000 },
    { name: "ماکارونی با سویا", price: 52000 },
    { name: "خورش لوبیا سبز", price: 56000 },
  ],
  dinner: [
    { name: "کبوتر پلو ساده", price: 48000 },
    { name: "سوپ جو + نان", price: 38000 },
    { name: "کوکو سبزی", price: 44000 },
  ],
};

function seededRandom(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h % 1000) / 1000;
}

export function buildSimulatedMenu(base: string, days: string[], meals: MealKey[]): FoodOption[] {
  const out: FoodOption[] = [];
  days.forEach((date, dayIndex) => {
    meals.forEach((meal) => {
      const list = SAMPLE_FOODS[meal];
      const rnd = seededRandom(`${base}|${date}|${meal}`);
      const count = 1 + Math.floor(rnd * (list.length - 0.01));
      for (let i = 0; i < count; i += 1) {
        const food = list[(dayIndex + i * 2 + Math.floor(rnd * 3)) % list.length];
        out.push({
          id: `sim-${date}-${meal}-${i}`,
          name: food.name,
          meal,
          date,
          price: food.price + (i % 2) * 2000,
          available: rnd > 0.08 || i < count - 1,
          selfName: "ط³ظ„ظپ ظ…ط±ع©ط²غŒ",
        });
      }
    });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* ط§ظ†طھط®ط§ط¨ ط؛ط°ط§ ط¨ط± ط§ط³ط§ط³ طھط±ط¬غŒط­ ع©ط§ط±ط¨ط±                                      */
/* ------------------------------------------------------------------ */

export function pickFood(
  items: FoodOption[],
  plan: Pick<Plan, "foodPreference" | "maxPrice">,
): FoodOption | null {
  const pool = items.filter((i) => i.available);
  const withinBudget = plan.maxPrice > 0 ? pool.filter((i) => i.price <= plan.maxPrice) : pool;
  const candidates = withinBudget.length ? withinBudget : pool;
  if (!candidates.length) return null;
  const pref = (plan.foodPreference || "first").trim();

  if (pref === "cheapest") {
    return [...candidates].sort((a, b) => a.price - b.price)[0];
  }
  if (pref !== "first") {
    const wanted = candidates.find((c) => c.name.includes(pref));
    if (wanted) return wanted;
  }
  return candidates[0];
}

/* ------------------------------------------------------------------ */
/* ط§ط¹ظ„ط§ظ† طھظ„ع¯ط±ط§ظ…                                                        */
/* ------------------------------------------------------------------ */

export async function notifyTelegram(profile: Profile, text: string): Promise<void> {
  const token = profile.telegramToken ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = profile.telegramChatId;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* ط§ط¹ظ„ط§ظ† ط´ع©ط³طھطŒ ظ†ط¨ط§غŒط¯ ط±ظˆظ†ط¯ ط§طµظ„غŒ ط±ط§ ظ…طھظˆظ‚ظپ ع©ظ†ط¯ */
  }
}

export type EngineResult = {
  runId: number;
  status: "success" | "partial" | "failed";
  simulated: boolean;
  booked: number;
  skipped: number;
  failed: number;
  message: string;
  steps: Step[];
  items: FoodOption[];
};

type Logger = (level: Step["level"], message: string, meta?: Record<string, unknown>) => void;

function createLogger(bucket: Step[]): Logger {
  return (level, message, meta) => {
    bucket.push({ at: new Date().toISOString(), level, message, meta });
  };
}


/** طھظ„ط§ط´ ط¨ط±ط§غŒ ظˆط±ظˆط¯ ط¨ظ‡ ط³ط§ظ…ط§ظ†ظ‡ ظˆ ط¨ط§ط²ع¯ط±ط¯ط§ظ†ط¯ظ† ظˆط¶ط¹غŒطھ */
export async function probeProfile(profile: Profile) {
  const client = new RumsHttp(profile.baseUrl, {
    cookie: profile.sessionCookie,
    userAgent: profile.userAgent,
  });
  const res = await client.request("/", undefined, 9000);
  return {
    reachable: client.reachable,
    status: res?.status ?? 0,
    cookieCount: client.cookieCount,
    error: client.lastError,
    endpoint: res?.url ?? normalizeBaseUrl(profile.baseUrl),
  };
}

async function tryLogin(
  profile: Profile,
  client: RumsHttp,
  log: Logger,
): Promise<{ ok: boolean; simulated: boolean; detail: string }> {
  const password = decryptSecret(profile.passwordEnc);
  const settings = (profile.settings ?? {}) as { endpoints?: LearnedEndpoints };
  const learned = settings.endpoints?.login;

  if (learned?.url) {
    const res = await client.request(
      learned.url,
      applyTemplate(learned, { username: profile.username, password }),
    );
    if (!res) {
      return { ok: false, simulated: false, detail: `ط´ط¨ع©ظ‡ ط¯ط± ط¯ط³طھط±ط³ ظ†غŒط³طھ: ${client.lastError}` };
    }
    const ok = res.status >= 200 && res.status < 400;
    log(ok ? "success" : "warn", `ظˆط±ظˆط¯ ط¨ط§ endpoint غŒط§ط¯ع¯ط±ظپطھظ‡â€Œط´ط¯ظ‡ ط§ظ†ط¬ط§ظ… ط´ط¯ (ع©ط¯ ${res.status})`, {
      url: res.url,
    });
    return { ok, simulated: false, detail: `HTTP ${res.status}` };
  }

  for (const path of CANDIDATE_PATHS.login) {
    const res = await client.request(path, client.json({ username: profile.username, password }));
    if (!res) break; // ط´ط¨ع©ظ‡ ط§ط² ط¯ط³طھط±ط³ ط®ط§ط±ط¬ ط§ط³طھطŒ ط¨غŒâ€Œظپط§غŒط¯ظ‡ ط§ط³طھ ط§ط¯ط§ظ…ظ‡ ط¯ظ‡غŒظ…
    if (res.status === 200 || res.status === 302) {
      log("success", `ظˆط±ظˆط¯ ط§ط² ط·ط±غŒظ‚ ${path} ط¨ط§ ع©ط¯ ${res.status}`);
      return { ok: true, simulated: false, detail: `${path} â†’ ${res.status}` };
    }
  }

  const root = await client.request("/");
  const html = root?.text ?? "";
  const forms = parseForms(html);
  const loginForm = forms.find((f) =>
    Object.keys(f.fields).some((k) => /user|pass|login/i.test(k)),
  );
  if (loginForm) {
    const fields: Record<string, string> = { ...loginForm.fields };
    Object.keys(fields).forEach((key) => {
      if (/user(name)?|username|uid|code/i.test(key)) fields[key] = profile.username;
      if (/pass(word)?|pwd/i.test(key)) fields[key] = password;
    });
    const res = await client.request(loginForm.action || "/", client.form(fields));
    if (res && res.status < 400) {
      log("success", `ظˆط±ظˆط¯ ط¨ط§ ظپط±ظ… HTML ط§ط² ${loginForm.action || "/"} (ع©ط¯ ${res.status})`);
      return { ok: true, simulated: false, detail: `form â†’ ${res.status}` };
    }
  }

  return {
    ok: false,
    simulated: !client.reachable,
    detail: client.reachable
      ? "ظ‡غŒع† ظ…ط³غŒط± ظˆط±ظˆط¯غŒ ظ¾غŒط¯ط§ ظ†ط´ط¯ط› endpointظ‡ط§ ط±ط§ ط¨ط§ ط­ط§ظ„طھ learn طھظ†ط¸غŒظ… ع©ظ†غŒط¯"
      : `ظ…غŒط²ط¨ط§ظ† ط¯ط± ط¯ط³طھط±ط³ ظ†غŒط³طھ (${client.lastError ?? "timeout"})`,
  };
}


async function fetchMenuItems(
  profile: Profile,
  client: RumsHttp,
  days: string[],
  meals: MealKey[],
  log: Logger,
): Promise<{ items: FoodOption[]; simulated: boolean }> {
  const settings = (profile.settings ?? {}) as { endpoints?: LearnedEndpoints; selfName?: string };
  const menuEp = settings.endpoints?.menu;
  if (menuEp?.url) {
    const init =
      menuEp.method?.toUpperCase() === "POST"
        ? applyTemplate(menuEp, { from: days[0], to: days[days.length - 1] })
        : { method: "GET" };
    const res = await client.request(menuEp.url, init);
    if (res?.ok) {
      const parsed = parseMenuResponse(res.text, days, meals);
      if (parsed.length) {
        log("success", `${parsed.length} ع¯ط²غŒظ†ظ‡â€ŒغŒ ط؛ط°ط§غŒغŒ ط§ط² ط³ط§ظ…ط§ظ†ظ‡ ط®ظˆط§ظ†ط¯ظ‡ ط´ط¯`);
        return { items: parsed, simulated: false };
      }
      log("warn", "ظ¾ط§ط³ط® ظ…ظ†ظˆ ط¯ط±غŒط§ظپطھ ط´ط¯ ط§ظ…ط§ ط³ط§ط®طھط§ط± ط¢ظ† ظ‚ط§ط¨ظ„ طھط´ط®غŒطµ ظ†ط¨ظˆط¯");
    }
  }

  const items: FoodOption[] = [];
  for (const path of CANDIDATE_PATHS.menu) {
    const res = await client.request(`${path}?from=${days[0]}&to=${days[days.length - 1]}`);
    if (!res) break;
    if (res.ok) {
      const parsed = parseMenuResponse(res.text, days, meals);
      if (parsed.length) {
        log("success", `ظ…ظ†ظˆ ط§ط² ${path} ط®ظˆط§ظ†ط¯ظ‡ ط´ط¯ (${parsed.length} ع¯ط²غŒظ†ظ‡)`);
        items.push(...parsed);
        break;
      }
    }
  }
  if (items.length) return { items, simulated: false };

  log(
    "warn",
    client.reachable
      ? "ظ…ظ†ظˆغŒ ظˆط§ظ‚ط¹غŒ ظ‚ط§ط¨ظ„ ط®ظˆط§ظ†ط¯ظ† ظ†ط¨ظˆط¯ط› ط§ط¬ط±ط§غŒ ط´ط¨غŒظ‡â€Œط³ط§ط²غŒâ€Œط´ط¯ظ‡ ط¨ط±ط§غŒ ظ†ظ…ط§غŒط´ ط¬ط±غŒط§ظ† ع©ط§ط±"
      : "ظ…غŒط²ط¨ط§ظ† ط§ط² ط§غŒظ† ط³ط±ظˆط± ط¯ط± ط¯ط³طھط±ط³ ظ†غŒط³طھ (ط§ط­طھظ…ط§ظ„ط§ظ‹ ظپغŒظ„طھط± ط´ط¨ع©ظ‡â€ŒغŒ ط¯ط§ظ†ط´ع¯ط§ظ‡)ط› ط§ط¬ط±ط§غŒ ط´ط¨غŒظ‡â€Œط³ط§ط²غŒâ€Œط´ط¯ظ‡",
  );
  return { items: buildSimulatedMenu(normalizeBaseUrl(profile.baseUrl), days, meals), simulated: true };
}

/** طھط¨ط¯غŒظ„ ظ¾ط§ط³ط® JSON/HTML ط³ط§ظ…ط§ظ†ظ‡ ط¨ظ‡ ظ„غŒط³طھ ط؛ط°ط§ظ‡ط§غŒ ظ‚ط§ط¨ظ„ ط±ط²ط±ظˆ */
export function parseMenuResponse(
  body: string,
  days: string[],
  meals: MealKey[],
): FoodOption[] {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as unknown;
      const out: FoodOption[] = [];
      const walk = (node: unknown, date?: string, meal?: MealKey) => {
        if (Array.isArray(node)) {
          node.forEach((n) => walk(n, date, meal));
          return;
        }
        if (!node || typeof node !== "object") return;
        const rec = node as Record<string, unknown>;
        const dateKey = Object.keys(rec).find((k) => /date|day|tarikh/i.test(k));
        const mealKey = Object.keys(rec).find((k) => /meal|food_?type|vahed|nobat/i.test(k));
        const nameKey = Object.keys(rec).find((k) => /^(food_?name|name|title|meal_?name)$/i.test(k));
        const idKey = Object.keys(rec).find((k) => /^(id|food_?id|reserve_?id|meal_?id)$/i.test(k));
        const priceKey = Object.keys(rec).find((k) => /price|cost|amount|mablagh/i.test(k));
        const nextDate =
          date ??
          (dateKey && typeof rec[dateKey] === "string" ? String(rec[dateKey]).slice(0, 10) : undefined);
        const nextMeal =
          meal ??
          (mealKey && typeof rec[mealKey] === "string" ? normalizeMeal(String(rec[mealKey])) : undefined);
        if (nameKey && typeof rec[nameKey] === "string" && nextDate && nextMeal) {
          out.push({
            id: idKey ? String(rec[idKey]) : `${nextDate}-${nextMeal}-${out.length}`,
            name: String(rec[nameKey]),
            meal: nextMeal,
            date: normalizeDate(nextDate),
            price: priceKey ? Number(rec[priceKey]) || 0 : 0,
            available: true,
          });
          return;
        }
        Object.values(rec).forEach((v) => walk(v, nextDate, nextMeal));
      };
      walk(data);
      return out;
    } catch {
      return [];
    }
  }
  return parseMenuHtml(body, days, meals);
}


function normalizeMeal(value: string): MealKey {
  const v = value.trim().toLowerCase();
  if (/break|sobh|طµط¨ط­/.test(v)) return "breakfast";
  if (/din|sham|ط´ط§ظ…/.test(v)) return "dinner";
  return "lunch";
}

function normalizeDate(value: string): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(v)) {
    const [jy, jm, jd] = v.split("/").map(Number);
    const g = jalaliToGregorian(jy, jm, jd);
    return `${g.gy}-${String(g.gm).padStart(2, "0")}-${String(g.gd).padStart(2, "0")}`;
  }
  const parsed = new Date(v);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return v;
}

function parseMenuHtml(html: string, days: string[], meals: MealKey[]): FoodOption[] {
  const out: FoodOption[] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html))) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      c[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (cells.length < 2) continue;
    const date = cells.find((c) => /^\d{4}\/\d{2}\/\d{2}$/.test(c));
    const mealCell = cells.find((c) => /(طµط¨ط­ط§ظ†ظ‡|ظ†ط§ظ‡ط§ط±|ط´ط§ظ…)/.test(c));
    if (!date || !mealCell) continue;
    const meal = /طµط¨ط­ط§ظ†ظ‡/.test(mealCell)
      ? "breakfast"
      : /ط´ط§ظ…/.test(mealCell)
        ? "dinner"
        : "lunch";
    if (!meals.includes(meal as MealKey)) continue;
    const nameCell = cells.find((c) => c !== date && c !== mealCell && c.length > 2);
    if (!nameCell) continue;
    const iso = normalizeDate(date);
    if (!days.includes(iso)) continue;
    out.push({
      id: `${iso}-${meal}-${out.length}`,
      name: nameCell,
      meal: meal as MealKey,
      date: iso,
      price: 0,
      available: true,
    });
  }
  return out;
}

async function sendReservation(
  profile: Profile,
  client: RumsHttp,
  item: FoodOption,
  dryRun: boolean,
  log: Logger,
): Promise<{ status: "booked" | "already" | "failed"; detail: string }> {
  const settings = (profile.settings ?? {}) as { endpoints?: LearnedEndpoints };
  const ep = settings.endpoints?.reserve;
  const vars = {
    foodId: item.id,
    date: item.date,
    jalali: isoToJalali(item.date),
    meal: item.meal,
    username: profile.username,
  };
  if (ep?.url) {
    if (dryRun) return { status: "booked", detail: "dry-run (ط¨ط¯ظˆظ† ط§ط±ط³ط§ظ„ ظˆط§ظ‚ط¹غŒ)" };
    const res = await client.request(ep.url, applyTemplate(ep, vars));
    if (!res) return { status: "failed", detail: client.lastError ?? "ط®ط·ط§غŒ ط´ط¨ع©ظ‡" };
    const ok = res.status >= 200 && res.status < 300;
    log(ok ? "success" : "error", `ط«ط¨طھ ط±ط²ط±ظˆ ${item.name} â†’ ع©ط¯ ${res.status}`, { url: res.url });
    return { status: ok ? "booked" : "failed", detail: `HTTP ${res.status}` };
  }
  for (const path of CANDIDATE_PATHS.reserve) {
    const res = await client.request(
      path,
      client.json({ foodId: item.id, date: item.date, meal: item.meal }),
    );
    if (!res) return { status: "failed", detail: client.lastError ?? "ط®ط·ط§غŒ ط´ط¨ع©ظ‡" };
    if (res.status >= 200 && res.status < 300) {
      log("success", `ط±ط²ط±ظˆ ${item.name} ط§ط² ${path} ط«ط¨طھ ط´ط¯`);
      return { status: "booked", detail: `${path} â†’ ${res.status}` };
    }
    if (/already|طھع©ط±ط§ط±غŒ|ظ‚ط¨ظ„ط§/.test(res.text)) {
      return { status: "already", detail: "ظ‚ط¨ظ„ط§ظ‹ ط±ط²ط±ظˆ ط´ط¯ظ‡" };
    }
  }
  return { status: "failed", detail: "ظ‡غŒع† ظ…ط³غŒط± ط±ط²ط±ظˆ ظ¾ط§ط³ط® ظ…ظˆظپظ‚ ظ†ط¯ط§ط¯" };
}

/** ط§ط¬ط±ط§غŒ غŒع© ظ‚ط§ظ†ظˆظ† ط±ط²ط±ظˆ ط¨ط±ط§غŒ ظ¾ط±ظˆظپط§غŒظ„ ط¯ط§ط¯ظ‡â€Œط´ط¯ظ‡ */
export async function executePlan(params: {
  profile: Profile;
  plan?: Plan | null;
  trigger: "manual" | "cron";
  options?: EngineOptions;
}): Promise<EngineResult> {
  const { profile, plan, trigger } = params;
  const options = params.options ?? {};
  const steps: Step[] = [];
  const log = createLogger(steps);

  const meals: MealKey[] = (
    (plan?.meals?.length ? plan.meals : ["lunch"]) as string[]
  ).filter((m): m is MealKey => MEAL_KEYS.includes(m as MealKey));
  const weekdays = plan?.weekdays?.length ? plan.weekdays : [0, 1, 2, 3, 4];
  const lookAhead = plan?.lookAheadDays ?? 8;

  const today = todayIso(profile.timezone);
  const days: string[] = [];
  for (let i = 0; i < lookAhead; i += 1) {
    const date = addDaysIso(today, i);
    if (weekdays.includes(persianWeekday(date))) days.push(date);
  }
  if (!days.length) {
    for (let i = 0; i < lookAhead; i += 1) days.push(addDaysIso(today, i));
  }

  log(
    "info",
    `ط§ط¬ط±ط§غŒ ظ…ظˆطھظˆط± ط±ط²ط±ظˆ ط¨ط±ط§غŒ آ«${profile.title}آ» â€“ ${days.length} ط±ظˆط²طŒ ظˆط¹ط¯ظ‡â€Œظ‡ط§: ${meals
      .map((m) => MEAL_LABEL[m])
      .join("طŒ ")}`,
    { days, meals },
  );

  const client = new RumsHttp(profile.baseUrl, {
    cookie: profile.sessionCookie,
    userAgent: profile.userAgent,
  });

  await tryLogin(profile, client, log);
  const { items, simulated } = options.forceSimulate
    ? {
        items: buildSimulatedMenu(normalizeBaseUrl(profile.baseUrl), days, meals),
        simulated: true,
      }
    : await fetchMenuItems(profile, client, days, meals, log);

  const alreadyBooked = new Set(
    (
      await db
        .select({ serviceDate: reservations.serviceDate, meal: reservations.meal })
        .from(reservations)
        .where(and(eq(reservations.profileId, profile.id), eq(reservations.status, "booked")))
    ).map((r) => `${r.serviceDate}|${r.meal}`),
  );

  const [insertedRun] = await db
    .insert(runs)
    .values({
      profileId: profile.id,
      planId: plan?.id ?? null,
      trigger,
      status: "running",
      simulated,
      message: "ط¯ط± ط­ط§ظ„ ط§ط¬ط±ط§",
    })
    .returning({ id: runs.id });

  let booked = 0;
  let skipped = 0;
  let failed = 0;

  // ترجیحات غذایی دقیق کاربر (نسخه ۲)
  const prefs = await db.select().from(foodPreferences).where(eq(foodPreferences.profileId, profile.id));
  const prefMap = new Map(prefs.map(p => [`${p.dayOfWeek}|${p.meal}`, p]));

  const targets: FoodOption[] = [];
  for (const date of days) {
    const dayItems = items.filter((i) => i.date === date);
    const wd = persianWeekday(date);
    for (const meal of meals) {
      const key = `${date}|${meal}`;
      if (alreadyBooked.has(key)) {
        skipped += 1;
        log("info", `${isoToJalali(date)} – ${MEAL_LABEL[meal]}: قبلاً در این سامانه ثبت شده است`);
        continue;
      }
      // اول چک کن کاربر برای این روز/وعده غذای خاصی انتخاب کرده یا نه
      const pref = prefMap.get(`${wd}|${meal}`);
      let chosen: FoodOption | null = null;
      if (pref?.foodName) {
        // دنبال غذای انتخاب‌شده بگرد
        chosen = dayItems.find(i => i.meal === meal && (i.name === pref.foodName || i.id === pref.foodId)) || null;
        if (chosen) {
          log("info", `${isoToJalali(date)} – ${MEAL_LABEL[meal]}: غذای انتخابی کاربر: ${chosen.name}`);
        }
      }
      if (!chosen) {
        chosen = pickFood(dayItems.filter((i) => i.meal === meal), {
          foodPreference: plan?.foodPreference ?? "first",
          maxPrice: plan?.maxPrice ?? 0,
        });
      }
      if (!chosen) {
        failed += 1;
        log("warn", `${isoToJalali(date)} – ${MEAL_LABEL[meal]}: غذای مطابقی پیدا نشد`);
        continue;
      }
      targets.push(chosen);
    }
  }

  for (const item of targets) {
    const outcome = options.dryRun
      ? { status: "booked" as const, detail: "dry-run (ط¨ط¯ظˆظ† ط§ط±ط³ط§ظ„ ظˆط§ظ‚ط¹غŒ)" }
      : await sendReservation(profile, client, item, false, log);
    if (outcome.status === "booked") booked += 1;
    else if (outcome.status === "already") skipped += 1;
    else failed += 1;

    log(
      outcome.status === "failed" ? "error" : "success",
      `${isoToJalali(item.date)} â€“ ${MEAL_LABEL[item.meal]} â€“ ${item.name}: ${outcome.detail}`,
      { price: item.price },
    );

    await db.insert(reservations).values({
      profileId: profile.id,
      runId: insertedRun.id,
      serviceDate: item.date,
      jalaliDate: isoToJalali(item.date),
      weekday: persianWeekday(item.date),
      meal: item.meal,
      foodName: item.name,
      price: item.price,
      status: outcome.status,
      detail: outcome.detail,
    });
  }

  const status: EngineResult["status"] =
    booked > 0 && failed === 0 ? "success" : booked > 0 ? "partial" : failed > 0 ? "failed" : "success";
  const message = `${booked} ط±ط²ط±ظˆ ط«ط¨طھ ط´ط¯طŒ ${skipped} طھع©ط±ط§ط±غŒ/ط±ط¯â€Œط´ط¯ظ‡طŒ ${failed} ظ†ط§ظ…ظˆظپظ‚${
    simulated ? " (ط­ط§ظ„طھ ط´ط¨غŒظ‡â€Œط³ط§ط²غŒ)" : ""
  }`;

  await db
    .update(runs)
    .set({
      status,
      booked,
      skipped,
      failed,
      simulated,
      message,
      steps,
      finishedAt: new Date(),
    })
    .where(eq(runs.id, insertedRun.id));

  await db
    .update(profiles)
    .set({
      lastCheckAt: new Date(),
      lastCheckStatus: status,
      sessionCookie: client.cookieHeader() || profile.sessionCookie,
      updatedAt: new Date(),
    })
    .where(eq(profiles.id, profile.id));

  if (plan) {
    await db.update(plans).set({ lastRunAt: new Date() }).where(eq(plans.id, plan.id));
  }

  const summaryLines = steps
    .filter((s) => s.level === "success" || s.level === "error")
    .slice(-6)
    .map((s) => `â€¢ ${s.message}`);
  await notifyTelegram(
    profile,
    [
      `<b>ط³طھط§ط±ظ‡ ط®ظˆط¯ع©ط§ط±</b> â€“ ${profile.title}`,
      `ظˆط¶ط¹غŒطھ: ${status}`,
      message,
      ...summaryLines,
      `ظ‡ظپطھظ‡â€ŒغŒ ${WEEKDAY_NAMES[persianWeekday(days[0])]} طھط§ ${isoToJalali(days[days.length - 1])}`,
    ].join("\n"),
  );

  return { runId: insertedRun.id, status, simulated, booked, skipped, failed, message, steps, items };
}

/* ------------------------------------------------------------------ */
/* اطلاعات پروفایل و منوی هفتگی (نسخه ۲)                                */
/* ------------------------------------------------------------------ */

export type UserProfileInfo = {
  fullName: string;
  balance: number; // تومان
  studentId?: string;
};

/** بعد از لاگین موفق، نام و موجودی کاربر رو از سامانه می‌گیره */
export async function fetchUserProfileInfo(
  profile: Profile,
): Promise<UserProfileInfo | null> {
  const client = new RumsHttp(profile.baseUrl, {
    cookie: profile.sessionCookie,
    userAgent: profile.userAgent,
  });

  // اول لاگین کن
  const steps: Step[] = [];
  const log = createLogger(steps);
  const loginRes = await tryLogin(profile, client, log);
  if (!loginRes.ok && !client.reachable) return null;

  // سعی کن پروفایل رو از endpointهای رایج بگیری
  const profilePaths = [
    "/api/user/profile",
    "/api/profile",
    "/User/Profile",
    "/Account/Info",
    "/Home/UserInfo",
  ];

  for (const path of profilePaths) {
    const res = await client.request(path);
    if (!res?.ok) continue;
    try {
      const data = JSON.parse(res.text);
      // ساختارهای رایج
      const name =
        data.fullName || data.full_name || data.name || data.userName ||
        data.data?.fullName || data.data?.name || "";
      const balance =
        data.balance ?? data.credit ?? data.mojoodi ??
        data.data?.balance ?? data.data?.credit ?? 0;
      if (name || balance) {
        return {
          fullName: String(name || "دانشجو"),
          balance: Number(balance) || 0,
          studentId: data.studentId || data.student_id || data.code,
        };
      }
    } catch { /* JSON نبود، ادامه بده */ }
  }

  // اگه پیدا نشد، از روی کوکی/سشن حداقل نام کاربری رو برگردون
  return {
    fullName: profile.username,
    balance: 0,
  };
}

/** منوی هفتگی واقعی رو می‌گیره (با غذاهای هر روز) */
export async function fetchWeeklyMenu(
  profile: Profile,
  days: string[],
): Promise<FoodOption[]> {
  const client = new RumsHttp(profile.baseUrl, {
    cookie: profile.sessionCookie,
    userAgent: profile.userAgent,
  });

  const steps: Step[] = [];
  const log = createLogger(steps);
  await tryLogin(profile, client, log);

  const { items } = await fetchMenuItems(profile, client, days, MEAL_KEYS, log);
  return items;
}
