// Terminal-Bench runs through Harbor, which owns its containers and its agents. This builds the command and reads the score.
// Harbor's docs do not state the per-trial schema. The field below comes from its output, so a different shape stops the
// import rather than turning into a zero. Check it against one real trial first.
export const harborCommand = (agent: string, model: string, limit: number) =>
  ['harbor', 'run', '-d', 'terminal-bench/terminal-bench-2', '-a', agent, '-m', model, '-l', String(limit)]

export function trialReward(trial: any) {
  const reward = trial?.verifier_result?.rewards?.reward
  if (typeof reward !== 'number') throw new Error('this trial has no verifier_result.rewards.reward: check the Harbor format')
  return reward
}

export function summarizeTrials(trials: any[]) {
  const rewards = trials.map(trialReward)
  return { trials: rewards.length, solved: rewards.filter((r) => r >= 1).length, mean_reward: rewards.length ? rewards.reduce((a, b) => a + b, 0) / rewards.length : null }
}
