// Checks the website in site/, a Fumadocs app on Next.js exported as static files, without building it. Every docs
// page has a title and a search-sized description, every sidebar entry names a real page, links and images resolve,
// every old address redirects, and the deploy keeps the files Search Console and IndexNow need. `npm run build` in
// site/ is the full check, and the site CI job runs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const site = new URL('site/', root)
const content = new URL('content/docs/', site)
const read = (u: URL) => readFileSync(u, 'utf8')
// Search Console drops the property if the verification file goes away.
const VERIFICATION_FILE = 'googlef7b6ef980e80a74c.html'

function mdx(dir = content, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...mdx(new URL(`${e.name}/`, dir), `${prefix}${e.name}/`))
    else if (e.name.endsWith('.mdx')) out.push(`${prefix}${e.name}`)
  }
  return out.sort()
}
const pages = mdx()
// The URL path of a page: 'concepts/routing.mdx' is '/docs/concepts/routing', and an index is its folder.
const route = (p: string) => `/docs/${p.replace(/\.mdx$/, '').replace(/(^|\/)index$/, '')}`.replace(/\/$/, '')
const routes = new Set(['/', ...pages.map(route)])
const front = (p: string) => {
  const m = read(new URL(p, content)).match(/^---\n([\s\S]*?)\n---/)
  assert.ok(m, `${p} has no frontmatter`)
  const field = (k: string) => {
    const v = m[1].match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1]
    return v === undefined ? undefined : v.startsWith('"') ? JSON.parse(v) : v
  }
  return { title: field('title'), seoTitle: field('seoTitle'), description: field('description') }
}
// The old addresses and where each one moved, from lib/shared.ts.
const moved = Object.fromEntries(
  [...read(new URL('lib/shared.ts', site)).match(/export const moved[^{]*\{([\s\S]*?)\};/)![1].matchAll(/'?([a-z-]+)'?: '([^']+)'/g)].map((m) => [m[1], m[2]]),
)

test('every docs page has a title and a description that fits a search result', () => {
  assert.ok(pages.length >= 38, `only ${pages.length} pages`)
  for (const p of pages) {
    const { title, seoTitle, description } = front(p)
    assert.ok(title && title.length <= 60, `${p} title: ${title}`)
    assert.ok(!seoTitle || seoTitle.length <= 65, `${p} seoTitle: ${seoTitle}`)
    assert.ok(description && description.length >= 100 && description.length <= 160, `${p} description is ${description?.length} characters`)
  }
})

test('titles and descriptions are unique', () => {
  const all = pages.map(front)
  assert.equal(new Set(all.map((f) => f.seoTitle ?? f.title)).size, all.length)
  assert.equal(new Set(all.map((f) => f.description)).size, all.length)
})

test('every sidebar entry names a page or folder that exists, and every page is listed', () => {
  const listed = new Set<string>()
  const walk = (dir: string) => {
    const meta = JSON.parse(read(new URL(`${dir}meta.json`, content)))
    for (const entry of meta.pages as string[]) {
      if (/^---.*---$/.test(entry)) continue
      const name = entry.replace(/^\.\.\./, '')
      if (existsSync(new URL(`${dir}${name}/`, content))) { walk(`${dir}${name}/`); continue }
      assert.ok(existsSync(new URL(`${dir}${name}.mdx`, content)), `${dir}meta.json lists ${entry}`)
      listed.add(`${dir}${name}.mdx`)
    }
  }
  walk('')
  for (const p of pages) assert.ok(listed.has(p), `${p} is not in a meta.json`)
})

test('site links and images resolve', () => {
  const images = [...read(new URL('scripts/assets.mjs', site)).matchAll(/': '([^']+)'/g)].map((m) => m[1])
  const check = (file: string, text: string) => {
    for (const m of text.matchAll(/\]\((\/[^)\s#]*)(?:#[^)]*)?\)|href=["{`]+(\/[^"#`}]*)/g)) {
      const href = (m[1] ?? m[2]).replace(/\/$/, '') || '/'
      if (href.startsWith('/img/')) assert.ok(images.includes(href.slice(1)), `${file} shows ${href}, which scripts/assets.mjs does not copy`)
      else assert.ok(routes.has(href), `${file} links to ${href}`)
    }
  }
  for (const p of pages) check(p, read(new URL(p, content)))
  for (const f of ['app/(home)/page.tsx', 'lib/layout.shared.tsx', 'components/install-card.tsx']) {
    const text = read(new URL(f, site))
    check(f, text)
    // Links the home page lists in arrays, such as the footer.
    for (const [, href] of text.matchAll(/'(\/docs[^'#]*)'/g)) assert.ok(routes.has(href), `${f} links to ${href}`)
  }
})

test('every image the site shows has a source file in the repository', () => {
  for (const [, from] of read(new URL('scripts/assets.mjs', site)).matchAll(/'([^']+)': '[^']+'/g)) assert.ok(existsSync(new URL(from, root)), `${from} is missing`)
})

test('every old address redirects to a page that exists', () => {
  for (const old of ['how-it-works', 'install', 'compare', 'benchmark', 'prompt-cache', 'calculator', 'effort-levels', 'haiku-vs-sonnet-vs-opus',
    'reduce-claude-code-costs', 'automode-vs-effortless', 'automode-vs-claude-code-router', 'auto-mode-vs-automode']) {
    assert.ok(moved[old], `${old} has no redirect`)
    assert.ok(routes.has(moved[old]), `${old} redirects to ${moved[old]}, which is not a page`)
  }
})

test('the home page FAQ schema matches the visible questions', () => {
  const home = read(new URL('app/(home)/page.tsx', site))
  assert.match(home, /'@type': 'FAQPage',\s*mainEntity: FAQ\.map/)
  assert.ok([...home.matchAll(/^\s+q: '/gm)].length >= 6)
})

test('the site is dark only', () => {
  assert.match(read(new URL('components/provider.tsx', site)), /forcedTheme: 'dark'/)
  assert.match(read(new URL('lib/layout.shared.tsx', site)), /themeSwitch: \{ enabled: false \}/)
})

test('the site is a static export under /AutoMode, and the deploy publishes it', () => {
  const config = read(new URL('next.config.mjs', site))
  assert.match(config, /output: 'export'/)
  assert.match(config, /basePath: '\/AutoMode'/)
  assert.match(config, /trailingSlash: true/)
  assert.match(read(new URL('lib/shared.ts', site)), /basePath = '\/AutoMode'/)
  const pagesYml = read(new URL('.github/workflows/pages.yml', root))
  assert.match(pagesYml, /path: site\/out/)
  assert.match(pagesYml, /cp site\/out\/sitemap\.xml site\/out\/sitemap-pages\.xml/)
  assert.match(read(new URL('.github/workflows/test.yml', root)), /working-directory: site/)
})

test('the README links the docs, not the old addresses', () => {
  const readme = read(new URL('README.md', root))
  assert.ok(readme.includes('https://mralexivy.github.io/AutoMode/docs/'))
  for (const old of Object.keys(moved)) assert.ok(!readme.includes(`mralexivy.github.io/AutoMode/${old}/`), `README links the old /${old}/`)
})

test('the Search Console verification file stays in place', () => {
  assert.equal(read(new URL(`public/${VERIFICATION_FILE}`, site)).trim(), `google-site-verification: ${VERIFICATION_FILE}`)
})

test('the IndexNow key file names its own key, as the deploy step expects', () => {
  const keyFiles = readdirSync(new URL('public/', site)).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f))
  assert.equal(keyFiles.length, 1)
  assert.equal(read(new URL(`public/${keyFiles[0]}`, site)), keyFiles[0].replace('.txt', ''))
  assert.match(read(new URL('.github/workflows/pages.yml', root)), /site\/public\/\*\.txt/)
})
