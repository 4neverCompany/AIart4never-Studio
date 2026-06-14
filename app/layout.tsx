import type { Metadata, Viewport } from 'next';
import { Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Toast } from '@/components/Toast';
import { UpdateChecker } from '@/components/UpdateChecker';
import { FirstRunBanner } from '@/components/FirstRunBanner';
import { StartupReconciler } from '@/components/post-lifecycle/StartupReconciler';
import { WebAnalytics } from '@/components/WebAnalytics';

// AETHER SANS → Space Grotesk: geometric tech sans, distinctive letterforms,
// futuristic feel that matches the 4neverCompany dark studio aesthetic.
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-sans',
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
});

// NEXUS MONO → JetBrains Mono: designed for developer interfaces,
// high legibility at small sizes for stats, timestamps, and code.
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'MashupForge',
  description: 'Generate crossover images across multiple AI providers (Leonardo.ai, MiniMax, GPT Image, Nano Banana) and post to Instagram / Twitter via an autonomous pipeline.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Mashup Studio',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  themeColor: '#050505',
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body className="font-sans antialiased bg-zinc-950 text-zinc-50 selection:bg-emerald-500/30" suppressHydrationWarning>
        {children}
        <Toast />
        <UpdateChecker />
        <FirstRunBanner />
        <StartupReconciler />
        {/* Web build only — renders null in the Tauri desktop app. */}
        <WebAnalytics />
      </body>
    </html>
  );
}
