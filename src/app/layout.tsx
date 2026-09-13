import type { Metadata } from "next";
import "./globals.css";

// Every HTML response must receive fresh framework-script nonces from Proxy.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: "Kit — Production Intelligence",
  description:
    "AI-powered production agent for creative studios. Streamline workflows, manage teams, and accelerate creative delivery.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="font-satoshi bg-[#0C0E12] text-white antialiased">
        {children}
      </body>
    </html>
  );
}
