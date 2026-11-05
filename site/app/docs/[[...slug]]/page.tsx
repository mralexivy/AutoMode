import { source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { getBreadcrumbItems } from 'fumadocs-core/breadcrumb';
import { absolute, docsUrl, getPageImageUrl, getPageMarkdownUrl, gitConfig, siteUrl } from '@/lib/shared';

const repo = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

// TechArticle and BreadcrumbList for search engines and AI assistants. Every name is plain text.
function jsonLd(page: NonNullable<ReturnType<typeof source.getPage>>) {
  const url = absolute(page.url);
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
    publisher: { '@type': 'Organization', name: 'AutoMode', url: siteUrl, logo: `${docsUrl}/mark.svg` },
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
  return page.slugs.length ? [article, breadcrumb] : [article];
}

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} tableOfContent={{ style: 'clerk' }}>
      <script
        type="application/ld+json"
        // JSON.stringify output with < escaped cannot close the script tag.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd(page)).replace(/</g, '\\u003c') }}
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
    openGraph: { url, title: page.data.title, description: page.data.description, images: image },
    twitter: { card: 'summary_large_image', title: page.data.title, description: page.data.description, images: image },
  };
}
