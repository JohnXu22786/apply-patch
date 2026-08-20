/**
 * CLI tests: argument parsing, exit codes, JSON output, reverse and undo flows.
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { run } from '../src/cli.ts'
import * as help from './helpers.ts'

interface Captured {
  out: string[]
  err: string[]
}

function streams(): Captured {
  return { out: [], err: [] }
}

async function cli(argv: string[], cwd: string, cap?: Captured): Promise<number> {
  const c = cap ?? streams()
  const code = await run(argv, {
    out: (s) => c.out.push(s),
    err: (s) => c.err.push(s),
  }, { cwd })
  return code
}

test('stat prints a summary and accepts --json', async () => {
  const cap = streams()
  const cwd = await fsp.mkdtemp(path.join(process.cwd(), '.tmp-cli-'))
  try {
    const fixture = path.join(cwd, 'basic-multi.patch')
    await fsp.copyFile(new URL('../../test/fixtures/basic-multi.patch', import.meta.url), fixture)
    const code = await cli(['stat', fixture], cwd, cap)
    assert.equal(code, 0)
    assert.match(cap.out.join('\n'), /files: 5, hunks: 3, \+3 \/ -3/)
    const cap2 = streams()
    await cli(['stat', '--json', fixture], cwd, cap2)
    const parsed = JSON.parse(cap2.out.join('\n'))
    assert.equal(parsed.fileCount, 5)
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true })
  }
})

test('dry-run validates a clean patch against a workspace and writes nothing', async () => {
  const cap = streams()
  const { dir, cleanup } = await help.setupBasicWorkspace()
  try {
    const fixture = path.join(dir, 'p.patch')
    await fsp.copyFile(new URL('../../test/fixtures/basic-multi.patch', import.meta.url), fixture)
    const code = await cli(['apply', '--dry-run', fixture], dir, cap)
    assert.equal(code, 0)
    assert.match(cap.out.join('\n'), /dry-run: nothing was written/)
    await assert.rejects(fsp.access(path.join(dir, 'newfile.txt')))
  } finally {
    await cleanup()
  }
})

test('apply mutates, writes an undo journal, and the undo command restores', async () => {
  const { dir, cleanup } = await help.setupBasicWorkspace()
  try {
    const fixture = path.join(dir, 'p.patch')
    await fsp.copyFile(new URL('../../test/fixtures/basic-multi.patch', import.meta.url), fixture)
    const cap = streams()
    const code = await cli(['apply', fixture], dir, cap)
    assert.equal(code, 0, cap.err.join('\n'))
    assert.equal(await help.read(path.join(dir, 'hello.txt')), 'hello\nearth\ngoodbye\n')
    const journal = path.join(dir, '.dsh-patch-undo.json')
    assert.equal(await fsp.stat(journal).then((s) => s.isFile()), true)

    const cap2 = streams()
    const code2 = await cli(['undo', journal], dir, cap2)
    assert.equal(code2, 0, cap2.err.join('\n'))
    assert.equal(await help.read(path.join(dir, 'hello.txt')), 'hello\nworld\ngoodbye\n')
    await assert.rejects(fsp.access(path.join(dir, 'newname.txt')))
    assert.equal(await help.read(path.join(dir, 'old.txt')), 'keep me\n')
  } finally {
    await cleanup()
  }
})

test('a conflicting apply exits 1 and prints the conflict to stderr', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    // All fixture prerequisites exist except hello.txt, which does not match
    // its hunk → a CONFLICT (not a missing-file validation error).
    await help.write(dir, 'hello.txt', 'not\nmatching\n')
    await help.write(dir, 'gone.txt', 'just\ngone\n')
    await help.write(dir, 'old.txt', 'keep me\n')
    await help.write(dir, 'script.sh', '#!/bin/sh\n')
    const fixture = path.join(dir, 'p.patch')
    await fsp.copyFile(new URL('../../test/fixtures/basic-multi.patch', import.meta.url), fixture)
    const cap = streams()
    const code = await cli(['apply', fixture], dir, cap)
    assert.equal(code, 1)
    assert.match(cap.err.join('\n'), /CONFLICT/)
    await assert.rejects(fsp.access(path.join(dir, 'newfile.txt')))
  } finally {
    await cleanup()
  }
})

test('--json apply surfaces a machine-readable report', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'f.txt', 'a\nb\n')
    const patchFile = path.join(dir, 'p.patch')
    await fsp.writeFile(patchFile, [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
    ].join('\n') + '\n', 'utf8')
    const cap = streams()
    const code = await cli(['apply', '--json', '--no-undo', patchFile], dir, cap)
    assert.equal(code, 0)
    const report = JSON.parse(cap.out.join('\n'))
    assert.equal(report.ok, true)
    assert.equal(report.files.length, 1)
    assert.equal(report.files[0]!.operation, 'modify')
    assert.equal(report.undoFile, null)
  } finally {
    await cleanup()
  }
})

test('reverse prints a reversible patch without applying', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'f.txt', 'a\nb\n')
    const patchFile = path.join(dir, 'p.patch')
    const patch = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
    ].join('\n') + '\n'
    await fsp.writeFile(patchFile, patch, 'utf8')
    const cap = streams()
    const code = await cli(['reverse', patchFile], dir, cap)
    assert.equal(code, 0, cap.err.join('\n'))
    const reversed = cap.out.join('\n')
    assert.match(reversed, /diff --git/)
    assert.match(reversed, /-B/)
    assert.match(reversed, /\+b/)
    // Nothing was applied by `reverse`.
    assert.equal(await help.read(path.join(dir, 'f.txt')), 'a\nb\n')
  } finally {
    await cleanup()
  }
})

test('usage errors exit 2 with help text', async () => {
  const cap = streams()
  const code = await cli(['bogus-command', 'x'], process.cwd(), cap)
  assert.equal(code, 2)
  assert.match(cap.err.join('\n'), /unknown command/)

  const cap2 = streams()
  const code2 = await cli(['apply'], process.cwd(), cap2)
  assert.equal(code2, 2)
  assert.match(cap2.err.join('\n'), /patch file argument is required/)

  const cap3 = streams()
  const code3 = await cli(['--nope'], process.cwd(), cap3)
  assert.equal(code3, 2)
})

test('a malformed patch file exits 1 with a PARSE code', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    const patchFile = path.join(dir, 'bad.patch')
    await fsp.writeFile(patchFile, 'diff not a real patch\n@@ -1 +1 @@\n', 'utf8')
    const cap = streams()
    const code = await cli(['apply', patchFile], dir, cap)
    assert.equal(code, 1)
    assert.match(cap.err.join('\n'), /\[PARSE\]/)
  } finally {
    await cleanup()
  }
})
