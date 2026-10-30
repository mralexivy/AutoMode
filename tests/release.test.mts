// The release tools (tools/release.mts): the decision, the file rewrites and the PR rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  BUNDLE, DIRECTORY, SHIPPED, bumpFor, compareVersions, decide, finishBundle, isDocs, isShipped, nextVersion, prNumbers, releaseNotes,
  releaseVersionOf, rewriteChangelog, rewritePlugin, rewriteReadme, ruleErrors, sectionBody,
  type Facts, type PullRequest,
} from '../tools/release.mts'

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed

- A fix.

## [0.1.2] - 2026-10-30

### Added

- A feature.

## [0.1.1] - 2026-10-30
`

const facts = (over: Partial<Facts> = {}): Facts => ({
  version: '0.1.2', tagged: true, headSubject: 'Fix the bar (#7)', unreleased: '### Fixed\n\n- A fix.',
  shippedChanged: true, manual: false, bump: 'auto', dryRun: false, ...over,
})

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  branch: 'feature/release-flow', fork: false, body: 'Closes #6', labels: [], files: ['README.md'],
  baseChangelog: '## [Unreleased]\n', headChangelog: '## [Unreleased]\n', baseVersion: '0.1.2', headVersion: '0.1.2', ...over,
})

test('sectionBody reads one section and stops at the next', () => {
  assert.equal(sectionBody(CHANGELOG, 'Unreleased'), '### Fixed\n\n- A fix.')
  assert.equal(sectionBody(CHANGELOG, '0.1.2'), '### Added\n\n- A feature.')
  assert.equal(sectionBody(CHANGELOG, '9.9.9'), '')
})

test('the changelog headings choose the bump', () => {
  assert.equal(bumpFor('### Fixed\n\n- x'), 'patch')
  assert.equal(bumpFor('### Security\n\n- x'), 'patch')
  for (const heading of ['Added', 'Changed', 'Removed', 'Deprecated']) assert.equal(bumpFor(`### ${heading}\n\n- x`), 'minor')
  assert.equal(bumpFor('### Fixed\n\n- x\n\n### Added\n\n- y'), 'minor')
})

test('nextVersion resets the lower parts', () => {
  assert.equal(nextVersion('0.1.2', 'patch'), '0.1.3')
  assert.equal(nextVersion('0.1.2', 'minor'), '0.2.0')
  assert.equal(nextVersion('0.1.2', 'major'), '1.0.0')
})

test('versions sort as numbers, not as text', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
})

test('a release subject matches with or without the squash suffix', () => {
  assert.equal(releaseVersionOf('Release 0.2.0'), '0.2.0')
  assert.equal(releaseVersionOf('Release 0.2.0 (#12)'), '0.2.0')
  assert.equal(releaseVersionOf('Release the bar'), null)
})

test('a fix on a tagged version opens a release PR for the next patch', () => {
  assert.deepEqual(decide(facts()), { state: 'pending', version: '0.1.3' })
})

test('a docs-only change waits, and an empty [Unreleased] stops', () => {
  assert.equal(decide(facts({ shippedChanged: false })).state, 'none')
  assert.equal(decide(facts({ unreleased: '' })).state, 'none')
})

test('an untagged version ships from a release commit or a manual run, and nothing else', () => {
  const untagged = { tagged: false, unreleased: '' }
  assert.equal(decide(facts(untagged)).state, 'none')
  assert.equal(decide(facts({ ...untagged, headSubject: 'Release 0.1.2 (#9)' })).state, 'ship')
  assert.equal(decide(facts({ ...untagged, headSubject: 'Release 0.1.1 (#9)' })).state, 'none')
  assert.equal(decide(facts({ ...untagged, manual: true })).state, 'ship')
})

test('a tagged version never ships again, even from a release commit', () => {
  assert.equal(decide(facts({ headSubject: 'Release 0.1.2 (#9)', unreleased: '' })).state, 'none')
})

test('a manual bump overrides the rule and the docs-only wait', () => {
  assert.deepEqual(decide(facts({ manual: true, bump: 'major', shippedChanged: false })), { state: 'pending', version: '1.0.0' })
})

test('a dry run always takes the ship path with the current version', () => {
  assert.deepEqual(decide(facts({ dryRun: true })), { state: 'ship', version: '0.1.2' })
})

test('the changelog rewrite keeps the entries and leaves [Unreleased] empty', () => {
  const next = rewriteChangelog(CHANGELOG, '0.1.3', '2026-11-01')
  assert.equal(sectionBody(next, 'Unreleased'), '')
  assert.equal(sectionBody(next, '0.1.3'), '### Fixed\n\n- A fix.')
  assert.ok(next.includes('## [0.1.3] - 2026-11-01\n'))
  assert.equal(sectionBody(next, '0.1.2'), '### Added\n\n- A feature.')
})

