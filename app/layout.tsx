import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Later AI",
  description: "Upload documents, ask questions, get cited answers.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        {children}
      </body>
    </html>
  );
}
