// Shell text, read without running it. A command line splits into simple commands, and each simple command loses
// the wrappers that only start it (env prefixes, timeout, venv paths, `python -m`, npx). Check detection and operation
// detection then read the tool itself. This is a reading aid, not a parser: it decides what to track, never what runs.

// simpleCommands splits on ; & | and newlines, outside quotes. A redirect such as 2>&1 stays whole.
export function simpleCommands(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = '' }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === '\\') { cur += c + (command[i + 1] ?? ''); i += 1; continue }
    if (quote) { if (c === quote) quote = null; cur += c; continue }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    const redirect = c === '&' && (command[i - 1] === '>' || command[i + 1] === '>')
    if ((c === ';' || c === '|' || c === '\n' || c === '&') && !redirect) { flush(); continue }
    cur += c
  }
  flush()
  return out
}

const WRAPPERS: RegExp[] = [
  /^[({]\s*/,                                                                  // a subshell or a group
  /^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/,                                  // FOO=1 npm test
  /^env(?:\s+-[uCS]\s+[^-\s]\S*|\s+-\S+)*\s+/,
  /^(?:time|command|exec|nohup|caffeinate|unbuffer)\s+/,
  /^sudo(?:\s+-[ugUh]\s+[^-\s]\S*|\s+-\S+)*\s+/,                               // sudo -u postgres dropdb app
  /^nice(?:\s+-n\s+\S+|\s+-\d+)?\s+/,
  /^(?:ionice|stdbuf|xvfb-run)(?:\s+-\S+)*\s+/,
  /^g?timeout(?:\s+-[ks]\s+[^-\s]\S*|\s+-\S+)*\s+\d\S*\s+/,                   // timeout 60 npm test
  /^(?:uv|poetry|pipenv|pdm|hatch|rye)\s+run(?:\s+-\S+)*\s+(?:[\w-]+:(?=\S))?/, // uv run pytest
  /^conda\s+run(?:\s+-\S+(?:\s+[^-\s]\S*)?)*\s+/,
  /^bundle\s+exec\s+/,
  /^npx(?:\s+(?:-y|--yes|--no-install|--no|-p\s+\S+|--package[= ]\S+))*\s+/,   // npx mocha
  /^bunx\s+/,
  /^(?:pnpm|yarn)\s+(?:exec|dlx)\s+/,
  /^python[\d.]*(?:\s+-[A-Za-z]+)*\s+-m\s+/,                                   // python3 -m pytest
  /^py\s+-m\s+/,
  /^(?:\.{0,2}\/|~\/|\/)?(?:[\w.@+-]+\/)+(?=[\w.+-]+(?:\s|$))/,                // .venv/bin/pytest, ./gradlew
]

// unwrapped strips wrappers until none applies. The bound stops a pathological line from looping.
export function unwrapped(simple: string): string {
  let s = simple.trim()
  for (let i = 0; i < 12; i++) {
    const hit = WRAPPERS.find((re) => re.test(s))
    if (!hit) break
    s = s.replace(hit, '').trim()
  }
  return s
}

// A heredoc's body is data, not commands. Whatever follows the marker on its line stays.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2\b[^\n]*/g

// tools: each simple command of a line with its wrappers gone. `bash -c "..."` is read through once.
export function tools(command: string): string[] {
  const out: string[] = []
  for (const part of simpleCommands(command.replace(HEREDOC, '$3'))) {
    const s = unwrapped(part)
    const inner = s.match(/^(?:ba|z|da)?sh(?:\s+-[a-z]+)*\s+-[a-z]*c\s+(?:"([^"]*)"|'([^']*)')\s*$/)
    if (inner) out.push(...simpleCommands(inner[1] ?? inner[2]).map(unwrapped))
    else out.push(s)
  }
  return out
}
