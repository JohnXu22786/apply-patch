/**
 * Apply tests: single- and multi-file application on the real filesystem,
 * EOL and no-trailing-newline fidelity, create/delete/rename/copy/mode,
 * binary skipping, dry-run purity, and undo round-trips.
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { applyPatchText, applyUndo } from '../src/apply.ts'
import { readJournal } from '../src/journal.ts'
import * as help from './helpers.ts'

test('applies a single modify hunk byte-for-byte with a matching target', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'hello.txt', 'hello\nworld\ngoodbye\n')
    const report = await applyPatchText([
      'diff --git a/hello.txt b/hello.txt',
      '--- a/hello.txt',
      '+++ b/hello.txt',
      '@@ -1,3 +1,3 @@',
      ' hello',
      '-world',
      '+earth',
      ' goodbye',
    ].join('\n') + '\n', { root: dir })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.equal(await help.read(path.join(dir, 'hello.txt')), 'hello\nearth\ngoodbye\n')
  } finally {
    await cleanup()
  }
})

test('applies create / delete / rename / mode blocks of the multi-file fixture', async () => {
  const { dir, cleanup } = await help.setupBasicWorkspace()
  try {
    const report = await applyPatchText(await help.fixture('basic-multi.patch'), { root: dir })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.deepEqual(
      report.files.map((f) => f.operation).sort(),
      ['create', 'delete', 'mode', 'modify', 'rename'],
    )
    assert.equal(await help.read(path.join(dir, 'newfile.txt')), 'line one\nline two\n')
    await assert.rejects(fsp.access(path.join(dir, 'gone.txt')))
    await assert.rejects(fsp.access(path.join(dir, 'old.txt')))
    assert.equal(await help.read(path.join(dir, 'newname.txt')), 'keep me\n')
    assert.equal(await help.read(path.join(dir, 'unrelated.txt')), 'untouched\n')
  } finally {
    await cleanup()
  }
})

test('preserves CRLF line endings across a modify applied from an LF patch', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'win.txt', 'one\r\ntwo\r\nthree\r\n')
    const patch = [
      'diff --git a/win.txt b/win.txt',
      '--- a/win.txt',
      '+++ b/win.txt',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+2',
      ' three',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.ok(report.ok)
    assert.equal(await help.read(path.join(dir, 'win.txt')), 'one\r\n2\r\nthree\r\n')
  } finally {
    await cleanup()
  }
})

test('adds a trailing newline when the patch says the new file has one', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    const abs = await help.write(dir, 'eof-no-newline.txt', 'no final newline')
    const report = await applyPatchText(await help.fixture('norewline.patch'), { root: dir })
    assert.ok(report.ok, JSON.stringify(report.errors))
    assert.equal(await help.read(abs), 'no final newline\n')
  } finally {
    await cleanup()
  }
})

test('removes a trailing newline when the patch adds the no-newline marker', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    const abs = await help.write(dir, 'f.txt', 'line\n')
    const patch = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1 +1 @@',
      '-line',
      '+line',
      '\\ No newline at end of file',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.ok(report.ok, JSON.stringify(report.errors))
    assert.equal(await help.read(abs), 'line')
  } finally {
    await cleanup()
  }
})

test('rename with content hunks moves and transforms the source', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'src.ts', 'import { a }\nexport const a = 1\n')
    const patch = [
      'diff --git a/src.ts b/dest.ts',
      'similarity index 50%',
      'rename from src.ts',
      'rename to dest.ts',
      '--- a/src.ts',
      '+++ b/dest.ts',
      '@@ -1,2 +1,2 @@',
      ' import { a }',
      '-export const a = 1',
      '+export const a = 2',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.ok(report.ok, JSON.stringify(report.errors))
    assert.equal(await help.read(path.join(dir, 'dest.ts')), 'import { a }\nexport const a = 2\n')
    await assert.rejects(fsp.access(path.join(dir, 'src.ts')))
  } finally {
    await cleanup()
  }
})

test('copy duplicates the source and leaves it in place', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'a.txt', 'same\ncontent\n')
    const patch = [
      'diff --git a/a.txt b/b.txt',
      'similarity index 100%',
      'copy from a.txt',
      'copy to b.txt',
      '--- a/a.txt',
      '+++ b/b.txt',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.ok(report.ok, JSON.stringify(report.errors))
    assert.equal(await help.read(path.join(dir, 'a.txt')), 'same\ncontent\n')
    assert.equal(await help.read(path.join(dir, 'b.txt')), 'same\ncontent\n')
  } finally {
    await cleanup()
  }
})

test('mode-only patch changes file permissions when the host supports it', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'tool.sh', '#!/bin/sh\n')
    const patch = [
      'diff --git a/tool.sh b/tool.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.ok(report.ok, JSON.stringify(report.errors))
    const st = await fsp.stat(path.join(dir, 'tool.sh'))
    if (process.platform !== 'win32') {
      // Windows has no real permission bits beyond the read-only flag.
      assert.notEqual(st.mode & 0o777, 0o644)
    }
  } finally {
    await cleanup()
  }
})

test('skips binary-labelled files without applying anything to them', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    const report = await applyPatchText(await help.fixture('binary.patch'), { root: dir })
    assert.ok(report.ok)
    assert.equal(report.files[0]!.operation, 'binary')
    await assert.rejects(fsp.access(path.join(dir, 'image.png')))
  } finally {
    await cleanup()
  }
})

test('skips a text patch whose target is actually binary (NUL bytes)', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'data.bin', Buffer.from([1, 0, 2, 3, 4]))
    const patch = [
      'diff --git a/data.bin b/data.bin',
      '--- a/data.bin',
      '+++ b/data.bin',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.ok(report.ok)
    assert.equal(report.files[0]!.operation, 'binary')
    assert.ok((report.files[0]!.skipReason ?? '').includes('binary'))
  } finally {
    await cleanup()
  }
})

test('dry-run validates applicability without writing or journaling', async () => {
  const { dir, cleanup } = await help.setupBasicWorkspace()
  try {
    const before = await help.read(path.join(dir, 'hello.txt'))
    const report = await applyPatchText(await help.fixture('basic-multi.patch'), { root: dir, dryRun: true })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.equal(report.dryRun, true)
    assert.equal(report.undoFile, null)
    assert.equal(await help.read(path.join(dir, 'hello.txt')), before)
    await assert.rejects(fsp.access(path.join(dir, 'newfile.txt')))
  } finally {
    await cleanup()
  }
})

test('multi-file patch is all-or-nothing: a conflict prevents every write', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    // All fixture prerequisites exist, but hello.txt does not match the hunk,
    // so the whole patch must be rejected and newfile never created.
    await help.write(dir, 'hello.txt', 'totally\ndifferent\ncontent\n')
    await help.write(dir, 'gone.txt', 'just\ngone\n')
    await help.write(dir, 'old.txt', 'keep me\n')
    await help.write(dir, 'script.sh', '#!/bin/sh\n')
    const report = await applyPatchText(await help.fixture('basic-multi.patch'), { root: dir })
    assert.equal(report.ok, false)
    assert.equal(report.conflicts.length, 1)
    assert.equal(report.conflicts[0]!.file, path.join(dir, 'hello.txt'))
    await assert.rejects(fsp.access(path.join(dir, 'newfile.txt')))
    assert.equal(await help.read(path.join(dir, 'hello.txt')), 'totally\ndifferent\ncontent\n')
  } finally {
    await cleanup()
  }
})

test('structural violation (create over an existing file) aborts without writes', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'newfile.txt', 'already here\n')
    await help.write(dir, 'hello.txt', 'hello\nworld\ngoodbye\n')
    const report = await applyPatchText(await help.fixture('basic-multi.patch'), { root: dir })
    assert.equal(report.ok, false)
    assert.equal(report.errors.length, 1)
    assert.equal(report.errors[0]!.code, 'VALIDATION')
    assert.match(report.errors[0]!.message, /already exists/)
  } finally {
    await cleanup()
  }
})

test('blocked path escape fails validation without touching the root', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    const patch = [
      'diff --git a/../../evil.txt b/../../evil.txt',
      '--- a/../../evil.txt',
      '+++ b/../../evil.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.equal(report.ok, false)
    assert.equal(report.errors[0]!.code, 'VALIDATION')
    assert.match(report.errors[0]!.message, /escapes the root/)
  } finally {
    await cleanup()
  }
})

test('undo round-trip restores every file byte-identically', async () => {
  const { dir, cleanup } = await help.setupBasicWorkspace()
  try {
    const before = await snapshot(dir)
    const report = await applyPatchText(await help.fixture('basic-multi.patch'), { root: dir })
    assert.ok(report.ok, JSON.stringify(report.errors))
    assert.ok(report.undoFile !== null)
    const after = await snapshot(dir)
    assert.notDeepEqual(after, before)
    assert.equal(after['hello.txt'], 'hello\nearth\ngoodbye\n')

    const journal = await readJournal(report.undoFile!)
    const undo = await applyUndo(journal)
    assert.ok(undo.ok, JSON.stringify(undo.errors))
    const restored = await snapshot(dir)
    assert.deepEqual(restored, before)
  } finally {
    await cleanup()
  }
})

test('undo restores a deleted file and removes a created one', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'keep.txt', 'a\nb\nc\n')
    await help.write(dir, 'drop.txt', 'gone soon\n')
    const patch = [
      'diff --git a/keep.txt b/keep.txt',
      '--- a/keep.txt',
      '+++ b/keep.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '',
      'diff --git a/drop.txt b/drop.txt',
      'deleted file mode 100644',
      '--- a/drop.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone soon',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.ok(report.ok, JSON.stringify(report.errors))
    await assert.rejects(fsp.access(path.join(dir, 'drop.txt')))

    const journal = await readJournal(report.undoFile!)
    const undo = await applyUndo(journal)
    assert.ok(undo.ok, JSON.stringify(undo.errors))
    assert.equal(await help.read(path.join(dir, 'keep.txt')), 'a\nb\nc\n')
    assert.equal(await help.read(path.join(dir, 'drop.txt')), 'gone soon\n')
  } finally {
    await cleanup()
  }
})

/** Snapshot a directory as a sorted rel-path → content map (ignores the undo journal). */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(dir, rel)
    const entries = await fsp.readdir(abs, { withFileTypes: true })
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      const childAbs = path.join(abs, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (child === '.dsh-patch-undo.json') continue // recorded by the apply under test
      else out[child] = await fsp.readFile(childAbs, 'utf8')
    }
  }
  await walk('')
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
