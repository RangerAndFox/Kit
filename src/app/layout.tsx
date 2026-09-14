import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

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
    <html lang="en" className={`dark ${inter.variable} ${mono.variable}`}>
      <body>
        {children}
      </body>
    </html>
  );
}
