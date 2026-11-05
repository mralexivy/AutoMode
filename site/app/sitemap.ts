import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { absolute, siteUrl } from '@/lib/shared';

export const dynamic = 'force-static';

// Served at /AutoMode/sitemap.xml. Moved addresses are left out: each one redirects to a page listed here.
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date().toISOString().slice(0, 10);
  return [
    { url: siteUrl, lastModified, changeFrequency: 'weekly', priority: 1 },
    ...source.getPages().map((page) => ({
      url: absolute(page.url),
      lastModified,
      changeFrequency: 'weekly' as const,
      priority: page.slugs.length ? 0.7 : 0.9,
    })),
  ];
}
