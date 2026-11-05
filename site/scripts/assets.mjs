// Copies the images the docs show from their one source in the repository into public/.
// public/ is generated, so a picture never has two copies in git.
import { copyFileSync, mkdirSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const out = new URL('../public/', import.meta.url);
const files = {
  'docs/readme/ladder.svg': 'img/ladder.svg',
  'docs/readme/workflow.svg': 'img/workflow.svg',
  'docs/readme/contribute.svg': 'img/contribute.svg',
  'docs/readme/session.png': 'img/session.png',
  'docs/readme/demo.gif': 'img/demo.gif',
  'brand/mark.svg': 'mark.svg',
  'brand/icon-180.png': 'apple-touch-icon.png',
  'brand/social-preview.png': 'social.png',
};

mkdirSync(new URL('img/', out), { recursive: true });
for (const [from, to] of Object.entries(files)) copyFileSync(new URL(from, root), new URL(to, out));
