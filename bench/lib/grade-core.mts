// The blind grader's parts: what it reads and how a reply is parsed. bench/grade.mts schedules the calls.
import { execFileSync, spawn } from 'node:child_process'
import { billingEnv } from '../arms.mts'
import type { Task } from './task-repo.mts'

// A full id, because an alias can move to a newer model between two grading passes.
export const GRADER_MODEL = 'claude-sonnet-5-5'
const CAP = 40000

export const RUBRIC = `You grade one code change made by an AI coding agent for a task in a software repository.
You get the task, the reference change (what a senior engineer actually merged; its test files are left out), and the agent's change.
The reference is one good solution, not the only one: judge the agent's change on its own merits against the task.
Score each item from 1 (bad) to 5 (excellent):
- correctness: does it do what the task asks, without bugs?
- completeness: does it cover every requirement in the task?
- scope: does it change only what the task needs, with no unrelated edits?
- tests: does it add or update tests that would catch a regression of this change?
- maintainability: is it clear and consistent with the surrounding code?
Then list the concrete defects you found (at most 5, one line each, with the file), and compare with the reference: "better", "equal" or "worse".
Reply with JSON only: {"correctness":n,"completeness":n,"scope":n,"tests":n,"maintainability":n,"defects":["..."],"vs_reference":"better|equal|worse"}`

const clip = (s: string) => (s.length > CAP ? `${s.slice(0, CAP)}\n[... ${s.length - CAP} more characters cut]` : s)

// referenceDiff covers base..reference, which can be more than one commit.
export function referenceDiff(task: Task, repoDir: string) {
  return execFileSync('git', ['diff', task.base, task.reference, '--', '.', ...task.hidden_tests.map((t) => `:!${t}`)], { cwd: repoDir, encoding: 'utf8', maxBuffer: 1e8 })
}

export const gradePrompt = (taskText: string, reference: string, agent: string) =>
  `Task:\n${taskText}\n\nReference change:\n${clip(reference)}\n\nAgent's change:\n${agent.trim() ? clip(agent) : '(no change)'}`

export function grade(prompt: string, cwd: string) {
  return new Promise<{ reply: unknown; cost: number | null }>((resolve) => {
    const args = ['-p', prompt, '--model', GRADER_MODEL, '--system-prompt', RUBRIC, '--tools', '', '--output-format', 'json',
      '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence']
    const child = spawn('claude', args, { cwd, env: { ...billingEnv(), CLAUDE_CODE_USE_VERTEX: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let s = ''
    child.stdout.on('data', (d) => { s += d })
    child.on('close', () => { let j: any = {}; try { j = JSON.parse(s) } catch {} ; resolve({ reply: j.result ?? '', cost: j.total_cost_usd ?? null }) })
  })
}

export function parseGrade(reply: unknown): Record<string, any> | null {
  try {
    const j = JSON.parse(String(reply).match(/\{[\s\S]*\}/)[0])
    const keys = ['correctness', 'completeness', 'scope', 'tests', 'maintainability']
    if (!keys.every((k) => Number.isInteger(j[k]) && j[k] >= 1 && j[k] <= 5)) return null
    return { ...Object.fromEntries(keys.map((k) => [k, j[k]])), defects: (j.defects || []).slice(0, 5), vs_reference: j.vs_reference }
  } catch { return null }
}
