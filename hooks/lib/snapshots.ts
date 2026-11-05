// Session snapshots in the plugin store: which ones to drop before a save. Pure: no `$` and no I/O.
// The store holds 4 MiB of JSON in all, so only the newest sessions keep a snapshot. The store keeps insertion order,
// and a save re-inserts its own key, so the order is oldest first by last save.
export const SNAPSHOTS_KEPT = 40

export function snapshotsToDrop(keys: readonly string[], saving: string, kept = SNAPSHOTS_KEPT): string[] {
  const others = keys.filter((k) => k.startsWith('hm4:') && k !== saving)
  return others.slice(0, Math.max(0, others.length - (kept - 1)))
}
