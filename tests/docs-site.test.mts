// Checks the Fumadocs site in docs-site/ without building it. Every page has a title and a search-sized description,
// every sidebar entry names a real page, every docs link and image resolves, and the pages workflow publishes the
// build under /AutoMode/docs/. `npm run build` in docs-site/ is the full check, and the docs CI job runs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const content = new URL('docs-site/content/docs/', root)
const read = (u: URL) => readFileSync(u, 'utf8')

function mdx(dir = content, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...mdx(new URL(`${e.name}/`, dir), `${prefix}${e.name}/`))
    else if (e.name.endsWith('.mdx')) out.push(`${prefix}${e.name}`)
  }
  return out.sort()
}
const pages = mdx()
// The URL path of a page: 'concepts/routing.mdx' is '/concepts/routing', and an index is its folder.
const route = (p: string) => `/${p.replace(/\.mdx$/, '').replace(/(^|\/)index$/, '')}`.replace(/\/$/, '') || '/'
const routes = new Set(pages.map(route))
const front = (p: string) => {
  const m = read(new URL(p, content)).match(/^---\n([\s\S]*?)\n---/)
  assert.ok(m, `${p} has no frontmatter`)
  const field = (k: string) => {
    const v = m[1].match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1]
    return v === undefined ? undefined : v.startsWith('"') ? JSON.parse(v) : v
  }
  return { title: field('title'), description: field('description') }
}

test('every docs page has a title and a description that fits a search result', () => {
  assert.ok(pages.length >= 30, `only ${pages.length} pages`)
  for (const p of pages) {
    const { title, description } = front(p)
    assert.ok(title && title.length <= 60, `${p} title: ${title}`)
    assert.ok(description && description.length >= 100 && description.length <= 160, `${p} description is ${description?.length} characters`)
  }
})

test('titles and descriptions are unique', () => {
  const all = pages.map(front)
  assert.equal(new Set(all.map((f) => f.title)).size, all.length)
  assert.equal(new Set(all.map((f) => f.description)).size, all.length)
})

test('every sidebar entry names a page or folder that exists, and every page is listed', () => {
  const listed = new Set<string>()
  const walk = (dir: string) => {
    const meta = JSON.parse(read(new URL(`${dir}meta.json`, content)))
    for (const entry of meta.pages as string[]) {
      if (/^---.*---$/.test(entry)) continue
      const name = entry.replace(/^\.\.\./, '')
      const folder = new URL(`${dir}${name}/`, content)
      if (existsSync(folder)) { walk(`${dir}${name}/`); continue }
      assert.ok(existsSync(new URL(`${dir}${name}.mdx`, content)), `${dir}meta.json lists ${entry}`)
      listed.add(`${dir}${name}.mdx`)
    }
  }
  walk('')
  for (const p of pages) assert.ok(listed.has(p), `${p} is not in a meta.json`)
})

test('docs links and images resolve', () => {
  const images = [...read(new URL('docs-site/scripts/assets.mjs', root)).matchAll(/': '([^']+)'/g)].map((m) => m[1])
  for (const p of pages) {
    const text = read(new URL(p, content))
    for (const m of text.matchAll(/\]\((\/[^)\s#]*)(?:#[^)]*)?\)|href="(\/[^"#]*)/g)) {
      const href = m[1] ?? m[2]
      if (href.startsWith('/img/')) assert.ok(images.includes(href.slice(1)), `${p} shows ${href}, which scripts/assets.mjs does not copy`)
      else assert.ok(routes.has(href.replace(/\/$/, '') || '/'), `${p} links to ${href}`)
    }
  }
})

test('every image the docs show has a source file in the repository', () => {
  const src = read(new URL('docs-site/scripts/assets.mjs', root))
  for (const [, from] of src.matchAll(/'([^']+)': '[^']+'/g)) assert.ok(existsSync(new URL(from, root)), `${from} is missing`)
})

test('the site is a static export under /AutoMode/docs, and the pages workflow publishes it', () => {
  const config = read(new URL('docs-site/next.config.mjs', root))
  assert.match(config, /output: 'export'/)
  assert.match(config, /basePath: '\/AutoMode\/docs'/)
  assert.match(config, /trailingSlash: true/)
  const shared = read(new URL('docs-site/lib/shared.ts', root))
  assert.match(shared, /basePath = '\/AutoMode\/docs'/)
  const workflow = read(new URL('.github/workflows/pages.yml', root))
  assert.match(workflow, /cp -R out \.\.\/site\/docs/)
  assert.match(workflow, /'docs-site\/\*\*'/)
  assert.match(read(new URL('.github/workflows/test.yml', root)), /working-directory: docs-site/)
})
