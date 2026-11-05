// The marketing tools (marketing/tools): post checks, metrics snapshots and Buffer requests. It also checks every committed
// post and the registry, so a post with an unsourced number cannot merge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

import { LIMITS, check, evidence, figuresIn, parse } from '../marketing/tools/post.mts'
import { daysBetween, delta, gapWarning, snapshot } from '../marketing/tools/metrics.mts'
import { assetInput, assetUrl, createPostMutation, markQueued, queueProblems } from '../marketing/tools/buffer.mts'

const root = new URL('..', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, root), 'utf8')

const README = '# AutoMode\n\nSaves 99% says nobody.\n\n## Benchmarks\n\n| AutoMode | $2.01 | −51% |\n| Plain Opus | $4.14 | — |\n\n## Contribute\n\n$9.99\n'
const HEAD = { mixed: { opus: { shown: '$4.14' }, sonnet: { shown: '$2.14' } }, banned: ['We do not know yet'] }
const ev = evidence(README, HEAD)
const post = (body: string, meta = 'channel: x\nstatus: draft') => parse(`---\n${meta}\n---\n${body}\n`)

test('parse reads flat frontmatter, lists and thread parts', () => {
  const p = parse('---\nchannel: x\nstatus: "approved"\nassets: [site/public/video/a.mp4, b.png]\n---\nOne\n<!-- next -->\nTwo\n')
  assert.equal(p.meta.channel, 'x')
  assert.equal(p.meta.status, 'approved')
  assert.deepEqual(p.meta.assets, ['site/public/video/a.mp4', 'b.png'])
  assert.deepEqual(p.parts, ['One', 'Two'])
})

test('evidence takes figures from the benchmark section and the headline only', () => {
  assert.ok(ev.figures.has('$2.01') && ev.figures.has('51%') && ev.figures.has('$2.14'))
  assert.ok(!ev.figures.has('99%'), 'a figure above the section is not evidence')
  assert.ok(!ev.figures.has('$9.99'), 'a figure in the next section is not evidence')
})

test('figuresIn drops signs and thousands commas', () => {
  assert.deepEqual(figuresIn('−51% and +$1,200.50 and 45%'), ['51%', '$1200.50', '45%'])
})

test('a sourced post with the Sonnet high limit passes', () => {
  assert.deepEqual(check(post('Opus $4.14, AutoMode $2.01. On Sonnet high you save little.'), ev), [])
})

test('an unsourced number fails', () => {
  assert.match(check(post('AutoMode saves 70% on Sonnet.'), ev).join('\n'), /70% is not in the README/)
})

test('an Opus claim needs the Sonnet limit or a benchmark link', () => {
  assert.match(check(post('Half the cost of Opus.'), ev).join('\n'), /Sonnet high limit/)
  assert.deepEqual(check(post('Half the cost of Opus. https://mralexivy.github.io/AutoMode/benchmark/'), ev), [])
})

test('a banned stale claim fails', () => {
  assert.match(check(post('Does it save? We do not know yet.'), ev).join('\n'), /banned stale claim/)
})

test('each thread part must fit its channel, and channel and status must be known', () => {
  const long = 'a'.repeat(LIMITS.x + 1)
  assert.match(check(post(`short\n<!-- next -->\n${long}`), ev).join('\n'), /part 2 has 281 characters/)
  assert.match(check(post('hi', 'channel: fax\nstatus: maybe'), ev).join('\n'), /channel "fax"[\s\S]*status "maybe"/)
})

test('snapshot keeps counts and referrer domains, and sums release downloads', () => {
  const s = snapshot('2026-11-05', 'o/r', {
    repo: { stargazers_count: 8, forks_count: 0, subscribers_count: 1, open_issues_count: 4, owner: { login: 'secret' } },
    views: { count: 260, uniques: 25, views: [{ timestamp: '2026-11-04T00:00:00Z', count: 9, uniques: 3 }] },
    clones: { count: 10, uniques: 5 },
    referrers: [{ referrer: 'news.ycombinator.com', count: 5, uniques: 4 }],
    paths: [{ path: '/o/r', title: 'x', count: 3, uniques: 2 }],
    releases: [{ tag_name: 'v0.10.0', assets: [{ download_count: 7 }, { download_count: 3 }] }],
  })
  assert.equal(s.stars, 8)
  assert.deepEqual(s.views.days, [{ date: '2026-11-04', count: 9, uniques: 3 }])
  assert.deepEqual(s.release_downloads, [{ tag: 'v0.10.0', downloads: 10 }])
  assert.ok(!JSON.stringify(s).includes('secret'), 'no login reaches the snapshot')
  assert.match(delta({ ...s, stars: 5 }, s)[0], /stars 8 \(\+3\)/)
  assert.match(delta(null, s)[0], /stars 8 \(new\)/)
})

test('gapWarning fires only past 13 days', () => {
  assert.equal(daysBetween('2026-11-01', '2026-11-14'), 13)
  assert.equal(gapWarning('2026-11-01', '2026-11-14'), null)
  assert.match(gapWarning('2026-11-01', '2026-11-15'), /14 days old/)
  assert.equal(gapWarning(null, '2026-11-15'), null)
})

test('only an approved single post on a Buffer channel is queued', () => {
  assert.deepEqual(queueProblems(post('hi', 'channel: x\nstatus: approved')), [])
  assert.match(queueProblems(post('hi')).join('\n'), /Only an approved post/)
  assert.match(queueProblems(post('hi', 'channel: reddit\nstatus: approved')).join('\n'), /not one Buffer posts to/)
  assert.match(queueProblems(post('a\n<!-- next -->\nb', 'channel: x\nstatus: approved')).join('\n'), /thread/)
})

test('createPostMutation escapes the text and attaches site videos by URL', () => {
  const p = post('Say "hi"\nnow', 'channel: x\nstatus: approved\nassets: [site/public/video/benchmark-race.mp4]')
  const q = createPostMutation(p, 'ch1')
  assert.match(q, /text: "Say \\"hi\\"\\nnow"/)
  assert.match(q, /channelId: "ch1"/)
  assert.match(q, /mode: addToQueue/)
  assert.match(q, /video: \{ url: "https:\/\/mralexivy\.github\.io\/AutoMode\/video\/benchmark-race\.mp4" \}/)
  assert.equal(assetInput('site/public/og.png'), '{ image: { url: "https://mralexivy.github.io/AutoMode/og.png" } }')
  assert.throws(() => assetUrl('docs/readme/demo.gif'), /not a public URL/)
})

test('markQueued records the Buffer id', () => {
  assert.equal(markQueued('---\nchannel: x\nstatus: approved\n---\nhi\n', 'p9'), '---\nchannel: x\nstatus: queued\nbuffer_id: p9\n---\nhi\n')
})

test('every committed post passes its checks', () => {
  const dir = new URL('marketing/posts/', root)
  if (!existsSync(dir)) return
  const real = evidence(read('README.md'), JSON.parse(read('bench/results/headline.json')))
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    assert.deepEqual(check(parse(read(`marketing/posts/${f}`)), real), [], `marketing/posts/${f}`)
  }
})

test('the registry has unique ids and known statuses', () => {
  const reg = JSON.parse(read('marketing/registry.json'))
  const ids = reg.entries.map((e: any) => e.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate registry id')
  for (const e of reg.entries) assert.ok(reg.statuses.includes(e.status), `${e.id} has status ${e.status}`)
})
