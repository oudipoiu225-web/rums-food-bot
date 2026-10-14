import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ستاره خودکار | رزرو غذای سلف دانشگاه علوم پزشکی رفسنجان",
  description:
    "سیستم رزرو خودکار وعده‌های غذایی سامانه ستاره (self.rums.ac.ir) با زمان‌بندی، لاگ و اعلان تلگرام.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body className="antialiased">{children}</body>
    </html>
  );
}
