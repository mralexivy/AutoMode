// Settings from the UI: the plugin's userConfig fields (plugin.json), what each one changes, and the merge order.
// Pure. Precedence, lowest first: the code defaults, config.json, a userConfig value, then the environment kill
// switches and overrides, which the callers keep applying last (AUTOMODE_ROUTER, AUTOMODE_POLICY, AUTOMODE_GUARDIAN,
// AUTOMODE_GUARDIAN_CONFIG). Every routing and guardian field defaults to "default", which means "follow config.json":
// an untouched setting never overrides the shipped profile.
//
// Where userConfig is refused (a Claude Code build without a /config row for plugin settings), the UI keeps the value in
// $.store instead and says so; `stored` here is that copy, read only where the userConfig value is "default".

export interface FieldSpec { title: string; options: readonly string[]; default: string; applies: 'next prompt' | 'next request' | 'now' | 'next turn'; section: Section }
export type Section = 'router' | 'effort' | 'subagents' | 'guardian' | 'context' | 'appearance'

const ONOFF = ['default', 'on', 'off'] as const

export const FIELDS = {
  mode: { title: 'Router mode', options: ['default', 'auto', 'shadow', 'off'], default: 'default', applies: 'next prompt', section: 'router' },
  policy: { title: 'Routing policy', options: ['default', 'auto', 'legacy'], default: 'default', applies: 'next prompt', section: 'router' },
  routeModels: { title: 'Route models', options: ONOFF, default: 'default', applies: 'next prompt', section: 'router' },
  completionGate: { title: 'Completion gate', options: ['default', 'off', 'report', 'block'], default: 'default', applies: 'next prompt', section: 'router' },
  learning: { title: 'Route learning', options: ONOFF, default: 'default', applies: 'next prompt', section: 'router' },
  delegation: { title: 'Delegated reads', options: ['default', 'off', 'shadow', 'on'], default: 'default', applies: 'next prompt', section: 'router' },
  strongStep: { title: 'Strong evidence step', options: ['default', 'model', 'effort-first'], default: 'default', applies: 'next prompt', section: 'router' },
  consult: { title: 'Opus consult', options: ['default', 'always', 'priced'], default: 'default', applies: 'next prompt', section: 'router' },
  packet: { title: 'Consult packet', options: ['default', 'basic', 'rich', 'fork-gated'], default: 'default', applies: 'next prompt', section: 'router' },
  forkRung: { title: 'Fork diagnosis rung', options: ['default', 'off', 'on'], default: 'default', applies: 'next prompt', section: 'router' },
  opusStart: { title: 'Opus at the start', options: ['default', 'judge', 'evidence'], default: 'default', applies: 'next prompt', section: 'router' },
  haikuFirst: { title: 'Haiku first on T3 work', options: ['default', 'off', 't3'], default: 'default', applies: 'next prompt', section: 'router' },
  strategy: { title: 'Execution strategy', options: ['default', 'legacy', 'v6a', 'v6b', 'v6c'], default: 'default', applies: 'next prompt', section: 'router' },
  builder: { title: 'Builder subagent from the start', options: ['default', 'off', 'on'], default: 'default', applies: 'next prompt', section: 'router' },
  executor: { title: 'Executor', options: ['default', 'judge', 'sonnet'], default: 'default', applies: 'next prompt', section: 'router' },
  subagentsEverySession: { title: 'Subagents in every session', options: ONOFF, default: 'default', applies: 'next prompt', section: 'subagents' },
  guardianMode: { title: 'Guardian', options: ['default', 'off', 'observe', 'recommend', 'assist', 'auto'], default: 'default', applies: 'next prompt', section: 'guardian' },
  guardianEverySession: { title: 'Guardian in every session', options: ONOFF, default: 'default', applies: 'next prompt', section: 'guardian' },
  hardPause: { title: 'Hard pause', options: ONOFF, default: 'default', applies: 'next prompt', section: 'guardian' },
  autoCompact: { title: 'Auto compact', options: ONOFF, default: 'default', applies: 'next prompt', section: 'guardian' },
  reduceOutputs: { title: 'Reduce long outputs', options: ONOFF, default: 'default', applies: 'next prompt', section: 'guardian' },
  layout: { title: 'Layout', options: ['expanded', 'minimal'], default: 'expanded', applies: 'now', section: 'appearance' },
  theme: { title: 'Theme', options: ['native', 'automode', 'mono', 'contrast'], default: 'native', applies: 'now', section: 'appearance' },
  appearance: { title: 'Appearance', options: ['auto', 'dark', 'light'], default: 'auto', applies: 'now', section: 'appearance' },
  metrics: { title: 'Bar metrics', options: [], default: 'pending,context,cache,cost,guardian,stage', applies: 'now', section: 'appearance' },
} as const satisfies Record<string, FieldSpec>

