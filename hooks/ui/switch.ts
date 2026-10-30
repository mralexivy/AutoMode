// toggleRouting: on stops routing in this session, off returns to the configured mode. The toggle's label follows the mode
// in force afterwards, so an environment switch that outranks this one shows as a toggle that did not move.
import type { EngineInterface } from 'claude-code'
import { setSessionMode, v4Snapshot } from '../v4.ts'

export async function toggleRouting($: EngineInterface): Promise<string> {
  const before = v4Snapshot(null, 0)
  const wantOn = before.mode === 'off'
  await setSessionMode($, wantOn ? null : 'off')
  const now = v4Snapshot(null, 0).mode
  if (wantOn && now === 'off') return 'Still off: the configuration or AUTOMODE_ROUTER keeps routing off.'
  if (!wantOn && now !== 'off') return `Not turned off: AUTOMODE_ROUTER keeps routing ${now}.`
  return wantOn ? 'Routing is on for this session, from the next prompt.' : 'Routing is off for this session, from the next request. Your model and effort run as set.'
}
