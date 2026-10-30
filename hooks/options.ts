// The plugin's userConfig values for this load, and the $.store copy of settings Claude Code refused to keep. Set by
// register.ts (register's `options`) and by the settings panel (hooks/ui/settings.tsx); read by the router, the guardian
// and the UI through lib/settings.ts. A settings change reloads the module, so `options` is always the current one.
import type { Options } from './lib/settings.ts'

let options: Options = {}
let stored: Options = {}
export const setOptions = (o: unknown) => { options = o && typeof o === 'object' ? { ...(o as Options) } : {} }
export const setStored = (o: unknown) => { stored = o && typeof o === 'object' ? { ...(o as Options) } : {} }
export const currentOptions = () => options
export const storedOptions = () => stored
