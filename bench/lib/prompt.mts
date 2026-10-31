// Versioned prompt templates. A run stores these hashes, so a changed prompt can never pass as the same experiment.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'prompts')
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

export interface Template { id: string; text: string; sha256: string }

export function loadTemplate(id: string): Template {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad template id ${id}`)
  const text = fs.readFileSync(path.join(DIR, `${id}.md`), 'utf8')
  if (!text.includes('{{task_text}}')) throw new Error(`template ${id} has no {{task_text}}`)
  return { id, text, sha256: sha256(text) }
}

export function renderPrompt(template: Template, taskText: string) {
  const text = template.text.replace('{{task_text}}', () => taskText)
  return { text, sha256: sha256(text) }
}
