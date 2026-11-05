import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import { basePath, docsUrl } from '@/lib/shared';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(`${docsUrl}/`),
  title: {
    template: '%s | AutoMode docs',
    default: 'AutoMode docs: a model router for Claude Code',
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
    siteName: 'AutoMode docs',
    locale: 'en_US',
  },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0d1b' },
    { media: '(prefers-color-scheme: light)', color: '#f7f7fd' },
  ],
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
