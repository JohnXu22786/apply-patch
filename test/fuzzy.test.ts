/**
 * Hunk-locating tests: exact anchor, line-offset correction, fuzzy matching
 * with context tolerance, and the refusal paths when deletions cannot be bolted.
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { applyPatchText } from '../src/apply.ts'
import { splitLines, joinLines } from '../src/lines.ts'
import { transformLines } from '../src/engine.ts'
import { parsePatch } from '../src/parse.ts'
import { blobSha } from '../src/sha.ts'
import * as help from './helpers.ts'

function hunksOf(patch: string | string[]): ReturnType<typeof parsePatch>['files'][number]['hunks'] {
  const text = Array.isArray(patch) ? patch.join('\n') : patch
  return parsePatch(text + '\n').files[0]!.hunks
}

test('applies at the exact anchor when headers match the file', () => {
  const { lines, eol } = splitLines('a\nb\nc\n')
  const result = transformLines(lines, eol, hunksOf([
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    '@@ -1,3 +1,3 @@',
    ' a',
    '-b',
    '+B',
    ' c',
  ]), { fuzzContext: 3, fileLabel: 'f' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.applied[0]!.status, 'exact')
  assert.equal(joinLines(result.lines), 'a\nB\nc\n')
})

test('corrects a line-offset drift by finding the exact block elsewhere', () => {
  // The patch was generated when 'a/b/c' sat at lines 1-3; a line was later
  // inserted above, shifting everything down.
  const { lines, eol } = splitLines('x\na\nb\nc\n')
  const result = transformLines(lines, eol, hunksOf([
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    '@@ -1,3 +1,3 @@',
    ' a',
    '-b',
    '+B',
    ' c',
  ]), { fuzzContext: 3, fileLabel: 'f' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.applied[0]!.status, 'offset')
  assert.equal(result.applied[0]!.atLine, 2)
  assert.equal(joinLines(result.lines), 'x\na\nB\nc\n')
})

test('bolts a fuzzy match on trailing deletions when leading context drifted', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    // Patch expects old-file 'alpha beta gamma'; the file now has 'alpha-prime
    // beta gamma' â€” the leading context line changed but the deletion matches.
    await help.write(dir, 'f.txt', 'alpha-prime\nbeta\ngamma\n')
    const patch = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.equal(report.files[0]!.hunks[0]!.status, 'fuzzy')
    assert.equal(report.files[0]!.hunks[0]!.fuzz, 1)
    assert.equal(await help.read(path.join(dir, 'f.txt')), 'alpha-prime\nBETA\ngamma\n')
  } finally {
    await cleanup()
  }
})

test('refuses to fuzz when the deletion lines themselves do not match', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'f.txt', 'alpha\nXX\nYY\n')
    const patch = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.equal(report.ok, false)
    assert.equal(report.conflicts.length, 1)
    assert.match(report.conflicts[0]!.reason, /does not match/)
    // Nothing was written.
    assert.equal(await help.read(path.join(dir, 'f.txt')), 'alpha\nXX\nYY\n')
  } finally {
    await cleanup()
  }
})

test('fuzzy matching still fails cleanly with zero usable context lines', () => {
  // Hunk whose only old line is a deletion ('z' is not present): nothing to
  // fuzz against and no exact match, so it must conflict.
  const { lines, eol } = splitLines('a\nb\n')
  const result = transformLines(lines, eol, hunksOf([
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    '@@ -1,1 +0,0 @@',
    '-z',
  ]), { fuzzContext: 3, fileLabel: 'f' })
  assert.ok(!result.ok)
})

test('matches hunks against a file without a trailing newline only at EOF', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    const abs = await help.write(dir, 'nl.txt', 'last')
    const patch = [
      'diff --git a/nl.txt b/nl.txt',
      '--- a/nl.txt',
      '+++ b/nl.txt',
      '@@ -1 +1 @@',
      '-last',
      '\\ No newline at end of file',
      '+LAST',
      '\\ No newline at end of file',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.equal(await help.read(abs), 'LAST')
  } finally {
    await cleanup()
  }
})

test('rejects a no-newline requirement when the file ends with a newline', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'nl.txt', 'last\n')
    const patch = [
      'diff --git a/nl.txt b/nl.txt',
      '--- a/nl.txt',
      '+++ b/nl.txt',
      '@@ -1 +1 @@',
      '-last',
      '\\ No newline at end of file',
      '+LAST',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.equal(report.ok, false)
    assert.equal(report.conflicts.length, 1)
    assert.match(report.conflicts[0]!.reason, /without a trailing newline/)
  } finally {
    await cleanup()
  }
})

test('insertion-only hunks (oldCount 0) insert at the anchor', () => {
  const { lines, eol } = splitLines('')
  const result = transformLines(lines, eol, hunksOf([
    'diff --git a/f b/f',
    '--- /dev/null',
    '+++ b/f',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
  ]), { fuzzContext: 3, fileLabel: 'f' })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(joinLines(result.lines), 'one\ntwo\n')
})

test('non-overlapping hunks are applied in order with net-shift anchors', () => {
  const { lines, eol } = splitLines('1\n2\n3\n4\n5\n')
  const result = transformLines(lines, eol, hunksOf([
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    '@@ -1,2 +1,3 @@',
    ' 1',
    ' 2',
    '+1.5',
    '@@ -4,2 +5,2 @@',
    ' 4',
    '-5',
    '+5!',
  ]), { fuzzContext: 3, fileLabel: 'f' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(joinLines(result.lines), '1\n2\n1.5\n3\n4\n5!\n')
    assert.equal(result.applied.length, 2)
    assert.equal(result.applied[1]!.status, 'exact')
  }
})

test('blob SHA-1 follows the git blob format and mismatches surface as notes', async () => {
  // Cross-check blobSha against an independent, buffer-based construction so
  // the format string (`blob <len>\0` + content) stays pinned to git's spec.
  const content = 'hello\nworld\n'
  const independent = createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(content, 'utf8')}\0`), Buffer.from(content, 'utf8')]))
    .digest('hex')
  assert.equal(blobSha(content), independent)
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'hash.txt', 'some\n')
    const patch = [
      'diff --git a/hash.txt b/hash.txt',
      'index 1111111..2222222 100644',
      '--- a/hash.txt',
      '+++ b/hash.txt',
      '@@ -1 +1 @@',
      '-some',
      '+other',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    // sha mismatch is a note by default, not a hard failure.
    assert.ok(report.notes.length >= 1)
    assert.match(report.notes[0]!, /SHA-1/)
    assert.equal(await help.read(path.join(dir, 'hash.txt')), 'other\n')
  } finally {
    await cleanup()
  }
})

test('strictSha turns a mismatch into a hard conflict', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'hash.txt', 'some\n')
    const patch = [
      'diff --git a/hash.txt b/hash.txt',
      'index 1111111..2222222 100644',
      '--- a/hash.txt',
      '+++ b/hash.txt',
      '@@ -1 +1 @@',
      '-some',
      '+other',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir, strictSha: true })
    assert.equal(report.ok, false)
    assert.equal(report.conflicts.length, 1)
    // Strict sha rejection still writes nothing.
    assert.equal(await help.read(path.join(dir, 'hash.txt')), 'some\n')
  } finally {
    await cleanup()
  }
})

test('abbreviated index shas (git core.abbrev) match by prefix without noise', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'ab.txt', 'alpha\nbeta\n')
    const oldAbbrev = blobSha('alpha\nbeta\n').slice(0, 7)
    const newFull = blobSha('alpha\nBETA\n')
    const patch = [
      'diff --git a/ab.txt b/ab.txt',
      `index ${oldAbbrev}..${newFull} 100644`,
      '--- a/ab.txt',
      '+++ b/ab.txt',
      '@@ -1,2 +1,2 @@',
      ' alpha',
      '-beta',
      '+BETA',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    // Abbreviated old sha matches by prefix; new sha is full and matches.
    assert.equal(report.notes.length, 0)
  } finally {
    await cleanup()
  }
})

test('sha round-trips when content genuinely matches the index line', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    const before = await help.write(dir, 'ok.txt', 'alpha\nbeta\n')
    const oldSha = blobSha('alpha\nbeta\n')
    const newSha = blobSha('alpha\nBETA\n')
    const patch = [
      'diff --git a/ok.txt b/ok.txt',
      `index ${oldSha}..${newSha} 100644`,
      '--- a/ok.txt',
      '+++ b/ok.txt',
      '@@ -1,2 +1,2 @@',
      ' alpha',
      '-beta',
      '+BETA',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.equal(report.notes.length, 0)
    assert.equal(await help.read(before), 'alpha\nBETA\n')
  } finally {
    await cleanup()
  }
})
