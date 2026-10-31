// The tools every model gets, with the same names and text, so no vendor gets a better interface. File tools stay inside
// the workspace, and a path that leaves it through `..` or a symlink is refused.
import fs from 'node:fs'
import path from 'node:path'
import { canonical } from '../lib/experiment.mts'
import { sha256 } from '../lib/prompt.mts'
import type { CanonicalTool, ToolCall } from '../providers/provider.mts'
import type { Sandbox } from './sandbox.mts'

const string = (description: string) => ({ type: 'string', description })
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })

export const TOOLS: CanonicalTool[] = [
  { name: 'shell', description: 'Run a shell command in /workspace and return its exit code and output. No network.', parameters: object({ command: string('The command.') }) },
  { name: 'read_file', description: 'Read a text file.', parameters: object({ path: string('Path relative to the workspace.') }) },
  { name: 'write_file', description: 'Create or replace a text file.', parameters: object({ path: string('Path relative to the workspace.'), content: string('The whole new file.') }) },
  { name: 'replace_text', description: 'Replace one exact, unique piece of text in a file.', parameters: object({ path: string('Path relative to the workspace.'), old_text: string('Text that occurs exactly once.'), new_text: string('The replacement.') }) },
  { name: 'list_files', description: 'List files under a folder, skipping .git and node_modules.', parameters: object({ path: string('Folder relative to the workspace. Use . for the root.') }) },
]
export const toolSchemaSha256 = () => sha256(canonical(TOOLS))

const OUTPUT_CAP = 20_000
const LIST_CAP = 2000
export function clip(s: string) {
  return s.length <= OUTPUT_CAP ? s : `${s.slice(0, OUTPUT_CAP / 2)}\n[... ${s.length - OUTPUT_CAP} characters cut ...]\n${s.slice(-OUTPUT_CAP / 2)}`
}

// inside resolves a model's path, or throws. It checks the real path of the nearest existing parent.
export function inside(workspace: string, rel: unknown) {
  if (typeof rel !== 'string' || !rel) throw new Error('path is required')
  const root = fs.realpathSync(workspace)
  const target = path.resolve(root, rel.replace(/^\/workspace\/?/, ''))
  let existing = target
  while (!fs.existsSync(existing) && existing !== root) existing = path.dirname(existing)
  const real = fs.realpathSync(existing)
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('path is outside the workspace')
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('path is outside the workspace')
  return target
}

export interface ToolResult { text: string; failed: boolean }

export async function runTool(call: ToolCall, workspace: string, sandbox: Sandbox, shellTimeoutMs: number): Promise<ToolResult> {
  const a = call.args
  try {
    if (a._bad_arguments !== undefined) throw new Error('the arguments were not valid JSON')
    if (call.name === 'shell') {
      if (typeof a.command !== 'string' || !a.command) throw new Error('command is required')
      const r = await sandbox.exec(a.command, { timeoutMs: shellTimeoutMs })
      return { text: clip(`exit code: ${r.timedOut ? 'timed out' : r.status}\n${r.stdout}${r.stderr}`), failed: r.status !== 0 }
    }
    const p = inside(workspace, a.path)
    if (call.name === 'read_file') return { text: clip(fs.readFileSync(p, 'utf8')), failed: false }
    if (call.name === 'write_file') {
      if (typeof a.content !== 'string') throw new Error('content is required')
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, a.content)
      return { text: 'written', failed: false }
    }
    if (call.name === 'replace_text') {
      const text = fs.readFileSync(p, 'utf8')
      if (typeof a.old_text !== 'string' || !a.old_text || typeof a.new_text !== 'string') throw new Error('old_text and new_text are required')
      const count = text.split(a.old_text).length - 1
      if (count !== 1) throw new Error(`old_text occurs ${count} times, and it must occur once`)
      fs.writeFileSync(p, text.replace(a.old_text, () => a.new_text as string))
      return { text: 'replaced', failed: false }
    }
    if (call.name === 'list_files') {
      const out: string[] = []
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (out.length >= LIST_CAP || e.name === '.git' || e.name === 'node_modules') continue
          const q = path.join(dir, e.name)
          if (e.isDirectory()) walk(q)
          else out.push(path.relative(p, q))
        }
      }
      walk(p)
      return { text: out.sort().join('\n') + (out.length >= LIST_CAP ? `\n[list stopped at ${LIST_CAP}]` : ''), failed: false }
    }
    throw new Error(`no tool named ${call.name}`)
  } catch (e) {
    return { text: `error: ${(e as Error).message}`, failed: true }
  }
}
