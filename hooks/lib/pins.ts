// Pins: the person's own model and effort. `/model` and `/effort` stand until am:reset, and an `am:` command beats them
// for its turn. A pin comes from two places: the `command.run` hook, when the command names a value, and a change in
// what the app asks for on main requests. A request alone cannot show a pick equal to the app's value, so the first
// source covers that case.
//
// A rewrite this mod sends changes that request, not the session: 335 model rewrites and 684 effort rewrites were never
// echoed back. So a change needs no check against the running route. The app's value is still not always the person's:
// `e.model` is "the session's, a fallback's" (TurnStepInput). The caller therefore pins a model only if the session's
// model moved too. The `pin` record carries `echo` to catch a build that does echo a rewrite.
import type { Effort, Family, Owner, Route, Tier } from './types.ts'
import { EFFORTS } from './types.ts'
import { familyOf } from './prices.ts'
import { tierOf } from './optimizer.ts'

export interface Pins { family?: Family; effort?: Effort }

export interface AppChoice {
  unroutable: boolean // the app's model is not one this router can run: routing is off
  family?: Family     // a new model pin
  effort?: Effort     // a new effort pin
  skipped: string[]   // changes read as the engine's, not the person's
}

// readAppChoice compares one main request with the last one. `planShift`: this request is in plan mode or is the first
// out of it. The engine changes the model there on its own (opusplan, Haiku in plan mode), so a model change is not a
// pin. A model's default effort moves with the model, so an effort change on the same request is not a pin either.
export function readAppChoice(seen: { model?: string; effort?: Effort }, now: { model?: unknown; effort?: unknown }, pins: Pins, planShift: boolean): AppChoice {
  const model = typeof now.model === 'string' ? now.model : undefined
  const family = model ? familyOf(model) : null
  const out: AppChoice = { unroutable: !!model && !family, skipped: [] }
  const modelMoved = !!seen.model && !!model && familyOf(seen.model) !== family
  if (modelMoved && family && family !== pins.family) {
    if (planShift) out.skipped.push('model: plan mode')
    else out.family = family
  }
  const effort = typeof now.effort === 'string' ? (now.effort as Effort) : undefined
  if (seen.effort !== undefined && effort !== undefined && effort !== seen.effort && effort !== pins.effort) {
    if (modelMoved) out.skipped.push('effort: moved with the model')
    else if (planShift) out.skipped.push('effort: plan mode')
    else out.effort = effort
  }
  return out
}

export interface CommandChoice { family?: Family; effort?: Effort; release?: true }

// commandChoice reads `/model <name>` or `/effort <level>`. Bare, the command opens a picker, and only the next request
// can show the pick. `opusplan` changes the model by mode, so it pins nothing, and a model outside the families pins
// nothing: the next request turns routing off. `default` and `auto` hand the axis back to routing.
export function commandChoice(command: string, args: string): CommandChoice | null {
  const word = String(args ?? '').trim().split(/\s+/)[0].toLowerCase()
  if (!word) return null
  if (word === 'default' || word === 'auto') return { release: true }
  if (command === 'effort') return (EFFORTS as readonly string[]).includes(word) ? { effort: word as Effort } : null
  if (command !== 'model' || /plan/.test(word)) return null
  const family = familyOf(word)
  return family ? { family } : null
}

// applyPins puts the person's choices on a route: this turn's `am:` command first, then the pins. They outrank every
// routing step, so the owner becomes the person.
export function applyPins<T extends { tier: Tier; family: Family; model: string; effort: Effort; owner: Owner }>(r: T, pins: Pins, turn: Pins, appModel: string, models: Record<Family, string>): T {
  const family = turn.family ?? pins.family ?? r.family
  const effort = turn.effort ?? pins.effort ?? r.effort
  if (family === r.family && effort === r.effort) return r
  // The app's own id keeps its suffix. A pin from a command can come before the app moved, so the id must match the pin.
  const model = family === r.family ? r.model : familyOf(appModel) === family ? appModel : models[family]
  return { ...r, family, model, effort, tier: tierOf(family, effort), owner: 'user-override' }
}

// turnAxes: what an `am:` command fixes for its turn, read from the route it produced.
export function turnAxes(override: { tier?: Tier; effort?: Effort } | null | undefined, route: Route): Pins | null {
  if (!override?.tier && !override?.effort) return null
  return { ...(override.tier ? { family: route.family } : {}), ...(override.effort || override.tier === 'T4' ? { effort: route.effort } : {}) }
}
