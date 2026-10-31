// Benchmark arms, as data. armInvocation turns an arm into claude CLI arguments, env, and any plugin folder it needs.
// armSpec turns it into the ModelSpec that a result row stores and specHash covers.
// Every arm gets the same isolation: project settings only (the fixture commits have none), no MCP
// servers, the 5.5 alias pins, and the Anthropic backend.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ContextSpec, ModelSpec } from './lib/experiment.mts'

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const V2_PLUGIN = REPO
// effortless at the commit the port is pinned to (bench/external/effortless/PROVENANCE.md).
const EFFORTLESS_SHA = 'e5c590dfd9402244ea66a8bf795d1cb86d1df7b9'
const CACHE = path.join(REPO, 'bench', '.cache')
const HM_MODEL = 'claude-sonnet-5-5[1m]'

const baseSettings = {
  env: {
    CLAUDE_CODE_USE_VERTEX: '0',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
  },
}

// v2Plugin copies the working-tree plugin into the run folder with one config change, so arms
// that run at the same time never share a config file.
function v2Plugin(dir: string, config: Record<string, unknown>) {
  const dest = path.join(dir, 'plugin-v2')
  fs.cpSync(V2_PLUGIN, dest, { recursive: true, filter: (src) => !/[\\/](\.git|bench|tests|docs|brand|node_modules)([\\/]|$)/.test(path.relative(V2_PLUGIN, src)) })
  const cfgPath = path.join(dest, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, ...config }, null, 2))
  const manifest = path.join(dest, '.claude-plugin', 'plugin.json')
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  m.version = `bench+${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()}-wt`
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2))
  return dest
}

// effortlessPlugin: upstream effortless as its author ships it, at the pinned commit, fetched once into bench/.cache
// (gitignored). Its defaults apply: Auto effort on, model switching off, helpers off.
function effortlessPlugin() {
  const dest = path.join(CACHE, `effortless-${EFFORTLESS_SHA.slice(0, 7)}`)
  if (!fs.existsSync(path.join(dest, 'hooks', 'register.tsx'))) {
    fs.mkdirSync(CACHE, { recursive: true })
    execFileSync('git', ['clone', '-q', '--filter=blob:none', 'https://github.com/HeyCubit/effortless.git', dest])
    execFileSync('git', ['checkout', '-q', EFFORTLESS_SHA], { cwd: dest })
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dest, encoding: 'utf8' }).trim()
  if (head !== EFFORTLESS_SHA) throw new Error(`effortless checkout is at ${head}, not the pinned ${EFFORTLESS_SHA}`)
  return dest
}

