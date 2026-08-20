/**
 * Parser tests: format coverage, malformed-input precision, binary handling.
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { patchFixtureText } from './parse-helpers.ts'
import { parsePatch } from '../src/parse.ts'
import { PatchParseError, PatchUnsupportedError } from '../src/errors.ts'

test('parses the multi-file git fixture with kinds, hunks, counts, shas and modes', () => {
  const parsed = parsePatch(patchFixtureText('basic-multi.patch'))
  assert.equal(parsed.files.length, 5)

  const modify = parsed.files[0]!
  const create = parsed.files[1]!
  const del = parsed.files[2]!
  const rename = parsed.files[3]!
  const mode = parsed.files[4]!
  assert.equal(modify.kind, 'modify')
  assert.equal(modify.oldPath, 'hello.txt')
  assert.equal(modify.newPath, 'hello.txt')
  assert.equal(modify.oldSha, '1111111')
  assert.equal(modify.newSha, '2222222')
  assert.equal(modify.hunks.length, 1)
  const h = modify.hunks[0]!
  assert.equal(h.oldStart, 1)
  assert.equal(h.oldCount, 3)
  assert.equal(h.newCount, 3)
  assert.deepEqual(h.oldTexts, ['hello', 'world', 'goodbye'])
  assert.deepEqual(h.newLines.map((l) => l.text), ['hello', 'earth', 'goodbye'])
  assert.equal(h.newLines.filter((l) => l.kind === 'add').length, 1)

  assert.equal(create.kind, 'create')
  assert.equal(create.oldPath, null)
  assert.equal(create.newPath, 'newfile.txt')
  assert.equal(create.newMode, 0o100644)

  assert.equal(del.kind, 'delete')
  assert.equal(del.oldPath, 'gone.txt')
  assert.equal(del.newPath, null)
  assert.equal(del.hunks[0]!.oldStart, 1)
  assert.equal(del.hunks[0]!.oldCount, 2)
  assert.equal(del.hunks[0]!.newCount, 0)

  assert.equal(rename.kind, 'rename')
  assert.equal(rename.renameFrom, 'old.txt')
  assert.equal(rename.renameTo, 'newname.txt')
  assert.equal(rename.hunks.length, 0)

  assert.equal(mode.kind, 'mode')
  assert.equal(mode.oldMode, 0o100644)
  assert.equal(mode.newMode, 0o100755)
})

test('parses a bare ---/+++ patch without a git header', () => {
  const parsed = parsePatch(patchFixtureText('bare.patch'))
  assert.equal(parsed.files.length, 1)
  const f = parsed.files[0]!
  assert.equal(f.kind, 'modify')
  assert.equal(f.oldPath, 'plain.txt')
  assert.equal(f.hunks[0]!.newLines.filter((l) => l.kind === 'add')[0]!.text, '2')
})

test('parses CRLF patch text and a CRLF hunk body', () => {
  const crlfPatch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\r\n') + '\r\n'
  const parsed = parsePatch(crlfPatch)
  assert.equal(parsed.files[0]!.hunks[0]!.oldLines[0]!.text, 'old')
  assert.equal(parsed.files[0]!.hunks[0]!.newLines[0]!.text, 'new')
})

test('tracks \\ No newline at end of file markers per side', () => {
  const patch = [
    'diff --git a/f.txt b/f.txt',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1 +1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
  ].join('\n')
  const parsed = parsePatch(patch + '\n')
  const h = parsed.files[0]!.hunks[0]!
  assert.equal(h.oldLines[0]!.noNewline, true)
  assert.equal(h.newLines[0]!.noNewline, false)
  assert.equal(h.oldEndsWithoutNewline, true)
  assert.equal(h.newEndsWithoutNewline, false)

  // A marker after a context line applies to both sides.
  const patch2 = [
    'diff --git a/f.txt b/f.txt',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -2,2 +2,2 @@',
    ' x',
    '\\ No newline at end of file',
    ' y',
  ].join('\n')
  const parsed2 = parsePatch(patch2 + '\n')
  assert.equal(parsed2.files[0]!.hunks[0]!.oldLines[0]!.noNewline, true)
  assert.equal(parsed2.files[0]!.hunks[0]!.newLines[0]!.noNewline, true)
})

test('skips binary-labelled files and records the note', () => {
  const parsed = parsePatch(patchFixtureText('binary.patch'))
  assert.equal(parsed.files.length, 1)
  assert.equal(parsed.files[0]!.kind, 'binary')
  assert.equal(parsed.files[0]!.binary, true)
  assert.match(parsed.files[0]!.binaryNote ?? '', /Binary files/)
})

test('rejects a hunk with more lines than its header declares, with a precise line', () => {
  assert.throws(() => parsePatch(patchFixtureText('bad-count.patch')), (e: unknown) => {
    assert.ok(e instanceof PatchParseError)
    const err = e as PatchParseError
    assert.equal(err.code, 'PARSE')
    // Points at the hunk header line that was over-supplied.
    assert.equal(err.sourceLine, 4)
    assert.match(err.message, /more lines than its header declares/)
    return true
  })
})

test('rejects a hunk cut off by end-of-input with counts listed', () => {
  const patch = [
    'diff --git a/f.txt b/f.txt',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,2 +1,2 @@',
    ' only one',
  ].join('\n')
  assert.throws(() => parsePatch(patch + '\n'), (e: unknown) => {
    assert.ok(e instanceof PatchParseError)
    assert.match((e as PatchParseError).message, /expected 2 old \/ 2 new/)
    assert.equal((e as PatchParseError).sourceLine, 4)
    return true
  })
})

test('rejects a stray line inside an open (unsatisfied) hunk with its patch line number', () => {
  const patch = [
    'diff --git a/f.txt b/f.txt',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,2 +1,2 @@',
    ' ok',
    'not a diff line',
  ].join('\n')
  assert.throws(() => parsePatch(patch + '\n'), (e: unknown) => {
    assert.ok(e instanceof PatchParseError)
    assert.equal((e as PatchParseError).sourceLine, 6)
    assert.match((e as PatchParseError).message, /unexpected line inside hunk body/)
    return true
  })
})

test('rejects combined (diff --cc) diffs as unsupported', () => {
  const patch = [
    'diff --cc a/f.txt b/f.txt b/f.txt',
    'index 1111111,2222222..3333333',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@@ -1,10 -1,10 +1,10 @@@',
    ' hi',
  ].join('\n')
  assert.throws(() => parsePatch(patch + '\n'), (e: unknown) => {
    assert.ok(e instanceof PatchUnsupportedError)
    assert.equal(e.code, 'UNSUPPORTED')
    return true
  })
})

test('rejects a patch with no file blocks at all', () => {
  assert.throws(() => parsePatch('\n\njust text\n'), (e: unknown) => {
    assert.ok(e instanceof PatchParseError)
    assert.match((e as PatchParseError).message, /no file blocks/)
    return true
  })
})

test('parses a quoted path with spaces', () => {
  const patch = [
    'diff --git "a/we ird.txt" "b/we ird.txt"',
    '--- "a/we ird.txt"',
    '+++ "b/we ird.txt"',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\n')
  const parsed = parsePatch(patch + '\n')
  assert.equal(parsed.files[0]!.oldPath, 'we ird.txt')
  assert.equal(parsed.files[0]!.newPath, 'we ird.txt')
})

test('tolerates trailing noise lines between file blocks', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    '',
    'noise that is ignored',
    '',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '-p',
    '+q',
  ].join('\n')
  const parsed = parsePatch(patch)
  assert.equal(parsed.files.length, 2)
})

test('supports consecutive hunks with offset line numbers and section headings', () => {
  const parsed = parsePatch(patchFixtureText('consecutive-hunks.patch'))
  const f = parsed.files[0]!
  assert.equal(f.hunks.length, 2)
  assert.equal(f.hunks[0]!.oldStart, 1)
  assert.equal(f.hunks[1]!.oldStart, 5)
  assert.equal(f.hunks[0]!.section, 'first section')
  assert.equal(f.hunks[1]!.section, 'second section')
})

test('deletion with oldStart 0 maps to file start insertion', () => {
  const patch = [
    'diff --git a/empty.txt b/empty.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/empty.txt',
    '@@ -0,0 +1,2 @@',
    '+a',
    '+b',
  ].join('\n')
  const parsed = parsePatch(patch + '\n')
  const h = parsed.files[0]!.hunks[0]!
  assert.equal(h.oldStart, 0)
  assert.equal(h.oldCount, 0)
  assert.equal(h.newCount, 2)
})

test('duplicated target path across blocks parses both blocks', () => {
  const patch = [
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1 +1 @@',
    '-1',
    '+2',
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1 +1 @@',
    '-2',
    '+3',
  ].join('\n')
  const parsed = parsePatch(patch + '\n')
  assert.equal(parsed.files.length, 2)
})

test('ignores similarity/dissimilarity and old/new-file accounting lines', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/b.ts',
    'similarity index 87%',
    'rename from src/a.ts',
    'rename to src/b.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/b.ts',
    '@@ -1,2 +1,2 @@',
    ' import { x }',
    '-export const a',
    '+export const b',
  ].join('\n')
  const parsed = parsePatch(patch + '\n')
  const f = parsed.files[0]!
  assert.equal(f.kind, 'rename')
  assert.equal(f.hunks.length, 1)
  assert.equal(f.oldSha, '1111111')
})
