// GitHub metrics snapshots for marketing/metrics. GitHub keeps traffic for 14 days only, so a snapshot at least every 13
// days keeps the whole history. A snapshot holds counts and referrer domains only: no logins and no emails.
//
//   node marketing/tools/metrics.mts [--repo owner/name] [--dry-run]
//
// The functions at the top are pure. main() owns `gh` and the file system.

export type Snapshot = {
  date: string
  repo: string
  stars: number
  forks: number
  watchers: number
  open_issues: number
  views: { count: number, uniques: number, days: { date: string, count: number, uniques: number }[] }
  clones: { count: number, uniques: number }
  referrers: { referrer: string, count: number, uniques: number }[]
  paths: { path: string, count: number, uniques: number }[]
  release_downloads: { tag: string, downloads: number }[]
}

export const GAP_DAYS = 13
export const day = (iso: string) => iso.slice(0, 10)

// Builds a snapshot from the raw `gh api` responses.
export function snapshot(date: string, repo: string, raw: { repo: any, views: any, clones: any, referrers: any[], paths: any[], releases: any[] }): Snapshot {
  return {
    date,
    repo,
    stars: raw.repo.stargazers_count ?? 0,
    forks: raw.repo.forks_count ?? 0,
    watchers: raw.repo.subscribers_count ?? 0,
    open_issues: raw.repo.open_issues_count ?? 0,
    views: {
      count: raw.views.count ?? 0,
      uniques: raw.views.uniques ?? 0,
      days: (raw.views.views ?? []).map((v: any) => ({ date: day(v.timestamp), count: v.count, uniques: v.uniques })),
    },
    clones: { count: raw.clones.count ?? 0, uniques: raw.clones.uniques ?? 0 },
    referrers: raw.referrers.map((r) => ({ referrer: r.referrer, count: r.count, uniques: r.uniques })),
    paths: raw.paths.map((p) => ({ path: p.path, count: p.count, uniques: p.uniques })),
    release_downloads: raw.releases.map((r) => ({
      tag: r.tag_name,
      downloads: (r.assets ?? []).reduce((a: number, x: any) => a + (x.download_count ?? 0), 0),
    })),
  }
}

// Whole days between two YYYY-MM-DD dates.
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000)

// A warning when the last snapshot is older than GitHub's traffic window allows, or null.
export function gapWarning(previous: string | null, today: string): string | null {
  if (!previous) return null
  const gap = daysBetween(previous, today)
  return gap > GAP_DAYS ? `The last snapshot is ${gap} days old. GitHub keeps 14 days, so some daily views are lost.` : null
}

// One line per change since the previous snapshot.
export function delta(prev: Snapshot | null, now: Snapshot): string[] {
  const d = (k: 'stars' | 'forks' | 'watchers') => (prev ? `${now[k] - prev[k] >= 0 ? '+' : ''}${now[k] - prev[k]}` : 'new')
  const top = now.referrers.slice(0, 5).map((r) => `${r.referrer} ${r.uniques}`).join(', ') || 'none'
  return [
    `stars ${now.stars} (${d('stars')}), forks ${now.forks} (${d('forks')}), watchers ${now.watchers} (${d('watchers')})`,
    `14-day views ${now.views.count}, unique ${now.views.uniques}; clones ${now.clones.count}, unique ${now.clones.uniques}`,
    `top referrers by unique visitors: ${top}`,
  ]
}

async function main(args: string[]) {
  const { execFileSync } = await import('node:child_process')
  const { mkdirSync, readdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const i = args.indexOf('--repo')
  const repo = i >= 0 ? args[i + 1] : 'mralexivy/AutoMode'
  const api = (path: string) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))
  const today = day(new Date().toISOString())
  const snap = snapshot(today, repo, {
    repo: api(`repos/${repo}`),
    views: api(`repos/${repo}/traffic/views`),
    clones: api(`repos/${repo}/traffic/clones`),
    referrers: api(`repos/${repo}/traffic/popular/referrers`),
    paths: api(`repos/${repo}/traffic/popular/paths`),
    releases: api(`repos/${repo}/releases?per_page=100`),
  })
  const dir = new URL('../metrics/', import.meta.url)
  mkdirSync(dir, { recursive: true })
  const older = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `${today}.json`).sort()
  const last = older.at(-1)
  const prev: Snapshot | null = last ? JSON.parse(readFileSync(new URL(last, dir), 'utf8')) : null
  const warning = gapWarning(prev?.date ?? null, today)
  if (warning) console.warn(warning)
  for (const line of delta(prev, snap)) console.log(line)
  if (args.includes('--dry-run')) return
  writeFileSync(new URL(`${today}.json`, dir), `${JSON.stringify(snap, null, 2)}\n`)
  console.log(`wrote marketing/metrics/${today}.json`)
}

const { pathToFileURL } = await import('node:url')
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
