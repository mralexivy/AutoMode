// Benchmark arms. Each arm returns the claude CLI arguments, env, and any plugin folder it needs.
// Every arm gets the same isolation: project settings only (the fixture commits have none), no MCP
// servers, the 5.5 alias pins, and the Anthropic backend.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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
function v2Plugin(dir, config) {
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

// The five comparison arms for effort selection. Arms 1 to 4 pin one model by its full id, so effort is the only
// variable; arm 5 adds model routing. Each run's transcript shows the model that answered (bench/cache-accounting.mts).
const pinned = (model, effort, extra = {}) => ({ model, effort, pinModel: model, ...extra })
export const EFFORT_ARMS = {
  'opus-medium': { label: '1 Opus 5.5, fixed medium', ...pinned('claude-opus-5-5', 'medium') },
  'opus-high': { label: '2 Opus 5.5, fixed high', ...pinned('claude-opus-5-5', 'high') },
  'opus-effortless': { label: '3 Opus 5.5, upstream effortless (pinned commit)', ...pinned('claude-opus-5-5', 'medium'), plugin: () => effortlessPlugin() },
  'opus-auto-effort': { label: '4 Opus 5.5, AutoMode Auto with routeModels false (effort only)', ...pinned('claude-opus-5-5', 'medium'), v4: true, plugin: (dir) => v2Plugin(dir, { router: 'v4', mode: 'auto', recordDecisions: true, policy: 'auto', routeModels: false, pickerModel: 'claude-opus-5-5' }) },
  'sonnet-medium': { label: '1 Sonnet 5.5, fixed medium', ...pinned('claude-sonnet-5-5', 'medium') },
  'sonnet-high': { label: '2 Sonnet 5.5, fixed high', ...pinned('claude-sonnet-5-5', 'high') },
  'sonnet-effortless': { label: '3 Sonnet 5.5, upstream effortless (pinned commit)', ...pinned('claude-sonnet-5-5', 'medium'), plugin: () => effortlessPlugin() },
  'sonnet-auto-effort': { label: '4 Sonnet 5.5, AutoMode Auto with routeModels false (effort only)', ...pinned('claude-sonnet-5-5', 'medium'), v4: true, plugin: (dir) => v2Plugin(dir, { router: 'v4', mode: 'auto', recordDecisions: true, policy: 'auto', routeModels: false, pickerModel: 'claude-sonnet-5-5' }) },
  'auto': { label: '5 AutoMode Auto: model and effort routing', model: HM_MODEL, v4: true, plugin: (dir) => v2Plugin(dir, { router: 'v4', mode: 'auto', recordDecisions: true, policy: 'auto' }) },
}

export const ARMS = {
  'sonnet': { label: 'Plain Sonnet 5.5', model: 'sonnet' },
  'sonnet-ts': { label: 'Plain Sonnet 5.5, tool search on', model: 'sonnet', env: { ENABLE_TOOL_SEARCH: 'true' } },
  'opus': { label: 'Plain Opus 5.5', model: 'opus' },
  'opusplan': { label: 'opusplan (Opus in plan mode, Sonnet otherwise)', model: 'opusplan',
    caveat: 'Headless -p does not enter plan mode on its own, so this arm may run as Sonnet. The trace shows which models ran.' },
  // The effort-selection arms (EFFORT_ARMS): fixed medium and high, upstream effortless, Auto effort-only, full Auto.
  ...EFFORT_ARMS,
}

// billingEnv is the environment for a model call. Runs use the signed-in plan, so an API key in the shell must not
// reach them and bill the API. BENCH_AUTH=api keeps the key, for someone with no plan.
export function billingEnv(): NodeJS.ProcessEnv {
  if (process.env.BENCH_AUTH === 'api') return { ...process.env }
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...env } = process.env
  return env
}

// armInvocation returns { args, env } for one run. `dir` is the run's private folder.
export function armInvocation(armId, dir, prompt) {
  const arm = ARMS[armId]
  if (!arm) throw new Error(`unknown arm ${armId}`)
  const settingsFile = path.join(dir, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify({ ...baseSettings, env: { ...baseSettings.env, ...(arm.env || {}) } }))
  const args = ['-p', prompt, '--model', arm.model, '--output-format', 'json', '--setting-sources', 'project',
    '--settings', settingsFile, '--strict-mcp-config', '--permission-mode', 'bypassPermissions']
  if (arm.effort) args.push('--effort', arm.effort)
  if (arm.plugin) args.push('--plugin-dir', arm.plugin(dir))
  return { args, env: { ...billingEnv(), CLAUDE_CODE_USE_VERTEX: '0', ...(arm.env || {}) } }
}
