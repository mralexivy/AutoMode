// Policy B for replay and selection, run in a child node process. A git ref runs from a pinned worktree in a
// temporary folder, a module from its path. Code from another ref is never imported into the calling process.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BatchPolicy } from './route-replay.mts'

const REPLAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'route-replay.mts')

function child(script: string, cwd: string, extra: string[]): BatchPolicy {
  return (inputs) => {
    const r = spawnSync(process.execPath, [script, '--serve', ...extra], { cwd, input: JSON.stringify(inputs), maxBuffer: 1 << 30, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`policy B failed: ${(r.stderr || '').slice(-800)}`)
    return JSON.parse(r.stdout)
  }
}

export interface PolicyB { batch: BatchPolicy; label: string; cleanup: () => void }

// policyB: exactly one of a git ref or a module path. Throws with a plain message when it cannot run.
export function policyB(o: { ref?: string; module?: string }): PolicyB {
  if (!o.ref === !o.module) throw new Error('policy B needs exactly one of --policy <git-ref> or --policy-module <path>')
  if (o.module) return { batch: child(REPLAY, process.cwd(), ['--module', path.resolve(o.module)]), label: `module ${o.module}`, cleanup: () => {} }
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(REPLAY), encoding: 'utf8' }).stdout.trim()
  const sha = spawnSync('git', ['rev-parse', '--verify', `${o.ref}^{commit}`], { cwd: root, encoding: 'utf8' }).stdout.trim()
  if (!sha) throw new Error(`unknown git ref: ${o.ref}`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-replay-'))
  const add = spawnSync('git', ['worktree', 'add', '--detach', dir, sha], { cwd: root, encoding: 'utf8' })
  if (add.status !== 0) throw new Error(add.stderr)
  const cleanup = () => { spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root }) }
  const script = path.join(dir, 'bench', 'route-replay.mts')
  if (!fs.existsSync(script)) { cleanup(); throw new Error(`${o.ref} (${sha.slice(0, 8)}) has no bench/route-replay.mts, so it cannot replay route inputs`) }
  return { batch: child(script, dir, []), label: `${o.ref} at ${sha.slice(0, 12)}`, cleanup }
}
