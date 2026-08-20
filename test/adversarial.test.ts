/**
 * Adversarial tests: round-trips through offset/fuzzy locations, whole-file
 * reversal of empty and insertion-only changes, guarded deletes, and the
 * beforeCommit failure seam.
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { applyPatchText, applyUndo } from '../src/apply.ts'
import { readJournal } from '../src/journal.ts'
import * as help from './helpers.ts'

/** Config the patch hunk drifted down by one line; undo must restore. */
async function roundTrip(patch: string, seeds: Array<[string, string]>): Promise<void> {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    for (const [rel, content] of seeds) await help.write(dir, rel, content)
    const before = await snapshot(dir)
    const report = await applyPatchText(patch, { root: dir })
    assert.ok(report.ok, JSON.stringify(report.errors))
    assert.notDeepEqual(await snapshot(dir), before)
    const journal = await readJournal(report.undoFile!)
    const undo = await applyUndo(journal)
    assert.ok(undo.ok, JSON.stringify(undo.errors))
    assert.deepEqual(await snapshot(dir), before)
  } finally {
    await cleanup()
  }
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(dir, rel)
    for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(child)
      else if (child !== '.dsh-patch-undo.json') out[child] = await fsp.readFile(path.join(abs, entry.name), 'utf8')
    }
  }
  await walk('')
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

test('offset-located hunks undo byte-identically', async () => {
  // A line inserted above pushes the hunk down by one; the locator uses the
  // offset path and the reverse patch must still restore the exact original.
  const patch = [
    'diff --git a/drift.txt b/drift.txt',
    '--- a/drift.txt',
    '+++ b/drift.txt',
    '@@ -1,3 +1,3 @@',
    ' aa',
    '-bb',
    '+BB',
    ' cc',
  ].join('\n') + '\n'
  await roundTrip(patch, [['drift.txt', 'x\naa\nbb\ncc\n']])
})

test('fuzzy-located hunks undo byte-identically (fuzzed context not duplicated)', async () => {
  const patch = [
    'diff --git a/fz.txt b/fz.txt',
    '--- a/fz.txt',
    '+++ b/fz.txt',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-beta',
    '+BETA',
    ' gamma',
  ].join('\n') + '\n'
  // alpha-prime is a drifted leading context line → fuzzy match.
  await roundTrip(patch, [['fz.txt', 'alpha-prime\nbeta\ngamma\n']])
})

test('empty-file create + undo remove round-trips', async () => {
  const patch = [
    'diff --git a/empty.txt b/empty.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/empty.txt',
  ].join('\n') + '\n'
  await roundTrip(patch, [])
})

test('multi-hunk undo round-trips when hunks are separated by preserved lines', async () => {
  // Two hunks in one file with untouched lines between them: the reverse patch
  // must anchor the second hunk at its real final-file position, not accumulate.
  const patch = [
    'diff --git a/multi.txt b/multi.txt',
    '--- a/multi.txt',
    '+++ b/multi.txt',
    '@@ -1,2 +1,3 @@',
    ' 1',
    ' 2',
    '+1.5',
    '@@ -5,2 +6,2 @@',
    ' 5',
    '-new5',
    '+NEW5',
  ].join('\n') + '\n'
  await roundTrip(patch, [['multi.txt', '1\n2\n3\n4\n5\nnew5\n']])
})

test('insertion-only hunk round-trips (undeclared-count old side)', async () => {
  const patch = [
    'diff --git a/ins.txt b/ins.txt',
    '--- a/ins.txt',
    '+++ b/ins.txt',
    '@@ -1,1 +1,3 @@',
    ' base',
    '+added1',
    '+added2',
  ].join('\n') + '\n'
  await roundTrip(patch, [['ins.txt', 'base\n']])
})

test('multi-file rename+content undo round-trips', async () => {
  const patch = [
    'diff --git a/src.txt b/dst.txt',
    'similarity index 50%',
    'rename from src.txt',
    'rename to dst.txt',
    '--- a/src.txt',
    '+++ b/dst.txt',
    '@@ -1,2 +1,2 @@',
    ' import { a }',
    '-export const x = 1',
    '+export const x = 2',
  ].join('\n') + '\n'
  await roundTrip(patch, [['src.txt', 'import { a }\nexport const x = 1\n']])
})

test('a concurrent modify of a to-be-deleted file trips the STALE guard (no accidental unlink)', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'victim.txt', 'will be deleted\n')
    await help.write(dir, 'new.txt', 'pre\n')
    const patch = [
      'diff --git a/new.txt b/new.txt',
      '--- a/new.txt',
      '+++ b/new.txt',
      '@@ -1 +1 @@',
      '-pre',
      '+POST',
      '',
      'diff --git a/victim.txt b/victim.txt',
      'deleted file mode 100644',
      '--- a/victim.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-will be deleted',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, {
      root: dir,
      // The victim is overwritten between validation and removal → STALE.
      beforeCommit: async () => {
        await fsp.writeFile(path.join(dir, 'victim.txt'), 'CONCURRENT EDIT\n', 'utf8')
      },
    })
    assert.equal(report.ok, false)
    assert.equal(report.errors[0]!.code, 'STALE')
    // The modified target survives; the earlier content write was rolled back.
    assert.equal(await help.read(path.join(dir, 'victim.txt')), 'CONCURRENT EDIT\n')
    assert.equal(await help.read(path.join(dir, 'new.txt')), 'pre\n')
  } finally {
    await cleanup()
  }
})

test('a beforeCommit failure aborts cleanly before any mutation', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'f.txt', 'a\nb\n')
    const patch = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, {
      root: dir,
      beforeCommit: async () => {
        throw new Error('seam failure')
      },
    })
    assert.equal(report.ok, false)
    assert.equal(report.errors[0]!.code, 'IO')
    assert.match(report.errors[0]!.message, /seam failure/)
    assert.equal(await help.read(path.join(dir, 'f.txt')), 'a\nb\n')
  } finally {
    await cleanup()
  }
})