test('the plugin rewrite changes only the version and keeps the formatting', () => {
  const before = readFileSync('.claude-plugin/plugin.json', 'utf8')
  const after = rewritePlugin(before, '9.9.9')
  assert.equal(JSON.parse(after).version, '9.9.9')
  assert.equal(after.replace('9.9.9', ''), before.replace(/"version": "[^"]+"/, '"version": ""'))
})

test('the README rewrite finds the badge and the tested line in the real file', () => {
  const after = rewriteReadme(readFileSync('README.md', 'utf8'), '9.9.9', '2.3.4')
  assert.ok(after.includes('alt="Version 9.9.9"'))
  assert.ok(after.includes('/badge/version-9.9.9-fbbf24'))
  assert.ok(after.includes('Tested with Claude Code 2.3.4.'))
})

test('the notes hold the section, the tested version and the verify command', () => {
  const notes = releaseNotes(CHANGELOG, '0.1.2', '2.3.4', 'mralexivy/AutoMode')
  assert.ok(notes.startsWith('### Added'))
  assert.ok(notes.includes('Tested with Claude Code 2.3.4.'))
  assert.ok(notes.includes('gh attestation verify automode-0.1.2.zip --repo mralexivy/AutoMode'))
  assert.throws(() => releaseNotes(CHANGELOG, '9.9.9', '2.3.4', 'x/y'))
})

test('shipped paths cover the mod, and tooling is not shipped', () => {
  for (const path of ['hooks/v4.ts', 'agents/verifier.md', 'commands/usage.md', 'config.json', '.claude-plugin/plugin.json']) {
    assert.ok(isShipped(path), path)
  }
  for (const path of ['tools/release.mts', 'tests/x.test.mts', 'bench/run.mts', 'README.md', '.claude-plugin/marketplace.json', 'hooks-old/x']) {
    assert.ok(!isShipped(path), path)
  }
})

test('every shipped path is in the bundle, and the bundle holds no tests or bench', () => {
  for (const path of SHIPPED) assert.ok(BUNDLE.includes(path), path)
  assert.ok(!BUNDLE.some(p => /^(tests|bench|tools|docs|\.github|\.claude)(\/|$)/.test(p)))
})

test('docs-only means root Markdown, docs and brand, never the Markdown of the mod', () => {
  for (const path of ['README.md', 'CHANGELOG.md', 'docs/compare.md', 'brand/logo.svg']) assert.ok(isDocs(path), path)
  for (const path of ['agents/verifier.md', 'commands/usage.md', 'output-styles/Concise.md', 'bench/x.md']) assert.ok(!isDocs(path), path)
})

test('a good PR passes', () => {
  assert.deepEqual(ruleErrors(pr()), [])
  assert.deepEqual(ruleErrors(pr({ branch: 'fix/bar-width', body: 'Fixes #3' })), [])
})

test('a branch must be <type>/<short-name>', () => {
  for (const branch of ['6-long-name', 'release-flow', 'feature/', 'Feature/x', 'wip/x']) {
    assert.equal(ruleErrors(pr({ branch })).length, 1, branch)
  }
})

test('a fork keeps its own branch name but must still link an issue', () => {
  assert.deepEqual(ruleErrors(pr({ branch: 'patch-1', fork: true })), [])
  assert.equal(ruleErrors(pr({ branch: 'patch-1', fork: true, body: '' })).length, 1)
})

test('the issue link must be real, not a blank template line or a comment', () => {
  assert.equal(ruleErrors(pr({ body: 'Closes #' })).length, 1)
  assert.equal(ruleErrors(pr({ body: '<!-- Closes #6 -->' })).length, 1)
})

test('a PR may not raise the version, except the release PR', () => {
  assert.equal(ruleErrors(pr({ headVersion: '0.1.3' })).length, 1)
  assert.deepEqual(ruleErrors(pr({ branch: 'release/next', body: '', headVersion: '0.1.3', files: ['hooks/v4.ts'] })), [])
})

test('a change to the mod needs a new changelog line, unless labelled', () => {
  const files = ['hooks/v4.ts']
  assert.equal(ruleErrors(pr({ files })).length, 1)
  assert.deepEqual(ruleErrors(pr({ files, labels: ['no-changelog'] })), [])
  assert.deepEqual(ruleErrors(pr({ files, headChangelog: '## [Unreleased]\n\n### Fixed\n\n- New.\n' })), [])
})

test('an existing changelog line does not count as new', () => {
  const log = '## [Unreleased]\n\n- Old.\n'
  assert.equal(ruleErrors(pr({ files: ['hooks/v4.ts'], baseChangelog: log, headChangelog: log })).length, 1)
})

test('dependabot branches are exempt from the name and the issue link', () => {
  assert.deepEqual(ruleErrors(pr({ branch: 'dependabot/npm_and_yarn/typescript-7', body: '' })), [])
})

test('prNumbers reads squash and merge subjects, skips release commits, and drops repeats', () => {
  const subjects = ['Fix the bar (#7)', 'Release 0.2.0 (#8)', 'Merge pull request #5 from x/y', 'Tune it', 'Again (#7)']
  assert.deepEqual(prNumbers(subjects), [7, 5])
})

test('the directory tree holds what users run and leaves out the dev files', () => {
  for (const path of BUNDLE) assert.ok(DIRECTORY.includes(path), path)
  for (const path of ['PRIVACY.md', 'docs/readme']) assert.ok(DIRECTORY.includes(path), path)
  for (const path of ['bench', 'tests', 'tools', 'site', 'package.json', 'package-lock.json']) assert.ok(!DIRECTORY.includes(path), path)
})

test('the bundle exports register where it is declared, and nothing else', () => {
  const out = finishBundle('var other = 1;\nvar register = (on, options) => {};\nexport {\n  other,\n  register\n};\n', 'abc')
  assert.match(out, /^export const register = /m)
  assert.doesNotMatch(out, /export \{/)
  assert.match(out, /commit abc/)
  assert.throws(() => finishBundle('var other = 1;\n', 'abc'))
})
