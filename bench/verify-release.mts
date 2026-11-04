#!/usr/bin/env node
// verify-release.mts <git-ref> <results.jsonl> [--arm auto]
// Proves that a published version is the code a benchmark measured. Every result row stores the hash of the behavior
// files its arm ran (identity.code, lib/identity.mts). This recomputes that hash from the files at <git-ref>, a release
// tag such as v0.9.0, and checks it against the rows. No model call. Exit 0 when every row of the arm matches.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { behaviorFiles, filesHash } from './lib/identity.mts'
import { readRows } from './lib/plan.mts'

export function codeAt(ref: string, repo = process.cwd()): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-verify-'))
  try {
    // A clean export of the ref: what a person installs from the tag, nothing from the working tree.
    const tar = execFileSync('git', ['archive', '--format=tar', ref], { cwd: repo, maxBuffer: 1e9 })
    execFileSync('tar', ['-x', '-C', dir], { input: tar })
    return filesHash(behaviorFiles(dir))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [ref, file] = process.argv.slice(2)
  const ai = process.argv.indexOf('--arm')
  const arm = ai > 0 ? process.argv[ai + 1] : 'auto'
  if (!ref || !file) { console.error('usage: verify-release.mts <git-ref> <results.jsonl> [--arm auto]'); process.exit(1) }
  const code = codeAt(ref)
  const rows = readRows(file).filter((r) => r.arm === arm && !r.reused_from && r.identity)
  const match = rows.filter((r) => r.identity.code === code).length
  console.log(`${ref}: behavior code ${code}. ${match} of ${rows.length} ${arm} rows in ${path.basename(file)} ran exactly this code.`)
  process.exit(rows.length && match === rows.length ? 0 : 1)
}
