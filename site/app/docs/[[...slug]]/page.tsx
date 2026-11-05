import { source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  PageLastUpdate,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { getBreadcrumbItems } from 'fumadocs-core/breadcrumb';
import { absolute, docsUrl, getPageImageUrl, getPageMarkdownUrl, gitConfig, siteUrl } from '@/lib/shared';
import { faqIn, imagesIn, lastModified } from '@/lib/seo';

type DocPage = NonNullable<ReturnType<typeof source.getPage>>;
const fileOf = (page: DocPage) => `content/docs/${page.path}`;

const repo = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

// TechArticle, BreadcrumbList and, on the FAQ page, FAQPage, for search engines and AI assistants. Every name is plain text.
async function jsonLd(page: DocPage) {
  const url = absolute(page.url);
  const raw = await page.data.getText('raw');
  const modified = lastModified(fileOf(page));
  const crumbs = getBreadcrumbItems(page.url, source.getPageTree(), { includePage: true, includeRoot: false })
    .filter((c) => typeof c.name === 'string')
    .map((c, i, all) => ({
      '@type': 'ListItem',
      position: i + 3,
      name: c.name as string,
      ...(i < all.length - 1 && c.url ? { item: absolute(c.url) } : {}),
    }));
  const article = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: page.data.title,
    description: page.data.description,
    url,
    mainEntityOfPage: url,
    inLanguage: 'en',
    image: [absolute(getPageImageUrl(page).url).replace(/\/$/, ''), ...imagesIn(raw)],
    ...(modified ? { dateModified: modified } : {}),
    isPartOf: { '@type': 'WebSite', name: 'AutoMode docs', url: `${docsUrl}/` },
    about: {
      '@type': 'SoftwareApplication',
      name: 'AutoMode',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'macOS, Linux, Windows',
      url: siteUrl,
      codeRepository: repo,
      license: `${repo}/blob/main/LICENSE`,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
    author: { '@type': 'Person', name: 'Alex Ivy', url: 'https://github.com/mralexivy' },
    publisher: { '@type': 'Organization', name: 'AutoMode', url: siteUrl, logo: `${siteUrl}apple-touch-icon.png` },
  };
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'AutoMode', item: siteUrl },
      { '@type': 'ListItem', position: 2, name: 'Docs', item: `${docsUrl}/` },
      ...(page.slugs.length ? crumbs : []),
    ],
  };
  const faq = faqIn(raw);
  const faqPage = faq.length
    ? [{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }]
    : [];
  return [article, ...(page.slugs.length ? [breadcrumb] : []), ...faqPage];
}

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const modified = lastModified(fileOf(page));
  const markdownUrl = getPageMarkdownUrl(page).url;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} tableOfContent={{ style: 'clerk' }}>
      <script
        type="application/ld+json"
        // JSON.stringify output with < escaped cannot close the script tag.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(await jsonLd(page)).replace(/</g, '\\u003c') }}
      />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`${repo}/blob/${gitConfig.branch}/site/content/docs/${page.path}`}
        />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
      {modified ? <PageLastUpdate date={new Date(modified)} /> : null}
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/docs/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const url = absolute(page.url);
  const image = getPageImageUrl(page).url;
  return {
    title: page.data.seoTitle ? { absolute: page.data.seoTitle } : page.data.title,
    description: page.data.description,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      url,
      title: page.data.seoTitle ?? page.data.title,
      description: page.data.description,
      images: image,
      ...(lastModified(fileOf(page)) ? { modifiedTime: lastModified(fileOf(page)) } : {}),
    },
    twitter: { card: 'summary_large_image', title: page.data.title, description: page.data.description, images: image },
  };
}
