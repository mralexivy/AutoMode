// Pins the files Google reads on the project site.
// Search Console drops the property if the verification file goes away.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SITE_URL = 'https://mralexivy.github.io/AutoMode/'
const VERIFICATION_FILE = 'googlef7b6ef980e80a74c.html'
const read = (name: string) => readFileSync(new URL(`../site/${name}`, import.meta.url), 'utf8')

test('the home page names its canonical URL', () => {
  assert.ok(read('index.html').includes(`<link rel="canonical" href="${SITE_URL}">`))
})

test('the sitemap lists the home page', () => {
  assert.ok(read('sitemap.xml').includes(`<loc>${SITE_URL}</loc>`))
})

test('the Search Console verification file stays in place', () => {
  assert.equal(read(VERIFICATION_FILE).trim(), `google-site-verification: ${VERIFICATION_FILE}`)
})
