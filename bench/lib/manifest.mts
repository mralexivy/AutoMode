// A manifest ties a report to its inputs: file hashes, the experiment, the harness revision and the price date. If a
// number moves, the hashes show whether the data moved or the analysis did.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface Manifest {
  schema_version: 1
  generated_at: string
  files: { name: string; sha256: string; rows: number }[]
  experiments: string[]
  harness_revisions: string[]
  spec_hashes: number
  pricing_snapshots: string[]
  cost_basis: string[]
}

const distinct = (xs: unknown[]) => [...new Set(xs.filter((x): x is string => typeof x === 'string'))].sort()

export function buildManifest(files: string[], now = new Date()): Manifest {
  const rows = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  return {
    schema_version: 1, generated_at: now.toISOString(),
    files: files.map((f) => {
      const text = fs.readFileSync(f)
      return { name: path.basename(f), sha256: crypto.createHash('sha256').update(text).digest('hex'), rows: text.toString('utf8').split('\n').filter(Boolean).length }
    }),
    experiments: distinct(rows.map((r) => r.experiment)),
    harness_revisions: distinct(rows.map((r) => r.harness?.git_sha)),
    spec_hashes: distinct(rows.map((r) => r.spec_hash)).length,
    pricing_snapshots: distinct(rows.map((r) => r.pricing_snapshot)),
    cost_basis: distinct(rows.map((r) => r.cost_basis)),
  }
}

// verifyManifest returns the files that no longer match. Empty means the report's inputs are intact.
export function verifyManifest(m: Manifest, dir: string) {
  return m.files.filter((f) => {
    const p = path.join(dir, f.name)
    return !fs.existsSync(p) || crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') !== f.sha256
  }).map((f) => f.name)
}
