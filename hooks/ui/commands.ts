// The text of the /automode subcommands. Pure functions of the view model: no engine call, so tests run them directly.
// register-ui.tsx reads the engine facts (config.json, the plugin version, the home folder) and passes them in.
import type { View } from '../../types/index.d.ts'

export type Facts = {
  version: string
  root: string
  home: string | null
  config: Record<string, unknown>   // the shipped config.json
  env: Record<string, string | null> // AUTOMODE_* values
}

// The subcommands, in the order /automode help lists them. `aliases` answer the same way.
export const SUBCOMMANDS: { name: string; aliases: string[]; line: string }[] = [
  { name: 'status', aliases: [''], line: 'the bar as text' },
  { name: 'details', aliases: ['stats'], line: 'routing, workflow, guardian and usage as text' },
  { name: 'on', aliases: [], line: 'turn routing on for this session' },
  { name: 'off', aliases: [], line: 'turn routing off for this session: your model and effort run as set' },
  { name: 'setup', aliases: [], line: 'check that AutoMode is on, and show the next step' },
  { name: 'settings', aliases: [], line: 'the effective settings and where each comes from' },
  { name: 'debug', aliases: [], line: 'a report to paste in a bug issue, with no prompt text' },
  { name: 'help', aliases: ['tips', 'commands'], line: 'this list, the am: prompt commands and tips' },
]

export function parse(args: unknown): { sub: string; rest: string } {
  const s = String(args ?? '').trim()
  const i = s.search(/\s/)
  return i < 0 ? { sub: s.toLowerCase(), rest: '' } : { sub: s.slice(0, i).toLowerCase(), rest: s.slice(i + 1).trim() }
}

// resolve returns the subcommand's canonical name, or null for a word we do not know.
export function resolve(sub: string): string | null {
  for (const c of SUBCOMMANDS) if (c.name === sub || c.aliases.includes(sub)) return c.name
  return null
}

export function usageLine(): string {
  return `/automode [${SUBCOMMANDS.map((c) => c.name).join('|')}]`
}

export function helpText(): string {
  return [
    'AutoMode picks the model and effort for each prompt.',
    '',
    'Commands:',
    ...SUBCOMMANDS.map((c) => `  /automode ${c.name === 'status' ? '' : c.name}`.trimEnd().padEnd(24) + c.line),
    '  /automode:usage [--trace]'.padEnd(24) + 'model calls, tokens, cache use and estimated API cost',
    '',
    'The bar: model · effort · context · cache time left · session cost, then why it was chosen.',
    'For one prompt, start it with: am:haiku | am:sonnet | am:opus, am:low | am:medium | am:high | am:xhigh | am:max,',
    '  am:direct (skip planning), am:run (full workflow), am:explore, am:new (new task), am:reset (back to automatic).',
    'If the guardian pauses a turn, reply am:continue. After /clear, am:handoff restores the task checkpoint.',
    'Shorter replies: /output-style automode:Concise. Your own /effort or /model always wins.',
    'Before a long break: /compact. Hide the bar: AUTOMODE_UI=off.',
  ].join('\n')
}

export function unknownText(sub: string): string {
  return `Unknown subcommand "${sub.slice(0, 40)}". ${usageLine()}`
}

const yes = (b: boolean) => (b ? 'yes' : 'no')
const home = (s: string, h: string | null) => (h && s.startsWith(h) ? `~${s.slice(h.length)}` : s)

// setupText: a checklist with the live answer for each step, and the one next step.
export function setupText(v: View, f: Facts): string {
  const r = v.router
  const picker = String(f.config.pickerModel ?? 'claude-sonnet-5-5[1m]')
  const lines = ['AutoMode setup', '', `✓ The mod is loaded (version ${f.version}).`]
  if (!r.enabled) lines.push('✗ The router is off in config.json (router is not "v4"). AutoMode does not route.')
  else if (r.killed) lines.push('✗ AUTOMODE_ROUTER=off is set. Unset it to route.')
  else lines.push('✓ The router is enabled.')
  lines.push(r.active
    ? `✓ This session runs on the AutoMode model (${picker}).`
    : `✗ This session runs on ${r.sessionModel ?? 'an unknown model'}, so AutoMode is idle.`)
  lines.push(r.mode === 'off' ? '✗ Routing is off for this session. Run /automode on.' : `✓ Routing mode: ${r.mode}.`)
  lines.push(f.env.AUTOMODE_UI === 'off' ? '• The bar is hidden (AUTOMODE_UI=off).' : '✓ The bar is shown above the prompt.')
  lines.push('')
  if (!r.active) {
    lines.push('Next step: start Claude Code on the AutoMode model, or set it as your model in settings:', `  claude --model '${picker}'`)
  } else if (r.mode === 'off') {
    lines.push('Next step: /automode on')
  } else {
    lines.push('Nothing to do. Send a prompt, and the bar shows the route. /automode help lists the commands.')
  }
  lines.push('Optional: /output-style automode:Concise for shorter replies.')
  return lines.join('\n')
}