export type Field = keyof typeof FIELDS
export type Options = Partial<Record<Field, string>>
export const FIELD_NAMES = Object.keys(FIELDS) as Field[]

// valueOf: the value in force for one field. A userConfig value outside the field's options counts as unset, as Claude
// Code itself reads it; "default" (or unset) falls back to the stored copy, then to the field's default.
export function valueOf(field: Field, options: Options, stored: Options = {}): string {
  const spec = FIELDS[field] as FieldSpec
  const ok = (v: unknown): v is string => typeof v === 'string' && (spec.options.length === 0 || spec.options.includes(v))
  const given = options[field]
  if (ok(given) && given !== 'default' && !(given === spec.default && ok(stored[field]) && stored[field] !== spec.default)) return given
  if (ok(stored[field])) return stored[field] as string
  return ok(given) ? given : spec.default
}

const bool = (v: string): boolean | undefined => (v === 'on' ? true : v === 'off' ? false : undefined)

// routerOverrides: the userConfig values for the router, as config.json keys. Only fields not "default" appear.
export function routerOverrides(options: Options, stored: Options = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const mode = valueOf('mode', options, stored)
  if (mode !== 'default') out.mode = mode
  const policy = valueOf('policy', options, stored)
  if (policy !== 'default') out.policy = policy
  const rm = bool(valueOf('routeModels', options, stored))
  if (rm !== undefined) out.routeModels = rm
  const gate = valueOf('completionGate', options, stored)
  if (gate !== 'default') out.completionGate = gate
  const learning = bool(valueOf('learning', options, stored))
  if (learning !== undefined) out.learning = learning
  const delegation = valueOf('delegation', options, stored)
  if (delegation !== 'default') out.delegation = delegation
  const executor = valueOf('executor', options, stored)
  if (executor !== 'default') out.executor = executor
  const opusStart = valueOf('opusStart', options, stored)
  if (opusStart !== 'default') out.opusStart = opusStart
  const haikuFirst = valueOf('haikuFirst', options, stored)
  if (haikuFirst !== 'default') out.haikuFirst = haikuFirst
  const strategy = valueOf('strategy', options, stored)
  if (strategy !== 'default') out.strategy = strategy
  const builder = valueOf('builder', options, stored)
  if (builder !== 'default') out.builder = builder
  const forkRung = valueOf('forkRung', options, stored)
  if (forkRung !== 'default') out.forkRung = forkRung
  const packet = valueOf('packet', options, stored)
  if (packet !== 'default') out.packet = packet
  const consult = valueOf('consult', options, stored)
  if (consult !== 'default') out.consult = consult
  const strongStep = valueOf('strongStep', options, stored)
  if (strongStep !== 'default') out.strongStep = strongStep
  const sub = bool(valueOf('subagentsEverySession', options, stored))
  if (sub !== undefined) out.subagentsEverySession = sub
  return out
}

// guardianOverrides: the same for the guardian's own block (config.json "guardian").
export function guardianOverrides(options: Options, stored: Options = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const mode = valueOf('guardianMode', options, stored)
  if (mode !== 'default') out.mode = mode
  for (const [field, key] of [['guardianEverySession', 'everySession'], ['hardPause', 'hardPause'], ['autoCompact', 'autoCompact'], ['reduceOutputs', 'reduceOutputs']] as const) {
    const b = bool(valueOf(field, options, stored))
    if (b !== undefined) out[key] = b
  }
  return out
}

export interface UiOptions { layout: 'expanded' | 'minimal'; theme: 'native' | 'automode' | 'mono' | 'contrast'; appearance: 'auto' | 'dark' | 'light'; metrics: string[] }
export function uiOptions(options: Options, stored: Options = {}): UiOptions {
  return {
    layout: valueOf('layout', options, stored) as UiOptions['layout'],
    theme: valueOf('theme', options, stored) as UiOptions['theme'],
    appearance: valueOf('appearance', options, stored) as UiOptions['appearance'],
    metrics: valueOf('metrics', options, stored).split(',').map((s) => s.trim()).filter(Boolean),
  }
}
