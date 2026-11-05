import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// A static export served by GitHub Pages under https://mralexivy.github.io/AutoMode/docs/.
// The pages workflow copies out/ into site/docs/.
/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath: '/AutoMode/docs',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  // docs-site has its own lockfile, apart from the mod's dev tools.
  turbopack: { root: import.meta.dirname },
};

export default withMDX(config);
