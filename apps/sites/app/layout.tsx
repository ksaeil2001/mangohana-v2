import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trio · 만화 번역 작업실",
  description: "이야기를 옮기는 가장 편안한 작업실. 이미지 위에서 번역하고, 다듬고, 완성하세요.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
