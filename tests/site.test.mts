// Pins the files search engines read on the project site.
// Search Console drops the property if the verification file goes away.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const SITE_URL = 'https://mralexivy.github.io/AutoMode/'
const VERIFICATION_FILE = 'googlef7b6ef980e80a74c.html'
const siteFile = (name: string) => new URL(`../site/${name}`, import.meta.url)
const read = (name: string) => readFileSync(siteFile(name), 'utf8')

const sitemapUrls = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
const fileFor = (url: string) => `${url.slice(SITE_URL.length)}index.html`
const htmlPages = readdirSync(siteFile(''), { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.html') && f !== '404.html' && f !== VERIFICATION_FILE)

test('the sitemap lists every page, and only real pages', () => {
  assert.deepEqual(sitemapUrls.map(fileFor).sort(), htmlPages.sort())
})

test('every sitemap entry has a W3C date', () => {
  const dates = [...read('sitemap.xml').matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1])
  assert.equal(dates.length, sitemapUrls.length)
  for (const d of dates) assert.match(d, /^\d{4}-\d{2}-\d{2}$/)
})

for (const url of sitemapUrls) {
  test(`${url} is ready for search`, () => {
    const html = read(fileFor(url))
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), 'canonical link')
    assert.equal(html.match(/<h1[ >]/g)?.length, 1, 'one h1')
    const title = html.match(/<title>(.*?)<\/title>/)?.[1] ?? ''
    assert.ok(title.length > 20 && title.length <= 65, `title length ${title.length}`)
    const description = html.match(/<meta name="description" content="(.*?)">/)?.[1] ?? ''
    assert.ok(description.length >= 100 && description.length <= 165, `description length ${description.length}`)
    assert.doesNotMatch(html, /name="robots"/)
    assert.ok(JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)?.[1] ?? 'null'), 'JSON-LD')
  })
}

test('internal links point at files that exist', () => {
  for (const file of htmlPages) {
    const dir = new URL(file, siteFile('')).href
    for (const [, href] of read(file).matchAll(/href="([^"#:]+\/)"/g)) {
      assert.ok(existsSync(new URL(`${href}index.html`, dir)), `${file} links to ${href}`)
    }
  }
})

test('the home page shows the ladder without JavaScript', () => {
  const html = read('index.html')
  assert.match(html, /<div id="rungs"><div class="rung">/)
  assert.match(html, /id="why">Security/)
})

test('the home page FAQ schema matches the visible questions', () => {
  const html = read('index.html')
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1])
  const faq = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'FAQPage')
  for (const q of faq.mainEntity) assert.ok(html.includes(`<h3>${q.name}</h3>`), q.name)
})

test('the deploy publishes the alternate sitemaps', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8')
  assert.ok(workflow.includes('cp site/sitemap.xml site/sitemap-pages.xml'))
  assert.ok(workflow.includes('> site/sitemap.txt'))
})

test('the 404 page stays out of the index', () => {
  assert.ok(read('404.html').includes('<meta name="robots" content="noindex">'))
})

test('the Search Console verification file stays in place', () => {
  assert.equal(read(VERIFICATION_FILE).trim(), `google-site-verification: ${VERIFICATION_FILE}`)
})

test('the IndexNow key file names its own key, as the deploy step expects', () => {
  const keyFiles = readdirSync(siteFile('')).filter((f) => f.endsWith('.txt'))
  assert.equal(keyFiles.length, 1)
  assert.match(keyFiles[0], /^[0-9a-f]{32}\.txt$/)
  assert.equal(read(keyFiles[0]), keyFiles[0].replace('.txt', ''))
})
