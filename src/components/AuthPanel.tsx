"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error ?? `خطای ${res.status}`);
  return data;
}

export default function AuthPanel() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const router = useRouter();

  const flash = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 6000);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        await api("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password, name }) });
        flash("ok", "حساب ساخته شد! حالا وارد شوید.");
        setMode("login");
        setPassword("");
      } else {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
        flash("ok", "خوش آمدید!");
        router.refresh();
      }
    } catch (err) {
      flash("err", err instanceof Error ? err.message : "خطا");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto mt-8 max-w-md card p-6">
      <h2 className="mb-1 text-xl font-bold text-white">{mode === "login" ? "ورود به پنل" : "ثبت‌نام"}</h2>
      <p className="mb-5 text-xs text-slate-400">{mode === "login" ? "با ایمیل و رمز پنل وارد شوید (این رمز با رمز سامانه سلف فرق دارد)." : "یک حساب برای مدیریت رزروهایتان بسازید."}</p>

      {notice && (
        <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${notice.kind === "ok" ? "border-emerald-400/40 text-emerald-200" : "border-rose-400/40 text-rose-200"}`}>
          {notice.text}
        </div>
      )}

      <form onSubmit={submit} className="space-y-4">
        {mode === "signup" && (
          <div>
            <label className="label">نام (اختیاری)</label>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="علی محمدی" dir="auto" />
          </div>
        )}
        <div>
          <label className="label">ایمیل</label>
          <input className="field" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@rums.ac.ir" required />
        </div>
        <div>
          <label className="label">رمز عبور پنل</label>
          <input className="field" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
        </div>
        <button className="btn btn-primary w-full" type="submit" disabled={busy}>{busy ? "…" : mode === "login" ? "ورود" : "ساخت حساب"}</button>
      </form>

      <div className="mt-4 text-center text-xs text-slate-400">
        {mode === "login" ? (
          <>حساب ندارید؟ <button className="text-emerald-400 underline" onClick={() => setMode("signup")}>ثبت‌نام</button></>
        ) : (
          <>حساب دارید؟ <button className="text-emerald-400 underline" onClick={() => setMode("login")}>ورود</button></>
        )}
      </div>
    </section>
  );
}