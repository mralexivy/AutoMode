import { loader } from 'fumadocs-core/source';
import { absolute, docsContentRoute, docsRoute, siteUrl } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // seoTitle: a longer title for search results, where the sidebar keeps the short one.
    schema: pageSchema.extend({ seoTitle: z.string().optional() }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [],
});

type Page = ReturnType<typeof source.getPages>[number];

// The Markdown copy of a page, for assistants: /AutoMode/llms.mdx/docs/<slug>/content.md.
const markdownOf = (page: Page) => `${siteUrl}${docsContentRoute.slice(1)}/${[...page.slugs, 'content.md'].join('/')}`;

// llms.txt and llms-full.txt use full URLs, because an assistant reads them without a base.
export const docsLlms = {
  async index() {
    const lines = [
      '# AutoMode',
      '',
      '> AutoMode is a free, open source Claude Code mod. It picks the model and the effort for every prompt, runs a plan, build, verify and review workflow for big jobs, and always reviews risky changes. It needs no API key and no server. In five mixed coding sessions with hidden tests, it cost $2.01 against $4.14 for Claude Code on Opus, with all 20 steps passing.',
      '',
      'AutoMode is a community project, not made by Anthropic. It is not Claude Code\'s built-in auto mode, which is a permission mode.',
      '',
      'Install in Claude Code: `/plugin marketplace add mralexivy/AutoMode`, then `/plugin install automode@automode`, then `/reload-plugins`.',
      '',
      'Source: https://github.com/mralexivy/AutoMode',
      '',
      '## Docs',
      '',
      ...source.getPages().map((p) => `- [${p.data.title}](${absolute(p.url)}): ${p.data.description ?? ''}`),
      '',
      '## Markdown copies',
      '',
      ...source.getPages().map((p) => `- [${p.data.title}](${markdownOf(p)})`),
      '',
      '## Optional',
      '',
      `- [Every page in one file](${siteUrl}llms-full.txt)`,
      `- [Home](${siteUrl})`,
    ];
    return lines.join('\n') + '\n';
  },
  async page(page: Page) {
    return `# ${page.data.title}

URL: ${absolute(page.url)}

${page.data.description ?? ''}

${await page.data.getText('processed')}`;
  },
  async full() {
    const parts = await Promise.all(source.getPages().map((p) => this.page(p)));
    return parts.join('\n\n---\n\n');
  },
};
