import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { absolute, getPageImageUrl, siteUrl } from '@/lib/shared';
import { imagesIn, lastModified, videoEntry, videosIn } from '@/lib/seo';

export const dynamic = 'force-static';

// The scenes app/(home)/page.tsx plays.
const SCENES_ON_HOME = ['route-demo', 'benchmark-race', 'workflow-flow', 'cache-check'] as const;

// Served at /AutoMode/sitemap.xml, with an image list per page so Google Images finds the pictures and preview cards.
// Moved addresses are left out: each one redirects to a page listed here.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const home = {
    url: siteUrl,
    lastModified: lastModified('app/(home)/page.tsx'),
    changeFrequency: 'weekly' as const,
    priority: 1,
    images: [`${siteUrl}social.png`, `${siteUrl}img/demo.gif`, `${siteUrl}img/ladder.svg`, ...SCENES_ON_HOME.map((id) => `${siteUrl}video/${id}.jpg`)],
    videos: SCENES_ON_HOME.map(videoEntry),
  };
  const docs = await Promise.all(
    source.getPages().map(async (page) => {
      const raw = await page.data.getText('raw');
      const videos = videosIn(raw);
      return {
        url: absolute(page.url),
        lastModified: lastModified(`content/docs/${page.path}`),
        changeFrequency: 'weekly' as const,
        priority: page.slugs.length ? 0.7 : 0.9,
        images: [absolute(getPageImageUrl(page).url).replace(/\/$/, ''), ...imagesIn(raw), ...videos.map((id) => `${siteUrl}video/${id}.jpg`)],
        ...(videos.length ? { videos: videos.map(videoEntry) } : {}),
      };
    }),
  );
  return [home, ...docs];
}
