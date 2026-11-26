import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n';
import { ServiceWorker } from '@/components/Pwa';
import './globals.css';

export const metadata: Metadata = { title: 'MEDORA CLINICS', description: 'Smart healthcare. Simplified.', icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' }, appleWebApp: { capable: true, title: 'MEDORA', statusBarStyle: 'default' }, manifest: '/manifest.webmanifest' };
export const viewport: Viewport = { themeColor: '#115D62', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning><body className="antialiased"><I18nProvider><ServiceWorker />{children}</I18nProvider></body></html>;
}
