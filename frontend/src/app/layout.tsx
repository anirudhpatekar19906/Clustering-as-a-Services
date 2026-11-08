import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

const description =
  "Upload CSV datasets, configure K-Means clustering experiments, " +
  "and explore saved results in a clear, reliable workspace.";

export const metadata: Metadata = {
  applicationName: "CaaS",

  title: {
    default: "CaaS | Clustering Workspace",
    template: "%s | CaaS",
  },

  description,

  openGraph: {
    type: "website",
    siteName: "CaaS",
    title: "CaaS | Clustering Workspace",
    description,
  },

  twitter: {
    card: "summary",
    title: "CaaS | Clustering Workspace",
    description,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F7F8FA",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
