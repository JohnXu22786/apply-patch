/**
 * Conflict reporting tests: precise hunk numbers, patch line numbers, and
 * expected-vs-actual excerpts.
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import * as path from 'node:path'
import { applyPatchText } from '../src/apply.ts'
import { PatchConflictError } from '../src/errors.ts'
import { transformLines } from '../src/engine.ts'
import { splitLines } from '../src/lines.ts'
import { parsePatch } from '../src/parse.ts'
import * as help from './helpers.ts'

test('conflict report names file, 1-based hunk number, patch line and both contents', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'f.txt', 'line-1\nline-2\nline-3\n')
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
    const c = report.conflicts[0]!
    assert.equal(c.file, path.join(dir, 'f.txt'))
    assert.equal(c.hunkNumber, 1)
    assert.equal(c.sourceLine, 4)
    assert.ok(c.expected.includes('alpha'))
    assert.ok(c.expected.includes('beta'))
    assert.ok(c.actual.includes('line-1'))
    assert.ok(c.reason.length > 0)
    // Nothing was modified.
    assert.equal(await help.read(path.join(dir, 'f.txt')), 'line-1\nline-2\nline-3\n')
  } finally {
    await cleanup()
  }
})

test('a failing second hunk is reported with hunkNumber 2 and its own source line', () => {
  const { lines, eol } = splitLines('a\nb\nc\nd\nX\nY\n')
  const result = transformLines(lines, eol, parsePatch([
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    '@@ -1,2 +1,2 @@',
    ' a',
    '-b',
    '+B',
    '@@ -5,2 +5,2 @@',
    ' e',
    '-f',
    '+F',
  ].join('\n') + '\n').files[0]!.hunks, { fuzzContext: 3, fileLabel: 'f' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.conflict.hunkNumber, 2)
  assert.equal(result.conflict.sourceLine, 8)
  assert.deepEqual(result.conflict.expected, ['e', 'f'])
})

test('transform conflict is wrapped as a typed error whose code is CONFLICT', () => {
  const { lines, eol } = splitLines('aaa\nbbb\n')
  const hunks = parsePatch([
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    '@@ -1,2 +1,2 @@',
    ' x',
    '-y',
    '+z',
  ].join('\n') + '\n').files[0]!.hunks
  const result = transformLines(lines, eol, hunks, { fuzzContext: 3, fileLabel: 'f' })
  assert.equal(result.ok, false)
  if (result.ok) return
  const err = new PatchConflictError('boom', result.conflict)
  assert.equal(err.code, 'CONFLICT')
  assert.equal(err.conflict.file, 'f')
})

test('conflicts in every file of a patch are all reported', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'a.txt', 'aaa\n')
    await help.write(dir, 'b.txt', 'bbb\n')
    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-changed',
      '+one',
      'diff --git a/b.txt b/b.txt',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1 +1 @@',
      '-changed',
      '+two',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.equal(report.ok, false)
    assert.equal(report.conflicts.length, 2)
    assert.equal(report.conflicts[0]!.file, path.join(dir, 'a.txt'))
    assert.equal(report.conflicts[1]!.file, path.join(dir, 'b.txt'))
  } finally {
    await cleanup()
  }
})

test('a missing target file is reported as a VALIDATION error, not a panic', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    const patch = [
      'diff --git a/nope.txt b/nope.txt',
      '--- a/nope.txt',
      '+++ b/nope.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.equal(report.ok, false)
    assert.equal(report.errors.length, 1)
    assert.equal(report.errors[0]!.code, 'VALIDATION')
    assert.match(report.errors[0]!.message, /not found/)
  } finally {
    await cleanup()
  }
})

test('a non-parseable patch fails with code PARSE and a patch line number', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    const report = await applyPatchText('this is not a patch at all\n', { root: dir })
    assert.equal(report.ok, false)
    assert.equal(report.errors[0]!.code, 'PARSE')
  } finally {
    await cleanup()
  }
})
