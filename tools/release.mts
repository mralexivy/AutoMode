// Release tools. The workflows in .github/workflows call this file, and `npm run build` runs it by hand.
// The functions at the top are pure, so tests/release.test.mts can pin them. The commands at the bottom own git and the
// file system. This file is a dev tool and stays out of the bundle.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// A change under these paths reaches users, so it needs a release.
export const SHIPPED = [
  '.claude-plugin/plugin.json', '.claude-plugin/icon.png', 'agents', 'commands', 'hooks', 'output-styles', 'scripts',
  'types', 'workflows', 'config.json',
]
export const BUNDLE = [...SHIPPED, 'LICENSE', 'README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md']
// The tree on the `directory` branch, which the Anthropic directory reads. It holds what users run and what the listing
// shows, and leaves out bench/, tests/ and the lockfile, which nothing in the mod runs.
export const DIRECTORY = [...BUNDLE, 'PRIVACY.md', 'SECURITY.md', 'docs/readme']

export type Bump = 'patch' | 'minor' | 'major'
export type State = 'none' | 'pending' | 'ship'

const RELEASE_BRANCH = 'release/next'
const BRANCH_NAME = /^(feature|fix|docs|chore|refactor|test|bench)\/[a-z0-9][a-z0-9.-]*$/
const EXEMPT_BRANCH = (branch: string) => branch === RELEASE_BRANCH || branch.startsWith('dependabot/')
const CLOSES_ISSUE = /\b(closes|fixes|resolves)\s+#\d+/i
// A squash merge adds the PR number to the title.
const RELEASE_SUBJECT = /^Release (\d+\.\d+\.\d+)(?: \(#\d+\))?$/

export const isShipped = (path: string) => SHIPPED.some(p => path === p || path.startsWith(`${p}/`))

// Root Markdown, docs/ and brand/ only. Markdown under agents/, commands/ and output-styles/ is the mod.
export const isDocs = (path: string) => /^[^/]+\.md$/.test(path) || path.startsWith('docs/') || path.startsWith('brand/')

export function sectionBody(changelog: string, heading: string): string {
  const lines = changelog.split('\n')
  const start = lines.findIndex(l => l === `## [${heading}]` || l.startsWith(`## [${heading}] `))
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => l.startsWith('## ['))
  return rest.slice(0, end < 0 ? undefined : end).join('\n').trim()
}

// Removed, Changed, Added and Deprecated change what a user sees, so they raise the minor version.
// Major stays a choice a person makes.
export function bumpFor(unreleased: string): Bump {
  return /^### (Removed|Changed|Added|Deprecated)\b/m.test(unreleased) ? 'minor' : 'patch'
}

export function nextVersion(version: string, bump: Bump): string {
  const [major, minor, patch] = version.split('.').map(Number)
  if (bump === 'major') return `${major + 1}.0.0`
  return bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map(v => v.split('.').map(Number))
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

export const releaseVersionOf = (subject: string) => RELEASE_SUBJECT.exec(subject)?.[1] ?? null

export interface Facts {
  version: string
  tagged: boolean
  headSubject: string
  unreleased: string
  shippedChanged: boolean
  manual: boolean
  bump: 'auto' | Bump
  dryRun: boolean
}

export function decide(f: Facts): { state: State; version: string } {
  if (f.dryRun) return { state: 'ship', version: f.version }
  // An untagged version ships only from a merged release PR or a person's manual run.
  if (!f.tagged) {
    const ship = f.manual || releaseVersionOf(f.headSubject) === f.version
    return { state: ship ? 'ship' : 'none', version: f.version }
  }
  if (!f.unreleased) return { state: 'none', version: f.version }
  const forced = f.manual && f.bump !== 'auto'
  if (!f.shippedChanged && !forced) return { state: 'none', version: f.version }
  const bump = f.bump === 'auto' ? bumpFor(f.unreleased) : f.bump
  return { state: 'pending', version: nextVersion(f.version, bump) }
}

export function rewriteChangelog(changelog: string, version: string, date: string): string {
  if (!changelog.includes('## [Unreleased]\n')) throw new Error('CHANGELOG.md has no [Unreleased] heading')
  return changelog.replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - ${date}\n`)
}

export function rewritePlugin(plugin: string, version: string): string {
  return plugin.replace(/"version": "[^"]+"/, `"version": "${version}"`)
}

export function rewriteReadme(readme: string, version: string, tested: string): string {
  return readme
    .replace(/alt="Version [^"]+" src="([^"]*\/badge\/version-)[^-"]+-/, `alt="Version ${version}" src="$1${version}-`)
    .replace(/Tested with Claude Code [\d.]*\d/, `Tested with Claude Code ${tested}`)
}

export function releaseNotes(changelog: string, version: string, tested: string, repo: string): string {
  const body = sectionBody(changelog, version)
  if (!body) throw new Error(`CHANGELOG.md has no section for ${version}`)
  return `${body}

## Install

\`\`\`
claude plugin marketplace add ${repo}
claude plugin install automode@automode
\`\`\`

To update, run \`claude plugin marketplace update automode\` and then \`claude plugin update automode@automode\`.

Tested with Claude Code ${tested}.

## Verify the bundle

\`\`\`
sha256sum --check SHA256SUMS
gh attestation verify automode-${version}.zip --repo ${repo}
\`\`\`
`
}

export interface PullRequest {
  branch: string
  fork: boolean
  body: string
  labels: string[]
  files: string[]
  baseChangelog: string
  headChangelog: string
  baseVersion: string
  headVersion: string
}

export function ruleErrors(pr: PullRequest): string[] {
  const errors: string[] = []
  const exempt = EXEMPT_BRANCH(pr.branch)
  if (!pr.fork && !exempt && !BRANCH_NAME.test(pr.branch)) {
    errors.push(`Branch "${pr.branch}" must be <type>/<short-name>, such as feature/release-flow. See CONTRIBUTING.md.`)
  }
  const body = pr.body.replace(/<!--[\s\S]*?-->/g, '')
  if (!exempt && !CLOSES_ISSUE.test(body)) errors.push('The PR body needs "Closes #N". Open an issue first.')
  if (pr.branch === RELEASE_BRANCH) return errors
  if (pr.baseVersion !== pr.headVersion) {
    errors.push('Do not change "version" in plugin.json. The release PR raises it.')
  }
  if (pr.files.some(isShipped) && !pr.labels.includes('no-changelog')) {
    const before = new Set(sectionBody(pr.baseChangelog, 'Unreleased').split('\n'))
    const added = sectionBody(pr.headChangelog, 'Unreleased').split('\n').some(l => l.startsWith('- ') && !before.has(l))
    if (!added) errors.push('This changes the mod. Add a line under [Unreleased] in CHANGELOG.md.')
  }
  return errors
}

// Squash merges end in "(#N)". Older merge commits start with "Merge pull request #N".
export function prNumbers(subjects: string[]): number[] {
  const numbers = subjects
    .filter(s => !releaseVersionOf(s))
    .map(s => /\(#(\d+)\)$/.exec(s)?.[1] ?? /^Merge pull request #(\d+)/.exec(s)?.[1])
    .filter(Boolean)
    .map(Number)
  return [...new Set(numbers)]
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const read = (path: string) => readFileSync(path, 'utf8')
const lines = (text: string) => text.split('\n').filter(Boolean)
const currentVersion = (plugin = read('.claude-plugin/plugin.json')) => JSON.parse(plugin).version as string
const output = (name: string, value: string) => {
  console.log(`${name}=${value}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}
const tags = () => lines(git('tag', '--list', 'v*.*.*')).map(t => t.slice(1)).sort(compareVersions)
const showAt = (ref: string, path: string) => git('show', `${ref}:${path}`)

function commandPlan() {
  const version = currentVersion()
  const all = tags()
  const last = all.at(-1)
  const changed = last ? lines(git('diff', '--name-only', `v${last}`, 'HEAD')) : []
  const decision = decide({
    version,
    tagged: all.includes(version),
    headSubject: git('log', '-1', '--format=%s'),
    unreleased: sectionBody(read('CHANGELOG.md'), 'Unreleased'),
    shippedChanged: changed.some(isShipped),
    manual: process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
    bump: (process.env.BUMP || 'auto') as Facts['bump'],
    dryRun: process.env.DRY_RUN === 'true',
  })
  output('state', decision.state)
  output('version', decision.version)
}

function commandPrepare(version: string, tested: string) {
  const date = new Date().toISOString().slice(0, 10)
  writeFileSync('CHANGELOG.md', rewriteChangelog(read('CHANGELOG.md'), version, date))
  writeFileSync('.claude-plugin/plugin.json', rewritePlugin(read('.claude-plugin/plugin.json'), version))
  writeFileSync('README.md', rewriteReadme(read('README.md'), version, tested))
}

// git archive stamps the commit time on every entry, so one commit always gives the same zip.
function commandBuild() {
  const version = currentVersion()
  mkdirSync('dist', { recursive: true })
  const name = `automode-${version}.zip`
  const zip = join('dist', name)
  git('archive', '--format=zip', `--prefix=automode-${version}/`, '-o', zip, 'HEAD', '--', ...BUNDLE)
  const sum = createHash('sha256').update(readFileSync(zip)).digest('hex')
  writeFileSync(join('dist', 'SHA256SUMS'), `${sum}  ${name}\n`)
  console.log(`${zip} ${sum}`)

  const scratch = mkdtempSync(join(tmpdir(), 'automode-bundle-'))
  try {
    execFileSync('unzip', ['-q', zip, '-d', scratch], { stdio: 'inherit' })
    execFileSync('claude', ['plugin', 'validate', join(scratch, basename(zip, '.zip')), '--strict'], { stdio: 'inherit' })
  } catch (e) {
    if (e.code !== 'ENOENT' || process.env.CI) throw e
    console.log('Claude Code is not installed, so the bundle was not validated.')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// commandDirectory publishes DIRECTORY as one commit on the `directory` branch. It writes the tree through a temporary
// index, so the work tree stays as it is. It never force-pushes: the new commit sits on top of the branch.
function commandDirectory(version: string) {
  const index = join(mkdtempSync(join(tmpdir(), 'automode-index-')), 'index')
  const env = { ...process.env, GIT_INDEX_FILE: index }
  const entries = git('ls-tree', '-r', '--full-tree', 'HEAD', '--', ...DIRECTORY)
  execFileSync('git', ['update-index', '--add', '--index-info'], { input: `${entries}\n`, env })
  const tree = execFileSync('git', ['write-tree'], { env, encoding: 'utf8' }).trim()
  let parent: string[] = []
  try { parent = ['-p', git('rev-parse', '--verify', 'origin/directory')] } catch {}
  const commit = git('commit-tree', tree, ...parent, '-m', `Directory tree for ${version}`)
  git('push', 'origin', `${commit}:refs/heads/directory`)
}

function commandScope() {
  const { BASE_SHA: base, HEAD_REF: ref } = process.env
  // The release gate tests a release commit, so its push does not test it again.
  const release = ref === 'refs/heads/main' && releaseVersionOf(git('log', '-1', '--format=%s'))
  const empty = !base || /^0+$/.test(base)
  const docsOnly = !empty && lines(git('diff', '--name-only', `${base}...HEAD`)).every(isDocs)
  output('code', String(!release && !docsOnly))
}

function commandRules() {
  const { BASE_SHA: base, PR_BRANCH: branch, PR_BODY: body, PR_FORK: fork, PR_LABELS: labels } = process.env
  const mergeBase = git('merge-base', base, 'HEAD')
  const errors = ruleErrors({
    branch,
    fork: fork === 'true',
    body: body ?? '',
    labels: JSON.parse(labels || '[]'),
    files: lines(git('diff', '--name-only', mergeBase, 'HEAD')),
    baseChangelog: showAt(mergeBase, 'CHANGELOG.md'),
    headChangelog: read('CHANGELOG.md'),
    baseVersion: currentVersion(showAt(mergeBase, '.claude-plugin/plugin.json')),
    headVersion: currentVersion(),
  })
  for (const error of errors) console.log(`::error::${error}`)
  if (errors.length) process.exit(1)
  console.log('ok')
}

function commandPrs(version: string) {
  const previous = tags().filter(t => compareVersions(t, version) < 0).at(-1)
  const range = previous ? `v${previous}..HEAD` : 'HEAD'
  console.log(prNumbers(lines(git('log', '--format=%s', range))).join('\n'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2)
  const commands = {
    plan: commandPlan,
    prepare: () => commandPrepare(args[0], args[1]),
    build: commandBuild,
    directory: () => commandDirectory(args[0]),
    scope: commandScope,
    rules: commandRules,
    section: () => console.log(sectionBody(read('CHANGELOG.md'), args[0])),
    notes: () => console.log(releaseNotes(read('CHANGELOG.md'), args[0], args[1], args[2])),
    prs: () => commandPrs(args[0]),
  }
  if (!commands[command]) {
    console.error(`Usage: node tools/release.mts <${Object.keys(commands).join('|')}>`)
    process.exit(2)
  }
  commands[command]()
}
