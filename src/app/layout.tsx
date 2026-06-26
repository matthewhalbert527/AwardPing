import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  applicationName: "AwardPing",
  title: {
    default: "AwardPing - Nationally Competitive Award Monitor",
    template: "%s | AwardPing",
  },
  description:
    "Monitor nationally competitive award pages for deadline, eligibility, application, and PDF updates.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/awardping-icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", type: "image/png", sizes: "180x180" }],
  },
  keywords: [
    "AwardPing",
    "nationally competitive awards",
    "fellowship advising",
    "scholarship updates",
    "award page monitoring",
    "education technology",
  ],
  creator: "AwardPing",
  publisher: "AwardPing",
  openGraph: {
    title: "AwardPing - Nationally Competitive Award Monitor",
    description:
      "Track nationally competitive award page updates with simple email alerts.",
    url: "/",
    siteName: "AwardPing",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