// settingsText: the values in force and where they come from. It names the way to change each one.
export function settingsText(v: View, f: Facts): string {
  const r = v.router, g = v.guard, c = f.config
  const row = (k: string, val: unknown, how: string) => `  ${k.padEnd(22)}${String(val).padEnd(24)}${how}`
  const modeHow = r.sessionMode ? '/automode on|off (this session)' : r.killed ? 'AUTOMODE_ROUTER' : 'config.json or /plugin configure'
  return [
    'AutoMode settings',
    '',
    row('routing mode', r.mode, modeHow),
    row('policy', r.policy, 'config.json: policy'),
    row('route models', yes(r.routeModels), 'config.json: routeModels'),
    row('subagents, every session', yes(r.subagentsEverySession), 'config.json: subagentsEverySession'),
    row('AutoMode model', c.pickerModel ?? 'claude-sonnet-5-5[1m]', 'config.json: pickerModel'),
    row('review policy', c.reviewPolicy ?? 'risk', 'config.json: reviewPolicy'),
    row('default path', c.defaultPath ?? 'direct', 'config.json: defaultPath'),
    row('max concurrency', c.maxConcurrency ?? 1, 'config.json: maxConcurrency'),
    row('guardian', `${g.mode}${g.killed ? ' (killed by env)' : ''}`, 'config.json: guardian.mode, AUTOMODE_GUARDIAN'),
    row('hard pause', yes(g.hardPause), 'config.json: guardian.hardPause'),
    row('auto compact', yes(g.autoCompact), 'config.json: guardian.autoCompact'),
    row('bar', f.env.AUTOMODE_UI === 'off' ? 'hidden' : 'shown', 'AUTOMODE_UI=off hides it'),
    '',
    'To override a default for good, put a config.json in the plugin data directory, or run /plugin configure automode@automode.',
  ].join('\n')
}

// debugText: a report for a bug issue. It holds state and settings, and never a prompt, a path outside the home
// folder, or a key.
export function debugText(v: View, f: Facts, now: number): string {
  const r = v.router, g = v.guard
  const age = (t: number | null) => (t ? `${Math.max(0, Math.round((now - t) / 1000))}s ago` : 'never')
  return [
    'AutoMode debug. Paste this in your issue. It holds no prompt text.',
    '',
    `version          ${f.version}`,
    `plugin root      ${home(f.root, f.home)}`,
    `session model    ${r.sessionModel ?? 'unknown'}`,
    `active           ${yes(r.active)}`,
    `enabled / killed ${yes(r.enabled)} / ${yes(r.killed)}`,
    `mode             ${r.mode} (config ${r.configMode}, session ${r.sessionMode ?? 'none'})`,
    `policy           ${r.policy}`,
    `provider         ${r.provider}${r.providerGuard ? ' (guard on)' : ''}`,
    `route requested  ${r.requested ? `${r.requested.family}/${r.requested.effort} by ${r.requested.owner}: ${r.requested.reason}` : 'none'}`,
    `route effective  ${r.effective.model ?? 'unknown'} / ${r.effective.effort ?? 'unknown'} (${age(r.effective.at)})`,
    `judge            ${v.judge.state}${r.judgeDown.length ? `, down: ${r.judgeDown.join(', ')}` : ''}`,
    `breakers         ${r.breakers.length ? r.breakers.map((b) => `${b.model}${b.cls ? ` (${b.cls})` : ''}`).join(', ') : 'none'}`,
    `plan mode        ${yes(!!r.planMode)}`,
    `stage            ${r.stage ?? 'none'}`,
    `guardian         ${g.mode}, level ${g.level}${g.paused ? ', PAUSED' : ''}${g.killed ? ', killed by env' : ''}`,
    `context          ${v.context.percent === null ? 'unknown' : `${Math.round(v.context.percent)}%`} (${v.context.level})`,
    `cache            ${v.cache.state}`,
    `calls            ${r.ledger.requests}`,
    `env              ${Object.entries(f.env).filter(([, val]) => val !== null).map(([k, val]) => `${k}=${val}`).join(' ') || 'none set'}`,
  ].join('\n')
}
