"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ProfileRow = {
  id: number;
  title: string;
  baseUrl: string;
  username: string;
  captchaMode: string;
  active: boolean;
  sessionCookie?: string | null;
  lastCheckAt: string | null;
  lastCheckStatus: string | null;
};

type PlanRow = {
  id: number;
  profileId: number;
  name: string;
  weekdays: number[];
  meals: string[];
  foodPreference: string;
  maxPrice: number;
  lookAheadDays: number;
  runAtHour: number;
  runAtMinute: number;
  active: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  profileTitle: string;
};

type StepRow = { at: string; level: string; message: string; meta?: Record<string, unknown> };
type RunRow = { id: number; profileId: number; trigger: string; status: string; booked: number; skipped: number; failed: number; simulated: boolean; message: string | null; steps: StepRow[]; startedAt: string; finishedAt: string | null };
type ReservationRow = { id: number; profileId: number; serviceDate: string; jalaliDate: string; weekday: number; meal: string; foodName: string; price: number; status: string; detail: string | null };

const WEEKDAYS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];
const MEALS: { key: string; label: string; icon: string }[] = [
  { key: "breakfast", label: "صبحانه", icon: "🌅" },
  { key: "lunch", label: "ناهار", icon: "🍛" },
  { key: "dinner", label: "شام", icon: "🌙" },
];

const fa = (v: string | number) => String(v).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
const MEAL_FA: Record<string, string> = { breakfast: "صبحانه", lunch: "ناهار", dinner: "شام" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error ?? `خطای ${res.status}`);
  return data;
}

const STATUS_STYLE: Record<string, string> = {
  success: "bg-emerald-500/15 text-emerald-300",
  partial: "bg-amber-500/15 text-amber-300",
  failed: "bg-rose-500/15 text-rose-300",
  running: "bg-sky-500/15 text-sky-300",
  booked: "bg-emerald-500/15 text-emerald-300",
  already: "bg-sky-500/15 text-sky-300",
  cancelled: "bg-slate-500/15 text-slate-300",
  reachable: "bg-emerald-500/15 text-emerald-300",
  unreachable: "bg-amber-500/15 text-amber-300",
};

const badge = (status: string) => `badge ${STATUS_STYLE[status] ?? "bg-slate-500/15 text-slate-300"}`;

const STATUS_FA: Record<string, string> = {
  success: "موفق",
  partial: "نیمه‌موفق",
  failed: "ناموفق",
  running: "در حال اجرا",
  booked: "ثبت شد",
  already: "تکراری",
  cancelled: "لغو شد",
  reachable: "در دسترس",
  unreachable: "دسترس‌ناپذیر",
};

