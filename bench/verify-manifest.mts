#!/usr/bin/env node
// Checks a result manifest against the files beside it. Exit 1 if any file changed or is missing.
// Usage: node bench/verify-manifest.mts bench/results/run.manifest.json
import fs from 'node:fs'
import path from 'node:path'
import { verifyManifest } from './lib/manifest.mts'

const file = process.argv[2]
if (!file) { console.error('usage: node bench/verify-manifest.mts <manifest.json>'); process.exit(2) }
const changed = verifyManifest(JSON.parse(fs.readFileSync(file, 'utf8')), path.dirname(file))
if (changed.length) { console.error(`These files do not match the manifest: ${changed.join(', ')}`); process.exit(1) }
console.log('Every file matches the manifest.')
