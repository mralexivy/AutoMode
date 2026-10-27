// The VS Code guardian grader: each step passes only on the evidence it names, and fails without it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gradeVscode, VSCODE_STEPS, CHECKS } from './guardian-live.mts'

const call = (id, command) => `"id":"toolu_${id}","name":"Bash","input":{"command":"${command}"}`
const s = (o) => ({ id: 'x', records: [], text: '', checkpointSealed: false, checkpointMode: null, ...o })
test('every VS Code step passes on its evidence', () => {
  const g = gradeVscode([
    s({ id: 'a', text: 'AM-GV1 AutoMode shortened this output AM-GV2 AutoMode checkpoint AM-GV3', records: [{ event: 'reduced' }, { event: 'warning', delivered: true }, { event: 'cleared' }], checkpointSealed: true, checkpointMode: '600' }),
    s({ id: 'b', text: 'continue AM-GV5', records: [{ event: 'handoff-restored' }] }),
    s({ id: 'c', text: 'AM-GV6 AM-GV8 compact_boundary', records: [{ event: 'compacted' }], checkpointSealed: true, checkpointMode: '600' }),
    s({ id: 'd', text: 'AM-GV7' }),
    // A streamed answer writes its tool_use twice: one call each.
    s({ id: 'p', text: `AM-GV9 ${call('a', 'echo 1')}${call('a', 'echo 1')}${call('b', 'echo 2')} AM-GV10 ${call('c', 'echo 9')}${call('c', 'echo 9')}`, records: [{ event: 'hard-pause' }] }),
  ])
  assert.deepEqual(g, { GV1: true, GV2: true, GV3: true, GV4: true, GV5: true, GV6: true, GV7: true, GV8: true, GV9: true, GV10: true })
})
test('missing evidence fails the step', () => {
  const g = gradeVscode([
    s({ id: 'a', text: 'AM-GV1 AM-GV2 AM-GV3', records: [{ event: 'warning', delivered: false }], checkpointSealed: true, checkpointMode: '644' }),
    s({ id: 'd', text: 'AM-GV7', records: [{ event: 'turn' }] }),
    // No pause record; and after am:continue an earlier echo ran again (a duplicated tool call).
    s({ id: 'p', text: `AM-GV9 ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => call(`e${n}`, `echo ${n}`)).join('')} AM-GV10 ${call('again', 'echo 2')}${call('c', 'echo 9')}`, records: [] }),
  ])
  assert.deepEqual(g, { GV1: false, GV2: false, GV3: false, GV4: false, GV5: false, GV6: false, GV7: false, GV8: false, GV9: false, GV10: false })
})
test('the live suite covers every guardian runtime capability once', () => {
  assert.deepEqual(CHECKS.map((c) => c.id), ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'])
  assert.equal(VSCODE_STEPS.filter((x) => x.guardianOff).length, 1)
})
