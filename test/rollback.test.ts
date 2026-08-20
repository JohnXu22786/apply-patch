/**
 * Atomicity and rollback tests: all-or-nothing across files, physical
 * rollback on mid-commit I/O failure, the version-guard (stale) path, and
 * identity checkouts during undo.
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { applyPatchText, applyUndo } from '../src/apply.ts'
import { PatchIoError } from '../src/errors.ts'
import type { IoAdapter, Capabilities, ProbeInfo, ResolvedTarget, WriteGuard } from '../src/io.ts'
import { NodeIoAdapter } from '../src/io.ts'
import { readJournal } from '../src/journal.ts'
import * as help from './helpers.ts'

/** Wraps NodeIoAdapter, throwing on the N-th content write. */
class FailingWriteAdapter implements IoAdapter {
  readonly name = 'failing'
  readonly root: string
  readonly capabilities: Capabilities
  private writes = 0

  constructor(inner: NodeIoAdapter, private failOnWrite: number) {
    this.root = inner.root
    this.capabilities = inner.capabilities
    this.inner = inner
  }

  private inner: NodeIoAdapter

  resolve(p: string): Promise<ResolvedTarget> {
    return this.inner.resolve(p)
  }
  probe(key: string): Promise<ProbeInfo> {
    return this.inner.probe(key)
  }
  readText(key: string): Promise<string> {
    return this.inner.readText(key)
  }
  async writeText(key: string, content: string, guard?: WriteGuard): Promise<void> {
    this.writes++
    if (this.writes === this.failOnWrite) {
      throw new PatchIoError('injected write failure', 'write', key)
    }
    return this.inner.writeText(key, content, guard)
  }
  remove(key: string): Promise<void> {
    return this.inner.remove(key)
  }
  chmod(key: string, mode: number): Promise<void> {
    return this.inner.chmod(key, mode)
  }
  mkdirp(key: string): Promise<void> {
    return this.inner.mkdirp(key)
  }
}

test('a mid-commit I/O failure rolls back the files already written', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/a.txt',
      '@@ -0,0 +1 @@',
      '+A',
      '',
      'diff --git a/b.txt b/b.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/b.txt',
      '@@ -0,0 +1 @@',
      '+B',
      '',
      'diff --git a/c.txt b/c.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/c.txt',
      '@@ -0,0 +1 @@',
      '+C',
    ].join('\n') + '\n'

    const failing = new FailingWriteAdapter(new NodeIoAdapter({ root: dir }), 3)
    const report = await applyPatchText(patch, { root: dir, io: failing })
    assert.equal(report.ok, false)
    assert.equal(report.errors[0]!.code, 'IO')
    assert.match(report.errors[0]!.message, /injected write failure/)

    // Every file that was written before the failure is restored (removed).
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await assert.rejects(fsp.access(path.join(dir, name)), `expected ${name} to be gone`)
    }
  } finally {
    await cleanup()
  }
})

test('modify + create rollback restores the modified file and removes the create', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'keep.txt', 'original\ncontent\n')
    const patch = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+created',
      '',
      'diff --git a/keep.txt b/keep.txt',
      '--- a/keep.txt',
      '+++ b/keep.txt',
      '@@ -1,2 +1,2 @@',
      ' original',
      '-content',
      '+CONTENT',
    ].join('\n') + '\n'

    const failing = new FailingWriteAdapter(new NodeIoAdapter({ root: dir }), 2)
    const report = await applyPatchText(patch, { root: dir, io: failing })
    assert.equal(report.ok, false)
    // first write (new.txt) succeeded and was rolled back; second write
    // (keep.txt) threw before mutating.
    await assert.rejects(fsp.access(path.join(dir, 'new.txt')))
    assert.equal(await help.read(path.join(dir, 'keep.txt')), 'original\ncontent\n')
  } finally {
    await cleanup()
  }
})

test('the version guard aborts when a file changes between validation and commit', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'race.txt', 'stable\ncontent\n')
    const patch = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+created',
      '',
      'diff --git a/race.txt b/race.txt',
      '--- a/race.txt',
      '+++ b/race.txt',
      '@@ -1,2 +1,2 @@',
      ' stable',
      '-content',
      '+changed',
    ].join('\n') + '\n'

    const report = await applyPatchText(patch, {
      root: dir,
      // Simulate a concurrent writer touching the target between read and write.
      beforeCommit: async () => {
        await fsp.writeFile(path.join(dir, 'race.txt'), 'CONCURRENT\nOVERWRITE\n', 'utf8')
      },
    })
    assert.equal(report.ok, false)
    assert.equal(report.errors[0]!.code, 'STALE')
    assert.match(report.errors[0]!.message, /changed since it was read/)
    // The created file was rolled back; the race winner remains.
    await assert.rejects(fsp.access(path.join(dir, 'new.txt')))
    assert.equal(await help.read(path.join(dir, 'race.txt')), 'CONCURRENT\nOVERWRITE\n')
  } finally {
    await cleanup()
  }
})

test('undo refuses to run when a target changed since the apply (content no longer matches)', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'f.txt', 'a\nb\nc\n')
    const patch = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.ok(report.ok)
    assert.equal(await help.read(path.join(dir, 'f.txt')), 'a\nB\nc\n')

    // The user edits the file after the apply; undo's reverse patch can no
    // longer match, so it must refuse and leave the file untouched.
    await fsp.writeFile(path.join(dir, 'f.txt'), 'a\nCUSTOM\nc\n', 'utf8')
    const journal = await readJournal(report.undoFile!)
    const undo = await applyUndo(journal)
    assert.equal(undo.ok, false)
    assert.equal(undo.conflicts.length, 1)
    assert.equal(undo.files.length, 0)
    assert.equal(await help.read(path.join(dir, 'f.txt')), 'a\nCUSTOM\nc\n')
  } finally {
    await cleanup()
  }
})

test('the default undo journal lands at <root>/.dsh-patch-undo.json', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'f.txt', 'x\ny\n')
    const patch = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,2 +1,2 @@',
      ' x',
      '-y',
      '+Y',
    ].join('\n') + '\n'
    const report = await applyPatchText(patch, { root: dir })
    assert.ok(report.ok)
    assert.equal(report.undoFile, path.join(dir, '.dsh-patch-undo.json'))
    const journal = JSON.parse(await fsp.readFile(report.undoFile!, 'utf8'))
    assert.equal(journal.schema, 'dsh-patch-apply/undo')
    assert.match(journal.reversePatch, /diff --git/)
  } finally {
    await cleanup()
  }
})

test('a patch with no mutations (only binary) records no undo file', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    const report = await applyPatchText(await help.fixture('binary.patch'), { root: dir })
    assert.ok(report.ok)
    assert.equal(report.undoFile, null)
    assert.equal(report.reversePatch, null)
  } finally {
    await cleanup()
  }
})
