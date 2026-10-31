// External benchmarks, each pinned to a dataset revision. Their data goes to bench/.cache and never into this repository.
export interface DatasetInfo {
  id: string
  kind: 'swebench' | 'bigcodebench' | 'livecodebench' | 'terminal-bench' | 'safety'
  source: string
  revision: string
  split?: string
  file?: string
  license: string
  use: string
}

export const DATASETS: Record<string, DatasetInfo> = {
  'swebench-verified': { id: 'swebench-verified', kind: 'swebench', source: 'princeton-nlp/SWE-bench_Verified', revision: 'c104f840cc67f8b6eec6f759ebc8b2693d585d4a', split: 'test', license: 'see the dataset card', use: 'Primary external repository benchmark' },
  'swebench-multilingual': { id: 'swebench-multilingual', kind: 'swebench', source: 'SWE-bench/SWE-bench_Multilingual', revision: '846e647b9f33c0b51b739d005d13d85493c9af09', split: 'test', license: 'see the dataset card', use: 'Secondary repository benchmark across languages' },
  bigcodebench: { id: 'bigcodebench', kind: 'bigcodebench', source: 'bigcode/bigcodebench', revision: 'b74c0d0bf70d2c0bc459be537895cca163007f1a', split: 'v0.1.4', license: 'apache-2.0', use: 'Function-level diagnostic only. Upstream is archived, so treat it as frozen' },
  livecodebench: { id: 'livecodebench', kind: 'livecodebench', source: 'livecodebench/code_generation_lite', revision: '0fe84c3912ea0c4d4a78037083943e8f0c4dd505', file: 'test6.jsonl', license: 'cc (read the card before publishing)', use: 'Fast capability check and contamination monitor. Not repository engineering' },
  // Safety sets are for refusal measures only, and only through bench/safety-model.mts. Harmbench needs a Hugging Face token.
  harmbench: { id: 'harmbench', kind: 'safety', source: 'walledai/HarmBench', revision: 'fb6c2afd5a2a943d701d6db3efab87d077e81be5', split: 'train', license: 'mit', use: 'Refusal on red-team prompts. Gated: accept its terms first' },
  'real-toxicity-prompts': { id: 'real-toxicity-prompts', kind: 'safety', source: 'allenai/real-toxicity-prompts', revision: 'f21629712ffd6a3d13a54fd2807ccd521c55ef74', split: 'train', license: 'apache-2.0', use: 'Toxic continuation prompts. Scoring needs a classifier this repository does not have' },
  toxigen: { id: 'toxigen', kind: 'safety', source: 'toxigen/toxigen-data', revision: 'ea082a8973a287097b17973343576e0c8da8eb3b', split: 'train', license: 'see the dataset card', use: 'Toxicity and bias diagnostic. Scoring needs a classifier this repository does not have' },
  'terminal-bench': { id: 'terminal-bench', kind: 'terminal-bench', source: 'terminal-bench/terminal-bench-2', revision: 'harbor registry', license: 'see the dataset card', use: 'Terminal and agent capability, run by Harbor' },
}
