import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// The whole website: a static export served by GitHub Pages under https://mralexivy.github.io/AutoMode/.
// The pages workflow publishes out/.
/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath: '/AutoMode',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  // The repository root, so the site can import the mod's pure cost code from hooks/lib/ (the payback chart).
  // site/ keeps its own lockfile and node_modules.
  turbopack: { root: new URL('..', import.meta.url).pathname },
};

export default withMDX(config);
