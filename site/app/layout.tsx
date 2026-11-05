import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import { basePath, siteUrl } from '@/lib/shared';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    template: '%s | AutoMode',
    default: 'AutoMode: a model router for Claude Code',
  },
  description:
    'Documentation for AutoMode, the free, open source Claude Code mod that picks the model and the effort for every prompt.',
  applicationName: 'AutoMode',
  authors: [{ name: 'Alex Ivy', url: 'https://github.com/mralexivy' }],
  icons: {
    icon: `${basePath}/mark.svg`,
    apple: `${basePath}/apple-touch-icon.png`,
  },
  openGraph: {
    type: 'website',
    siteName: 'AutoMode',
    locale: 'en_US',
  },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0a0d1b',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`dark ${inter.className}`} style={{ colorScheme: 'dark' }} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
