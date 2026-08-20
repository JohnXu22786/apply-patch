#!/usr/bin/env node
/**
 * dsh-patch-apply — runnable example.
 *
 * Uses the library API directly (no CLI, no dsh runtime) against the example
 * `feature.patch` and fixture files created below, then undoes everything.
 *
 * Run from the package root:
 *   node examples/apply-example.mjs
 */
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  applyPatchText,
  applyUndo,
  statPatch,
  parsePatch,
  readJournal,
} from '../build/src/index.js'

const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-patch-apply-example-'))
const patchPath = new URL('./feature.patch', import.meta.url)
const patchText = await fsp.readFile(patchPath, 'utf8')

// Set up the target tree the patch expects. `notes/idea.txt` does NOT exist
// yet — the patch creates it (exercising both modify and create paths).
await fsp.writeFile(path.join(work, 'greeting.txt'), 'hello\nworld\ngoodbye\n')

console.log('workspace:', work)

// 1. stat — no filesystem reads.
const stat = statPatch(parsePatch(patchText))
console.log(`stat: ${stat.fileCount} file(s), +${stat.totalAdded}/-${stat.totalDeleted}`)

// 2. dry-run — proves applicability, writes nothing.
const dry = await applyPatchText(patchText, { root: work, dryRun: true })
console.log(`dry-run ok: ${dry.ok}, hunk #1 status: ${dry.files[0].hunks[0].status}`)

// 3. apply — all-or-nothing, writes an undo journal.
const applied = await applyPatchText(patchText, { root: work })
console.log(`applied: ok=${applied.ok}, undo journal=${applied.undoFile}`)
console.log('greeting.txt =>', JSON.stringify(await fsp.readFile(path.join(work, 'greeting.txt'), 'utf8')))
console.log('notes/idea.txt =>', JSON.stringify(await fsp.readFile(path.join(work, 'notes', 'idea.txt'), 'utf8')))

// 4. undo — restores byte-identical state from the recorded reverse patch.
const journal = await readJournal(applied.undoFile)
const undone = await applyUndo(journal)
console.log(`undo: ok=${undone.ok}`)
console.log('greeting.txt =>', JSON.stringify(await fsp.readFile(path.join(work, 'greeting.txt'), 'utf8')))

await fsp.rm(work, { recursive: true, force: true })
console.log('cleaned up', work)
