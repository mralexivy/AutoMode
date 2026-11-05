import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, basePath, gitConfig, siteUrl } from './shared';

function Logo() {
  return (
    <>
      {/* A plain img: the mark is a static file in public/, under basePath. */}
      <img src={`${basePath}/mark.svg`} alt="" width={24} height={24} className="rounded-md" />
      <span className="font-semibold">{appName}</span>
      <span className="text-fd-muted-foreground font-normal">docs</span>
    </>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Logo />,
      url: '/',
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      { text: 'Website', url: siteUrl, external: true },
      { text: 'Benchmark', url: `${siteUrl}benchmark/`, external: true },
      { text: 'Cost calculator', url: `${siteUrl}calculator/`, external: true },
    ],
  };
}
