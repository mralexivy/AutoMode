// Post checks for marketing/posts. Pure: the caller passes the post text and the evidence, and gets a list of problems.
// A post may quote a dollar amount or a percentage only when the README benchmark section or bench/results/headline.json
// shows it. A claim against Opus must carry its limit. Each part must fit its channel.
//
//   node marketing/tools/post.mts [file...]      checks the files, or every post when none is named

// Character limits per part. A thread splits its parts with a line that holds only `<!-- next -->`.
export const LIMITS: Record<string, number> = {
  x: 280, bluesky: 300, linkedin: 3000, threads: 500, mastodon: 500, discord: 2000,
  reddit: 40000, hn: 4000, devto: 100000, hashnode: 100000, hackernoon: 100000, newsletter: 3000, listing: 1000,
}
export const STATUSES = ['draft', 'approved', 'queued', 'sent'] as const
export const NEXT = /^<!-- next -->$/m

export type Post = { meta: Record<string, string | string[]>, body: string, parts: string[] }
export type Evidence = { figures: Set<string>, banned: string[] }

// The frontmatter is flat: `key: value` lines, and `[a, b]` for a list.
export function parse(text: string): Post {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text.trim(), parts: [text.trim()] }
  const meta: Record<string, string | string[]> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    const v = kv[2].trim()
    meta[kv[1]] = v.startsWith('[') && v.endsWith(']')
      ? v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      : v.replace(/^["']|["']$/g, '')
  }
  const body = m[2].trim()
  return { meta, body, parts: body.split(NEXT).map((p) => p.trim()).filter(Boolean) }
}

// A figure in a canonical form: no sign, no thousands commas, and a trailing zero kept as written.
export const norm = (s: string) => s.replace(/^[−+-]/, '').replace(/,/g, '')
export const figuresIn = (text: string) => (text.match(/[−+-]?\$\d[\d,]*(\.\d+)?|[−+-]?\d+(\.\d+)?%/g) ?? []).map(norm)

// The figures a post may quote: every amount and percentage in the README benchmark section, and every headline value.
export function evidence(readme: string, headline: any): Evidence {
  const start = readme.indexOf('## Benchmarks')
  const end = readme.indexOf('\n## ', start + 1)
  const section = start < 0 ? '' : readme.slice(start, end < 0 ? undefined : end)
  const figures = new Set(figuresIn(section))
  for (const m of Object.values<any>(headline.mixed ?? {})) figures.add(norm(m.shown))
  return { figures, banned: headline.banned ?? [] }
}

// Problems with one post, as plain sentences. An empty list means the post may be approved.
export function check(post: Post, ev: Evidence): string[] {
  const out: string[] = []
  const channel = String(post.meta.channel ?? '')
  const status = String(post.meta.status ?? '')
  if (!(channel in LIMITS)) out.push(`channel "${channel}" is not one of ${Object.keys(LIMITS).join(', ')}`)
  if (!(STATUSES as readonly string[]).includes(status)) out.push(`status "${status}" is not one of ${STATUSES.join(', ')}`)
  if (!post.body) out.push('the post is empty')
  const limit = LIMITS[channel]
  post.parts.forEach((p, i) => {
    const n = [...p].length
    if (limit && n > limit) out.push(`part ${i + 1} has ${n} characters, over the ${channel} limit of ${limit}`)
  })
  for (const f of new Set(figuresIn(post.body))) {
    if (!ev.figures.has(f)) out.push(`${f} is not in the README benchmark section or bench/results/headline.json`)
  }
  for (const b of ev.banned) if (post.body.includes(b)) out.push(`it says "${b}", a banned stale claim`)
  // A saving against Opus is true for sessions that start on Opus. A reader on Sonnet high saves little, so say so.
  if (/opus/i.test(post.body) && (figuresIn(post.body).length > 0 || /\bhalf\b/i.test(post.body))
    && !/sonnet/i.test(post.body) && !/\/benchmark|#benchmarks|where automode does not win/i.test(post.body)) {
    out.push('it compares with Opus but neither names the Sonnet high limit nor links the benchmark')
  }
  return out
}

async function main(files: string[]) {
  const { readFileSync, readdirSync } = await import('node:fs')
  const root = new URL('../../', import.meta.url)
  const read = (p: string) => readFileSync(new URL(p, root), 'utf8')
  const ev = evidence(read('README.md'), JSON.parse(read('bench/results/headline.json')))
  const list = files.length ? files : readdirSync(new URL('marketing/posts/', root)).filter((f) => f.endsWith('.md')).map((f) => `marketing/posts/${f}`)
  let bad = 0
  for (const f of list) {
    const problems = check(parse(read(f)), ev)
    if (problems.length) bad++
    console.log(problems.length ? `FAIL ${f}\n${problems.map((p) => `  - ${p}`).join('\n')}` : `ok   ${f}`)
  }
  process.exitCode = bad ? 1 : 0
}

const { pathToFileURL } = await import('node:url')
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
