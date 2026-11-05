import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'AutoMode';
export const siteUrl = 'https://mralexivy.github.io/AutoMode/';
// The public address of the docs. Next.js adds basePath to links, but metadata and JSON-LD need the full URL.
export const docsUrl = `${siteUrl}docs`;
export const basePath = '/AutoMode/docs';
export const docsRoute = '/';
export const docsImageRoute = '/og';
export const docsContentRoute = '/llms.mdx';

export const gitConfig = {
  user: 'mralexivy',
  repo: 'AutoMode',
  branch: 'main',
};

// The full public URL of a docs path, such as '/settings' or '/'.
export function absolute(path: string) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return clean ? `${docsUrl}/${clean}/` : `${docsUrl}/`;
}

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}