export interface Arm {
  label: string
  model: string
  effort?: string // a level, or 'default' to send none so the API default applies
  pinModel?: string
  plugin?: { kind: 'effortless' } | { kind: 'automode'; config: Record<string, unknown> }
  v4?: boolean
  env?: Record<string, string>
  context?: Omit<ContextSpec, 'policy' | 'maxTokens'> & { cap200k?: boolean }
  cache?: boolean
  caveat?: string
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const FAMILIES = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
const automode = (config: Record<string, unknown>): Arm['plugin'] => ({ kind: 'automode', config: { router: 'v4', mode: 'auto', recordDecisions: true, policy: 'auto', ...config } })

// One fixed arm per family and effort. Each pins the model by its full id, so effort is the only variable.
const FIXED: Record<string, Arm> = Object.fromEntries(Object.entries(FAMILIES).flatMap(([family, name]) => EFFORTS.map((effort) => {
  const model = `claude-${family}-5-5`
  return [`${family}-${effort}`, { label: `${name} 5.5, fixed ${effort}`, model, effort, pinModel: model }]
})))

// The comparison arms for effort selection. The effortless and effort-only arms pin one model; `auto` adds model routing.
// Each run's transcript shows the model that answered (bench/lib/run-evidence.mts).
export const EFFORT_ARMS: Record<string, Arm> = {
  'opus-effortless': { label: 'Opus 5.5, upstream effortless (pinned commit)', model: 'claude-opus-5-5', effort: 'medium', pinModel: 'claude-opus-5-5', plugin: { kind: 'effortless' } },
  'opus-auto-effort': { label: 'Opus 5.5, AutoMode Auto with routeModels false (effort only)', model: 'claude-opus-5-5', effort: 'medium', pinModel: 'claude-opus-5-5', v4: true, plugin: automode({ routeModels: false, pickerModel: 'claude-opus-5-5' }) },
  'sonnet-effortless': { label: 'Sonnet 5.5, upstream effortless (pinned commit)', model: 'claude-sonnet-5-5', effort: 'medium', pinModel: 'claude-sonnet-5-5', plugin: { kind: 'effortless' } },
  'sonnet-auto-effort': { label: 'Sonnet 5.5, AutoMode Auto with routeModels false (effort only)', model: 'claude-sonnet-5-5', effort: 'medium', pinModel: 'claude-sonnet-5-5', v4: true, plugin: automode({ routeModels: false, pickerModel: 'claude-sonnet-5-5' }) },
  // The value users get. A native 1M model may drop the suffix; the row records what ran.
  'auto': { label: 'AutoMode Auto: model and effort routing', model: HM_MODEL, v4: true, plugin: automode({}) },
}

export const ARMS: Record<string, Arm> = {
  ...FIXED,
  'sonnet': { label: 'Plain Sonnet 5.5', model: 'sonnet' },
  'sonnet-ts': { label: 'Plain Sonnet 5.5, tool search on', model: 'sonnet', env: { ENABLE_TOOL_SEARCH: 'true' } },
  'opus': { label: 'Plain Opus 5.5', model: 'opus' },
  'opusplan': { label: 'opusplan (Opus in plan mode, Sonnet otherwise)', model: 'opusplan',
    caveat: 'Headless -p does not enter plan mode on its own, so this arm may run as Sonnet. The trace shows which models ran.' },
  // One control changed against sonnet-medium, for the configuration studies.
  'sonnet-default-effort': { label: 'Sonnet 5.5, no effort sent', model: 'claude-sonnet-5-5', effort: 'default', pinModel: 'claude-sonnet-5-5' },
  'sonnet-medium-uncached': { label: 'Sonnet 5.5, medium, prompt caching off', model: 'claude-sonnet-5-5', effort: 'medium', pinModel: 'claude-sonnet-5-5', cache: false },
  'sonnet-medium-200k': { label: 'Sonnet 5.5, medium, held to a 200K window', model: 'claude-sonnet-5-5', effort: 'medium', pinModel: 'claude-sonnet-5-5', context: { cap200k: true } },
  'sonnet-medium-compact-200k': { label: 'Sonnet 5.5, medium, compaction window 200K', model: 'claude-sonnet-5-5', effort: 'medium', pinModel: 'claude-sonnet-5-5', context: { compactWindow: 200_000 } },
  ...EFFORT_ARMS,
}

// armEnv maps an arm's controls to the variables Claude Code documents.
export function armEnv(arm: Arm): Record<string, string> {
  return {
    ...(arm.effort === 'default' ? { CLAUDE_CODE_EFFORT_LEVEL: 'unset' } : {}),
    ...(arm.cache === false ? { DISABLE_PROMPT_CACHING: '1' } : {}),
    ...(arm.context?.cap200k ? { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } : {}),
    ...(arm.context?.compactWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(arm.context.compactWindow) } : {}),
    ...(arm.context?.compactPct ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(arm.context.compactPct) } : {}),
    ...(arm.env ?? {}),
  }
}

// armSpec is the arm as a result row states it. It holds no label: a new label changes no result.
export function armSpec(armId: string) {
  const arm = ARMS[armId]
  if (!arm) throw new Error(`unknown arm ${armId}`)
  const { compactWindow, compactPct } = arm.context ?? {}
  const model: ModelSpec = {
    provider: 'anthropic',
    requestedModel: arm.model,
    reasoning: arm.effort && arm.effort !== 'default' ? { mode: 'effort', requestedEffort: arm.effort } : { mode: 'provider-default' },
    context: { policy: arm.context?.cap200k ? 'capped-200k' : 'native', ...(compactWindow ? { compactWindow } : {}), ...(compactPct ? { compactPct } : {}) },
    cache: { enabled: arm.cache !== false },
  }
  return { model, alias_map: baseSettings.env, env: armEnv(arm), plugin: arm.plugin ?? null }
}

// billingEnv is the environment for a model call. Runs use the signed-in plan, so an API key in the shell must not
// reach them and bill the API. BENCH_AUTH=api keeps the key, for someone with no plan.
export function billingEnv(): NodeJS.ProcessEnv {
  if (process.env.BENCH_AUTH === 'api') return { ...process.env }
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...env } = process.env
  return env
}

// armInvocation returns { args, env } for one run. `dir` is the run's private folder.
export function armInvocation(armId: string, dir: string, prompt: string) {
  const arm = ARMS[armId]
  if (!arm) throw new Error(`unknown arm ${armId}`)
  const settingsFile = path.join(dir, 'settings.json')
  const env = armEnv(arm)
  fs.writeFileSync(settingsFile, JSON.stringify({ ...baseSettings, env: { ...baseSettings.env, ...env } }))
  const args = ['-p', prompt, '--model', arm.model, '--output-format', 'json', '--setting-sources', 'project',
    '--settings', settingsFile, '--strict-mcp-config', '--permission-mode', 'bypassPermissions']
  if (arm.effort && arm.effort !== 'default') args.push('--effort', arm.effort)
  if (arm.plugin) args.push('--plugin-dir', arm.plugin.kind === 'effortless' ? effortlessPlugin() : v2Plugin(dir, arm.plugin.config))
  return { args, env: { ...billingEnv(), CLAUDE_CODE_USE_VERTEX: '0', ...env } }
}
