import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'AutoMode';
export const siteUrl = 'https://mralexivy.github.io/AutoMode/';
// Next.js adds basePath to links, but metadata and JSON-LD need the full URL.
export const docsUrl = `${siteUrl}docs`;
export const basePath = '/AutoMode';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const gitConfig = {
  user: 'mralexivy',
  repo: 'AutoMode',
  branch: 'main',
};

export const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

// The full public URL of a site path, such as '/docs/reference/settings' or '/'.
export function absolute(path: string) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return clean ? `${siteUrl}${clean}/` : siteUrl;
}

// The pages the old hand-written site had. Each old address now redirects to the page that holds its content, so
// search engines move the old ranking to the new page. tests/site.test.mts keeps this list whole.
export const moved: Record<string, string> = {
  'how-it-works': '/docs/concepts/routing',
  install: '/docs/getting-started/install',
  compare: '/docs/compare',
  benchmark: '/docs/benchmarks/results',
  'prompt-cache': '/docs/concepts/prompt-cache',
  calculator: '/docs/guides/calculator',
  'effort-levels': '/docs/guides/effort-levels',
  'haiku-vs-sonnet-vs-opus': '/docs/guides/haiku-vs-sonnet-vs-opus',
  'reduce-claude-code-costs': '/docs/guides/reduce-claude-code-costs',
  'automode-vs-effortless': '/docs/guides/automode-vs-effortless',
  'automode-vs-claude-code-router': '/docs/guides/automode-vs-claude-code-router',
  'auto-mode-vs-automode': '/docs/guides/auto-mode-vs-automode',
};

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
