// BigCodeBench and LiveCodeBench are function-level, so each item becomes a tiny repository with one hidden test. That
// lets the same evaluator run them. They run third-party test code, so these tasks need a sandboxed runner.
// LiveCodeBench's private tests are pickled, and unpickling runs code. This reads only the public JSON tests.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '../lib/task-repo.mts'

export interface RepoPlan { id: string; prompt: string; baseFiles: Record<string, string>; hiddenFile: string; hiddenText: string; solution?: Record<string, string>; accept: string; source: string; dataset: string; revision: string }

export function bigCodePlan(item: any, dataset: string, revision: string): RepoPlan {
  const id = `bcb-${String(item.task_id).replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`
  return {
    id, prompt: `${item.instruct_prompt}\n\nWrite the solution in solution.py.`, baseFiles: { 'solution.py': String(item.code_prompt ?? '') },
    hiddenFile: 'test_solution.py', hiddenText: `from solution import *\n${item.test}`, solution: { 'solution.py': `${item.code_prompt ?? ''}${item.canonical_solution ?? ''}` },
    accept: 'python3 -m unittest test_solution', source: 'bigcodebench', dataset, revision,
  }
}

interface PublicCase { input: string; output: string; testtype: 'stdin' | 'functional' }

export function liveCodeTest(cases: PublicCase[], starter: string) {
  const data = JSON.stringify(cases)
  if (cases.every((c) => c.testtype === 'stdin')) {
    return `import json, subprocess, sys\ncases = json.loads(${JSON.stringify(data)})\nfor c in cases:\n    r = subprocess.run([sys.executable, 'solution.py'], input=c['input'], capture_output=True, text=True, timeout=30)\n    assert r.stdout.strip() == c['output'].strip(), c['input'][:200]\n`
  }
  const method = /def\s+(\w+)\s*\(\s*self/.exec(starter)?.[1]
  if (!method) throw new Error('a functional case needs a method in its starter code')
  return `import json\nfrom solution import Solution\ncases = json.loads(${JSON.stringify(data)})\nfor c in cases:\n    args = [json.loads(line) for line in c['input'].split('\\n')]\n    assert getattr(Solution(), ${JSON.stringify(method)})(*args) == json.loads(c['output']), c['input'][:200]\n`
}

export function liveCodePlan(item: any, dataset: string, revision: string): RepoPlan {
  const cases: PublicCase[] = JSON.parse(item.public_test_cases)
  return {
    id: `lcb-${String(item.question_id).replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`, prompt: `${item.question_content}\n\nWrite the solution in solution.py.`, baseFiles: { 'solution.py': item.starter_code ?? '' },
    hiddenFile: 'test_solution.py', hiddenText: liveCodeTest(cases, item.starter_code ?? ''), accept: 'python3 test_solution.py', source: 'livecodebench', dataset, revision,
  }
}

const write = (dir: string, files: Record<string, string>) => { for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text) }

// materialize creates the repository, and returns a task whose reference commit adds the hidden test.
export function materialize(plan: RepoPlan, dir: string): Task {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  write(dir, plan.baseFiles)
  git('add', '-A'); git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  write(dir, { ...plan.solution, [plan.hiddenFile]: plan.hiddenText })
  git('add', '-A'); git('commit', '-q', '-m', 'reference')
  return {
    schema_version: 2, id: plan.id, cohort: 'diagnostic', repo: dir, license: 'dataset', base, reference: git('rev-parse', 'HEAD'), task: plan.prompt, hidden_tests: [plan.hiddenFile], accept: plan.accept,
    requirements: { sandbox: true, network: false, languages: ['python'] }, provenance: { source: plan.source, dataset: plan.dataset, dataset_version: plan.revision },
  }
}
