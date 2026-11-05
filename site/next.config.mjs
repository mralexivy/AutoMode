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
  // site/ has its own lockfile, apart from the mod's dev tools.
  turbopack: { root: import.meta.dirname },
};

export default withMDX(config);