const timeFa = (iso: string | null) => (iso ? fa(new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" })) : "—");
export default function Dashboard({ userName }: { userName: string }) {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [reservations, setReservations] = useState<ReservationRow[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [profile, setProfile] = useState({
    title: "سامانه سلف رفسنجان",
    baseUrl: "https://self.rums.ac.ir",
    username: "",
    password: "",
    captchaMode: "session",
    sessionCookie: "",
    telegramToken: "",
    telegramChatId: "",
  });

  const [plan, setPlan] = useState({
    profileId: 0,
    name: "ناهار هفته‌ی کاری",
    weekdays: [0, 1, 2, 3, 4] as number[],
    meals: ["lunch"] as string[],
    foodPreference: "first",
    maxPrice: 0,
    lookAheadDays: 8,
    runAtHour: 8,
    runAtMinute: 5,
  });

  const [runner, setRunner] = useState({ profileId: 0, planId: 0, dryRun: true });
  const [result, setResult] = useState<RunRow | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, pl, r] = await Promise.all([
        api<{ profiles: ProfileRow[] }>("/api/profiles"),
        api<{ plans: PlanRow[] }>("/api/plans"),
        api<{ runs: RunRow[]; reservations: ReservationRow[] }>("/api/runs"),
      ]);
      setProfiles(p.profiles);
      setPlans(pl.plans);
      setRuns(r.runs);
      setReservations(r.reservations);
      setRunner((prev) => ({ ...prev, profileId: prev.profileId || p.profiles[0]?.id || 0, planId: prev.planId || pl.plans[0]?.id || 0 }));
      setPlan((prev) => ({ ...prev, profileId: prev.profileId || p.profiles[0]?.id || 0 }));
    } catch (error) {
      setNotice({ kind: "err", text: error instanceof Error ? error.message : "خطا" });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const flash = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 6000);
  };

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    window.location.reload();
  };

  const saveProfile = async () => {
    setBusy("profile");
    try {
      await api("/api/profiles", { method: "POST", body: JSON.stringify(profile) });
      flash("ok", "حساب سامانه سلف ذخیره شد. حالا یک قانون رزرو بسازید.");
      setProfile((a) => ({ ...a, password: "", sessionCookie: "" }));
      await refresh();
    } catch (error) {
      flash("err", error instanceof Error ? error.message : "ذخیره نشد");
    } finally {
      setBusy(null);
    }
  };

  const testProfile = async (id: number) => {
    setBusy(`test-${id}`);
    try {
      const res = await api<{ reachable: boolean; status: number; verdict: string }>(`/api/profiles/${id}/test`, { method: "POST" });
      flash(res.reachable ? "ok" : "err", `${res.verdict} (HTTP ${fa(res.status || 0)})`);
      await refresh();
    } catch (error) {
      flash("err", error instanceof Error ? error.message : "تست ناموفق");
    } finally {
      setBusy(null);
    }
  };

  const removeProfile = async (id: number) => {
    setBusy(`del-${id}`);
    try {
      await api(`/api/profiles/${id}`, { method: "DELETE" });
      await refresh();
      flash("ok", "حساب حذف شد");
    } finally {
      setBusy(null);
    }
  };

  const savePlan = async () => {
    setBusy("plan");
    try {
      await api("/api/plans", { method: "POST", body: JSON.stringify(plan) });
      flash("ok", "قانون رزرو ذخیره شد و زمان‌بندی شد");
      await refresh();
    } catch (error) {
      flash("err", error instanceof Error ? error.message : "ذخیره نشد");
    } finally {
      setBusy(null);
    }
  };

  const togglePlanActive = async (row: PlanRow) => {
    await api(`/api/plans/${row.id}`, { method: "PATCH", body: JSON.stringify({ active: !row.active }) });
    await refresh();
  };

  const deletePlan = async (id: number) => {
    await api(`/api/plans/${id}`, { method: "DELETE" });
    await refresh();
  };

  const runNow = async () => {
    if (!runner.profileId) { flash("err", "اول یک حساب سلف بسازید"); return; }
    setBusy("run");
    try {
      const res = await api<{ ok: boolean; runId: number; status: string; message: string; steps: StepRow[] }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ profileId: runner.profileId, planId: runner.planId || undefined, dryRun: runner.dryRun }),
      });
      setResult({ id: res.runId, profileId: runner.profileId, trigger: "manual", status: res.status, booked: 0, skipped: 0, failed: 0, simulated: false, message: res.message, steps: res.steps ?? [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
      flash(res.status === "failed" ? "err" : "ok", res.message);
      await refresh();
    } catch (error) {
      flash("err", error instanceof Error ? error.message : "اجرا نشد");
    } finally {
      setBusy(null);
    }
  };

  const totals = useMemo(() => {
    const booked = reservations.filter((r) => r.status === "booked").length;
    return { booked, runs: runs.length, failed: runs.reduce((s, r) => s + r.failed, 0) };
  }, [reservations, runs]);

  const selectedPlan = plans.find((x) => x.id === runner.planId) ?? null;

  return (
    <div className="space-y-6">
      {/* هدر */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">پنل رزرو خودکار</h2>
          <p className="text-xs text-slate-400">سلام {userName} 👋 — همه چیز زیر نظر توئه.</p>
        </div>
        <button className="btn btn-ghost" onClick={logout}>خروج</button>
      </div>

      {notice && (
        <div className={`card px-4 py-3 text-sm ${notice.kind === "ok" ? "border-emerald-400/40 text-emerald-200" : "border-rose-400/40 text-rose-200"}`}>
          {notice.text}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "رزروهای ثبت‌شده", value: fa(totals.booked), icon: "✅" },
          { label: "اجرای موتور", value: fa(totals.runs), icon: "⚙️" },
          { label: "خطاها", value: fa(totals.failed), icon: "⚠️" },
        ].map((stat) => (
          <div key={stat.label} className="card flex items-center gap-3 px-4 py-3">
            <span className="text-2xl">{stat.icon}</span>
            <div>
              <div className="text-xl font-bold text-white">{stat.value}</div>
              <div className="text-xs text-slate-400">{stat.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* حساب سامانه سلف */}
      <section className="card p-5">
        <header className="mb-4">
          <h3 className="text-lg font-bold text-white">۱) حساب سامانه سلف</h3>
          <p className="text-xs text-slate-400">شماره دانشجویی و رمز سامانه self.rums.ac.ir. رمز با AES-256-GCM رمزنگاری می‌شود.</p>
        </header>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">عنوان</label>
            <input className="field" value={profile.title} onChange={(e) => setProfile({ ...profile, title: e.target.value })} />
          </div>
          <div>
            <label className="label">آدرس سامانه</label>
            <input className="field" dir="ltr" value={profile.baseUrl} onChange={(e) => setProfile({ ...profile, baseUrl: e.target.value })} />
          </div>
          <div>
            <label className="label">نام کاربری (شماره دانشجویی)</label>
            <input className="field" dir="ltr" value={profile.username} onChange={(e) => setProfile({ ...profile, username: e.target.value })} />
          </div>
          <div>
            <label className="label">رمز عبور سامانه سلف</label>
            <input className="field" dir="ltr" type="password" value={profile.password} onChange={(e) => setProfile({ ...profile, password: e.target.value })} />
          </div>
          <div>
            <label className="label">روش ورود</label>
            <select className="field" value={profile.captchaMode} onChange={(e) => setProfile({ ...profile, captchaMode: e.target.value })}>
              <option value="session">کوکی نشست</option>
              <option value="form">فرم بدون کد امنیتی</option>
              <option value="ocr">تشخیص خودکار کد امنیتی</option>
            </select>
          </div>
          <div>
            <label className="label">کوکی نشست (اختیاری)</label>
            <input className="field" dir="ltr" value={profile.sessionCookie} onChange={(e) => setProfile({ ...profile, sessionCookie: e.target.value })} placeholder="ASP.NET_SessionId=..." />
          </div>
        </div>

        <details className="mt-3 text-xs text-slate-400">
          <summary className="cursor-pointer select-none text-slate-300">اعلان تلگرام (اختیاری)</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <label className="label">Bot Token</label>
              <input className="field" dir="ltr" value={profile.telegramToken} onChange={(e) => setProfile({ ...profile, telegramToken: e.target.value })} />
            </div>
            <div>
              <label className="label">Chat ID</label>
              <input className="field" dir="ltr" value={profile.telegramChatId} onChange={(e) => setProfile({ ...profile, telegramChatId: e.target.value })} />
            </div>
          </div>
        </details>

        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={saveProfile} disabled={busy === "profile"}>
            {busy === "profile" ? "در حال ذخیره…" : "ذخیره حساب سلف"}
          </button>
        </div>

        {profiles.length > 0 && (
          <div className="mt-5 overflow-x-auto">
            <table className="data">
              <thead>
                <tr><th>عنوان</th><th>آدرس</th><th>کاربری</th><th>ورود</th><th>وضعیت</th><th>آخرین بررسی</th><th /></tr>
              </thead>
              <tbody>
                {profiles.map((row) => (
                  <tr key={row.id}>
                    <td className="font-semibold text-white">{row.title}</td>
                    <td dir="ltr" className="text-xs text-slate-400">{row.baseUrl}</td>
                    <td dir="ltr" className="text-xs">{row.username}</td>
                    <td>
                      <span className="badge bg-slate-500/15 text-slate-300">{row.captchaMode === "session" ? "کوکی" : row.captchaMode === "ocr" ? "OCR" : "فرم"}</span>
                    </td>
                    <td>
                      <span className={badge(row.lastCheckStatus ?? "")}>{row.lastCheckStatus ? STATUS_FA[row.lastCheckStatus] ?? row.lastCheckStatus : "تست نشده"}</span>
                    </td>
                    <td className="text-xs text-slate-400">{timeFa(row.lastCheckAt)}</td>
                    <td>
                      <div className="flex gap-1">
                        <button className="chip" data-on="true" onClick={() => testProfile(row.id)} disabled={busy === `test-${row.id}`}>تست اتصال</button>
                        <button className="chip" onClick={() => removeProfile(row.id)}>حذف</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* قانون رزرو */}
      <section className="card p-5">
        <header className="mb-4">
          <h3 className="text-lg font-bold text-white">۲) قانون رزرو خودکار</h3>
          <p className="text-xs text-slate-400">موتور هر روز سر ساعت مشخص، روزهای بازه‌ی پیش‌رو را بررسی و وعده‌های تکراری را رزرو نمی‌کند.</p>
        </header>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">پروفایل</label>
            <select className="field" value={plan.profileId || ""} onChange={(e) => setPlan({ ...plan, profileId: Number(e.target.value) })}>
              <option value="">انتخاب کنید…</option>
              {profiles.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </div>
          <div>
            <label className="label">نام قانون</label>
            <input className="field" value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} />
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <span className="label">روزهای هفته</span>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((day, index) => (
                <span key={day} className="chip" data-on={plan.weekdays.includes(index)} onClick={() => setPlan({ ...plan, weekdays: plan.weekdays.includes(index) ? plan.weekdays.filter((d) => d !== index) : [...plan.weekdays, index].sort() })}>
                  {day}
                </span>
              ))}
            </div>
          </div>
          <div>
            <span className="label">وعده‌ها</span>
            <div className="flex flex-wrap gap-1.5">
              {MEALS.map((m) => (
                <span key={m.key} className="chip" data-on={plan.meals.includes(m.key)} onClick={() => setPlan({ ...plan, meals: plan.meals.includes(m.key) ? plan.meals.filter((x) => x !== m.key) : [...plan.meals, m.key] })}>
                  {m.icon} {m.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <div className="md:col-span-2">
            <label className="label">اولویت غذا</label>
            <select className="field" value={plan.foodPreference} onChange={(e) => setPlan({ ...plan, foodPreference: e.target.value })}>
              <option value="first">اولین غذای موجود</option>
              <option value="cheapest">ارزان‌ترین</option>
              <option value="کباب">غذایی که «کباب» دارد</option>
              <option value="برنج">غذایی که «برنج» دارد</option>
            </select>
          </div>
          <div>
            <label className="label">سقف قیمت (تومان)</label>
            <input className="field" type="number" min={0} value={plan.maxPrice} onChange={(e) => setPlan({ ...plan, maxPrice: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">بازه بررسی (روز)</label>
            <input className="field" type="number" min={1} max={30} value={plan.lookAheadDays} onChange={(e) => setPlan({ ...plan, lookAheadDays: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">ساعت اجرا</label>
            <input className="field" type="number" min={0} max={23} value={plan.runAtHour} onChange={(e) => setPlan({ ...plan, runAtHour: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">دقیقه اجرا</label>
            <input className="field" type="number" min={0} max={59} value={plan.runAtMinute} onChange={(e) => setPlan({ ...plan, runAtMinute: Number(e.target.value) })} />
          </div>
        </div>

        <div className="mt-4">
          <button className="btn btn-primary" onClick={savePlan} disabled={busy === "plan"}>{busy === "plan" ? "…" : "ذخیره قانون و زمان‌بندی"}</button>
        </div>

        {plans.length > 0 && (
          <div className="mt-5 overflow-x-auto">
            <table className="data">
              <thead>
                <tr><th>قانون</th><th>پروفایل</th><th>روزها</th><th>وعده‌ها</th><th>اجرای بعدی</th><th>فعال</th><th /></tr>
              </thead>
              <tbody>
                {plans.map((row) => (
                  <tr key={row.id}>
                    <td className="font-semibold text-white">{row.name}</td>
                    <td className="text-xs text-slate-400">{row.profileTitle}</td>
                    <td className="text-xs">{row.weekdays.map((d) => WEEKDAYS[d]).join("، ") || "—"}</td>
                    <td className="text-xs">{row.meals.map((m) => MEAL_FA[m] ?? m).join("، ") || "—"}</td>
                    <td className="text-xs text-slate-400">{timeFa(row.nextRunAt)}</td>
                    <td>
                      <button className="chip" data-on={row.active} onClick={() => togglePlanActive(row)}>{row.active ? "فعال" : "خاموش"}</button>
                    </td>
                    <td><button className="chip" onClick={() => deletePlan(row.id)}>حذف</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* اجرای موتور */}
      <section className="card p-5">
        <header className="mb-4">
          <h3 className="text-lg font-bold text-white">۳) اجرای موتور و لاگ</h3>
          <p className="text-xs text-slate-400">با «حالت تمرین» هیچ درخواست واقعی ارسال نمی‌شود؛ فقط جریان کار نمایش داده می‌شود.</p>
        </header>
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="label">پروفایل</label>
            <select className="field" value={runner.profileId || ""} onChange={(e) => setRunner({ ...runner, profileId: Number(e.target.value) })}>
              <option value="">انتخاب کنید…</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </div>
          <div>
            <label className="label">قانون (اختیاری)</label>
            <select className="field" value={runner.planId || ""} onChange={(e) => setRunner({ ...runner, planId: Number(e.target.value) })}>
              <option value="">بدون قانون (همه‌ی روزهای بازه)</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="flex items-end pb-1">
            <span className="chip" data-on={runner.dryRun} onClick={() => setRunner({ ...runner, dryRun: !runner.dryRun })}>🧪 حالت تمرین (dry-run)</span>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" onClick={runNow} disabled={busy === "run"}>{busy === "run" ? "در حال اجرا…" : "اجرای موتور"}</button>
          {selectedPlan && <p className="text-xs text-slate-400">قانون انتخابی: {selectedPlan.name} — اجرای بعدی {timeFa(selectedPlan.nextRunAt)}</p>}
        </div>

        {result && (
          <div className="mt-4 rounded-xl border border-slate-700/50 bg-black/40 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs text-slate-300">
              <span className={badge(result.status)}>{STATUS_FA[result.status] ?? result.status}</span>
              <span>{result.message}</span>
            </div>
            <pre className="code max-h-72">{result.steps.map((s) => `[${s.level.toUpperCase()}] ${s.message}`).join("\n")}</pre>
          </div>
        )}

        {runs.length > 0 && (
          <div className="mt-5 overflow-x-auto">
            <table className="data">
              <thead>
                <tr><th>زمان</th><th>محرک</th><th>وضعیت</th><th>ثبت</th><th>تکراری</th><th>ناموفق</th><th>پیام</th></tr>
              </thead>
              <tbody>
                {runs.map((row) => (
                  <tr key={row.id}>
                    <td className="text-xs text-slate-400">{timeFa(row.startedAt)}</td>
                    <td className="text-xs">{row.trigger === "cron" ? "کرون" : "دستی"}</td>
                    <td>
                      <span className={badge(row.status)}>{STATUS_FA[row.status] ?? row.status}</span>
                      {row.simulated && <span className="badge mr-1 bg-fuchsia-500/15 text-fuchsia-300">شبیه‌سازی</span>}
                    </td>
                    <td>{fa(row.booked)}</td>
                    <td>{fa(row.skipped)}</td>
                    <td>{fa(row.failed)}</td>
                    <td className="text-xs text-slate-400">{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* رزروها */}
      {reservations.length > 0 && (
        <section className="card p-5">
          <h3 className="mb-4 text-lg font-bold text-white">۴) رزروهای شناسایی‌شده</h3>
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr><th>تاریخ</th><th>روز</th><th>وعده</th><th>غذا</th><th>قیمت</th><th>وضعیت</th><th>توضیح</th></tr>
              </thead>
              <tbody>
                {reservations.map((row) => (
                  <tr key={row.id}>
                    <td>{fa(row.jalaliDate)}</td>
                    <td className="text-xs text-slate-400">{WEEKDAYS[row.weekday] ?? "—"}</td>
                    <td>{MEAL_FA[row.meal] ?? row.meal}</td>
                    <td className="font-semibold text-white">{row.foodName}</td>
                    <td className="text-xs">{row.price ? fa(row.price.toLocaleString("en-US")) : "—"}</td>
                    <td><span className={badge(row.status)}>{STATUS_FA[row.status] ?? row.status}</span></td>
                    <td className="text-xs text-slate-400">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
