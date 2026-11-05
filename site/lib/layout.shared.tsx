import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { BookOpen, Calculator, ChartColumn, GitCompareArrows, Rocket } from 'lucide-react';
import { appName, basePath, repoUrl } from './shared';

function Logo() {
  return (
    <>
      {/* A plain img: the mark is a static file in public/, under basePath. */}
      <img src={`${basePath}/mark.svg`} alt="" width={24} height={24} className="rounded-md" />
      <span className="font-semibold">{appName}</span>
    </>
  );
}

// The top links, shared by the home page and the docs.
export const navLinks = [
  { text: 'Docs', url: '/docs', icon: <BookOpen />, active: 'nested-url' as const },
  { text: 'Install', url: '/docs/getting-started/install', icon: <Rocket /> },
  { text: 'Benchmark', url: '/docs/benchmarks/results', icon: <ChartColumn /> },
  { text: 'Calculator', url: '/docs/guides/calculator', icon: <Calculator /> },
  { text: 'Compare', url: '/docs/compare', icon: <GitCompareArrows /> },
];

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Logo />,
      url: '/',
    },
    githubUrl: repoUrl,
    // Dark only, so there is no light theme to switch to.
    themeSwitch: { enabled: false },
    links: navLinks,
  };
}
