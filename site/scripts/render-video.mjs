// Renders each AutoMode scene to public/video/<id>.mp4, with a poster from its last frame at public/video/<id>.jpg.
// The site's player draws the scenes live; these files are for search engines, social cards and people without
// JavaScript. Run it after a scene changes: npm run video:render. Pass ids to render only those.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SCENES = ['terminal-demo', 'route-demo', 'benchmark-race', 'workflow-flow', 'cache-check'];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : SCENES;
mkdirSync(new URL('../public/video/', import.meta.url), { recursive: true });
const run = (args) => execFileSync('npx', ['remotion', ...args], { stdio: 'inherit' });

for (const id of ids) {
  run(['render', 'remotion/index.ts', id, `public/video/${id}.mp4`, '--codec=h264', '--crf=20', '--log=error']);
  run(['still', 'remotion/index.ts', id, `public/video/${id}.jpg`, '--frame=-1', '--image-format=jpeg', '--jpeg-quality=85', '--log=error']);
}
