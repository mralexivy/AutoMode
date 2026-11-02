// Pure logic for bench/split.mts. No I/O.
// The held-out split assigns each candidate task to the `screen` set or the `confirm` set before any run. The rule uses
// only the task id and its repository, so anyone can recompute it, and no result can move a task.
import { sha256 } from './prompt.mts'

export interface Candidate { id: string; repo: string }
export interface Split { screen: string[]; confirm: string[]; excluded: string[] }

export const MAX_PER_REPO = 3
export const RULE =
  'Sort candidate ids by the SHA-256 of the id, ascending. Walk the list. A task at an even position (0, 2, 4, ...) goes to ' +
  'screen, at an odd position to confirm. If that set already holds 3 tasks from the same repository, the task goes to ' +
  'the other set. If both sets are full for that repository, the task is excluded.'

export const rankBySha = (ids: string[]) => [...ids].sort((a, b) => (sha256(a) < sha256(b) ? -1 : sha256(a) > sha256(b) ? 1 : 0))

export function splitHeldout(cands: Candidate[], maxPerRepo = MAX_PER_REPO): Split {
  const repoOf = new Map(cands.map((c) => [c.id, c.repo]))
  const out: Split = { screen: [], confirm: [], excluded: [] }
  const count = { screen: new Map<string, number>(), confirm: new Map<string, number>() }
  rankBySha([...repoOf.keys()]).forEach((id, i) => {
    const repo = repoOf.get(id)
    const first = i % 2 === 0 ? 'screen' : 'confirm'
    const second = first === 'screen' ? 'confirm' : 'screen'
    const set = [first, second].find((s) => (count[s].get(repo) ?? 0) < maxPerRepo)
    if (!set) { out.excluded.push(id); return }
    count[set].set(repo, (count[set].get(repo) ?? 0) + 1)
    out[set].push(id)
  })
  return out
}
