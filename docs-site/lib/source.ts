import { loader } from 'fumadocs-core/source';
import { absolute, docsContentRoute, docsRoute, docsUrl, siteUrl } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
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

// The Markdown copy of a page, for assistants: /AutoMode/docs/llms.mdx/<slug>/content.md.
const markdownOf = (page: Page) => `${docsUrl}${docsContentRoute}/${[...page.slugs, 'content.md'].join('/')}`;

// llms.txt and llms-full.txt use full URLs, because an assistant reads them without a base.
export const docsLlms = {
  async index() {
    const lines = [
      '# AutoMode docs',
      '',
      '> AutoMode is a free, open source Claude Code mod. It picks the model and the effort for every prompt, runs a plan, build, verify and review workflow for big jobs, and always reviews risky changes. It needs no API key and no server.',
      '',
      `Website: ${siteUrl}`,
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
      `- [Every page in one file](${docsUrl}/llms-full.txt)`,
      `- [Benchmark](${siteUrl}benchmark/)`,
      `- [Cost calculator](${siteUrl}calculator/)`,
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
