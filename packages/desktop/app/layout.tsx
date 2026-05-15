import type { Metadata } from "next";
import "../../web/app/globals.css";

export const metadata: Metadata = {
  title: "SubGen",
  description: "AI-powered subtitle generation desktop app",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
