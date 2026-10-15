import { getCurrentUser } from "@/lib/auth";
import AuthPanel from "@/components/AuthPanel";
import Dashboard from "@/components/Dashboard";

export default async function Home() {
  const user = await getCurrentUser();

  return (
    <main className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      {/* ------------------------------- هیرو ------------------------------- */}
      <section className="relative overflow-hidden rounded-3xl border border-slate-700/40 bg-gradient-to-bl from-emerald-500/10 via-transparent to-indigo-500/10 p-6 sm:p-10">
        <div className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full bg-emerald-400/10 blur-3xl floaty" />
        <span className="badge bg-emerald-400/15 text-emerald-300">
          سامانه ستاره · دانشگاه علوم پزشکی رفسنجان · self.rums.ac.ir
        </span>
        <h1 className="mt-4 text-3xl font-black leading-tight text-white sm:text-4xl">
          رزرو خودکار غذای سلف، بدون هر روز کلیک کردن
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base">
          ثبت‌نام کن، حساب سامانه سلف دانشگاهت را وصل کن و قانون رزرو بچین؛ موتور هر روز سر وقت
          وارد سامانه می‌شود، برنامه‌ی هفتگی را می‌خواند و طبق قانون شما وعده‌ها را رزرو می‌کند.
        </p>
        <div className="mt-6 grid gap-2 text-xs text-slate-400 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-700/40 bg-black/25 px-3 py-2">
            ورود امن · رمزها با AES-256-GCM
          </div>
          <div className="rounded-xl border border-slate-700/40 bg-black/25 px-3 py-2">
            dry-run · قبل از رزرو واقعی تمرین کنید
          </div>
          <div className="rounded-xl border border-slate-700/40 bg-black/25 px-3 py-2">
            چند کاربره · هر نفر حساب خودش
          </div>
        </div>
      </section>

      {/* ------------------------------- پنل ------------------------------- */}
      <div className="mt-10">
        {user ? <Dashboard userName={user.name || user.email} /> : <AuthPanel />}
      </div>

      <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/40 pt-5 text-xs text-slate-500">
        <span>ستاره خودکار · ساخته‌شده با Next.js، PostgreSQL و Drizzle ORM</span>
        <span dir="ltr">https://self.rums.ac.ir/</span>
      </footer>
    </main>
  );
}
