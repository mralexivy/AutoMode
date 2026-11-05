import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { absolute, getPageImageUrl, siteUrl } from '@/lib/shared';
import { imagesIn, lastModified } from '@/lib/seo';

export const dynamic = 'force-static';

// Served at /AutoMode/sitemap.xml, with an image list per page so Google Images finds the pictures and preview cards.
// Moved addresses are left out: each one redirects to a page listed here.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const home = {
    url: siteUrl,
    lastModified: lastModified('app/(home)/page.tsx'),
    changeFrequency: 'weekly' as const,
    priority: 1,
    images: [`${siteUrl}social.png`, `${siteUrl}img/demo.gif`, `${siteUrl}img/ladder.svg`],
  };
  const docs = await Promise.all(
    source.getPages().map(async (page) => ({
      url: absolute(page.url),
      lastModified: lastModified(`content/docs/${page.path}`),
      changeFrequency: 'weekly' as const,
      priority: page.slugs.length ? 0.7 : 0.9,
      images: [absolute(getPageImageUrl(page).url).replace(/\/$/, ''), ...imagesIn(await page.data.getText('raw'))],
    })),
  );
  return [home, ...docs];
}
