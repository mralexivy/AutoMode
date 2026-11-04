// One named function per busy host call. `claude plugin validate` lists each $ method with every function that
// reaches it, and it cuts its calls line at 1,000 characters. The mods catalogue refuses a new seed with a cut line,
// so these keep the whole list readable: each method then shows one `via` name. They must stay function declarations
// that pass $ through: the validator rejects $ passed to a function expression. $.env.get stays literal at each call,
// because the validator reads the variable name there. CI fails if the line is cut again.
import type { EngineInterface } from 'claude-code'

export function sid($: EngineInterface) { return $.session.id() }
export function sessionModel($: EngineInterface) { return $.session.model() }
export function fsRead($: EngineInterface, ...args: Parameters<EngineInterface['fs']['read']>) { return $.fs.read(...args) }
export function fsWrite($: EngineInterface, ...args: Parameters<EngineInterface['fs']['write']>) { return $.fs.write(...args) }
export function sessionUsage($: EngineInterface) { return $.session.usage() }
export function fsExists($: EngineInterface, ...args: Parameters<EngineInterface['fs']['exists']>) { return $.fs.exists(...args) }
export function fork($: EngineInterface, ...args: Parameters<EngineInterface['model']['fork']>) { return $.model.fork(...args) }
export function sGet($: EngineInterface, key: string) { return $.store.get(key) }
export function sSet($: EngineInterface, key: string, value: unknown) { return $.store.set(key, value) }
export function sKeys($: EngineInterface) { return $.store.keys() }
export function sDel($: EngineInterface, key: string) { return $.store.delete(key) }
export function proc($: EngineInterface, ...args: Parameters<EngineInterface['process']['run']>) { return $.process.run(...args) }
export function agents($: EngineInterface) { return $.agent.list() }
export function status($: EngineInterface, ...args: Parameters<EngineInterface['ui']['status']>) { return $.ui.status(...args) }
