import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { absolute } from '@/lib/shared';

export const dynamic = 'force-static';

// Served at /AutoMode/docs/sitemap.xml. The site's robots.txt and sitemap index list it.
export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => ({
    url: absolute(page.url),
    changeFrequency: 'weekly',
    priority: page.slugs.length ? 0.7 : 0.9,
  }));
}
