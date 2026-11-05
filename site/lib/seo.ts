import { execFileSync } from 'node:child_process';
import { siteUrl } from './shared';
import { SCENE_META, sceneSeconds, type SceneId } from '@/remotion/meta';

// Build-time facts for search engines: when a page last changed, its images, its FAQ entries and its videos.
// Runs only while Next.js renders the static export, never in the browser.

const dates = new Map<string, string | undefined>();

// The ISO date of the last commit that touched a file under site/. The deploy checks out full history for this.
// Without git history it returns undefined, and the page leaves the date out instead of guessing.
export function lastModified(file: string): string | undefined {
  if (!dates.has(file)) {
    let iso: string | undefined;
    try {
      iso = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { encoding: 'utf8' }).trim() || undefined;
    } catch {}
    dates.set(file, iso);
  }
  return dates.get(file);
}

// The full URLs of the images a page shows, from its MDX source: /img/ paths, which scripts/assets.mjs copies.
// Google indexes PNG, GIF and SVG, so every kind is listed.
export function imagesIn(raw: string): string[] {
  return [...new Set([...raw.matchAll(/\]\(\/img\/([\w.-]+)\)/g)].map((m) => `${siteUrl}img/${m[1]}`))];
}

// The questions and answers of an FAQ page written as <Accordion title="..."> blocks, as plain text.
export function faqIn(raw: string): { q: string; a: string }[] {
  return [...raw.matchAll(/<Accordion title="([^"]+)">([\s\S]*?)<\/Accordion>/g)].map((m) => ({
    q: m[1],
    a: m[2]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  }));
}

// The scenes a page plays, from its <Motion id="..." /> tags.
export function videosIn(raw: string): SceneId[] {
  return [...new Set([...raw.matchAll(/<Motion id="([\w-]+)"/g)].map((m) => m[1]))].filter((id): id is SceneId => id in SCENE_META);
}

// The VideoObject for a scene's rendered MP4, for Google video results. The upload date is the file's last commit.
export function videoObject(id: SceneId) {
  const meta = SCENE_META[id];
  return {
    '@type': 'VideoObject',
    name: meta.title,
    description: meta.description,
    thumbnailUrl: `${siteUrl}video/${id}.jpg`,
    contentUrl: `${siteUrl}video/${id}.mp4`,
    uploadDate: lastModified(`public/video/${id}.mp4`) ?? new Date().toISOString(),
    duration: `PT${sceneSeconds(id)}S`,
    width: 1280,
    height: 720,
  };
}

// The sitemap's video entry for a scene.
export function videoEntry(id: SceneId) {
  const meta = SCENE_META[id];
  return {
    title: meta.title,
    description: meta.description,
    thumbnail_loc: `${siteUrl}video/${id}.jpg`,
    content_loc: `${siteUrl}video/${id}.mp4`,
    duration: sceneSeconds(id),
  };
}
