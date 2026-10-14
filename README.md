# ستاره خودکار (Rums Food Bot)

سیستم رزرو خودکار غذای سلف دانشگاه علوم پزشکی رفسنجان — با پنل چندکاربره، زمان‌بندی و اعلان تلگرام.

## امکانات
- چندکاربره: هر دانشجو با ایمیل/رمز پنل خودش وارد می‌شود
- اتصال حساب سامانه سلف (self.rums.ac.ir) با رمزنگاری AES-256-GCM
- قانون رزرو: روزهای هفته، وعده‌ها (صبحانه/ناهار/شام)، اولویت غذا، سقف قیمت
- زمان‌بندی خودکار با کرون داخلی (هر دقیقه‌چک) یا cron خارجی
- حالت تمرین (dry-run) قبل از رزرو واقعی
- اعلان تلگرام

## اجرای محلی
```bash
npm install
# دیتابیس PostgreSQL بسازید و DATABASE_URL را در .env بگذارید
npx drizzle-kit push
npm run dev
```

## دیپلوی روی Botkeep
1. ریپو را به GitHub پوش کنید
2. در Botkeep: Import from GitHub → این ریپو → Branch main
3. به `DATABASE_URL` و `APP_SECRET` مقدار بدهید
4. Start server

## API
- `POST /api/auth/signup` – ثبت‌نام
- `POST /api/auth/login` – ورود
- `POST /api/auth/logout` – خروج
- `GET/POST /api/profiles` – حساب‌های سلف
- `POST /api/profiles/:id/test` – تست اتصال
- `GET/POST /api/plans` – قانون‌ها
- `GET/POST /api/runs` – اجرای دستی
- `POST /api/cron/run` – اجرای کرون (قانون‌های سررسیدشده)

## نکته‌ی مهم درباره سرویس‌دهنده‌ی (هاستینگ) و مسئولیت
این ابزار برای مدیریت رزرو حساب **خودتان** ساخته شده و فقط با ادغام
`https://github.com/saigevandervort87/Cfu-kalinan` (تحت گواهی MIT) اقتباس شده است.
