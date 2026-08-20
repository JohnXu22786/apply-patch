/**
 * stat tests: pure, filesystem-free summary of parsed patches.
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { statPatch } from '../src/stat.ts'
import { parsePatch } from '../src/parse.ts'
import { patchFixtureText } from './parse-helpers.ts'

test('summarizes the multi-file fixture with per-file counts', () => {
  const stat = statPatch(parsePatch(patchFixtureText('basic-multi.patch')))
  assert.equal(stat.fileCount, 5)
  assert.equal(stat.totalHunks, 3)
  assert.equal(stat.totalAdded, 3) // hello +1 line, newfile +2
  assert.equal(stat.totalDeleted, 3) // hello -1, gone -2
  assert.equal(stat.binaryCount, 0)

  const hello = stat.files.find((f) => f.path === 'hello.txt')!
  assert.equal(hello.kind, 'modify')
  assert.equal(hello.added, 1)
  assert.equal(hello.deleted, 1)
  assert.equal(hello.context, 2)

  const del = stat.files.find((f) => f.path === 'gone.txt')!
  assert.equal(del.kind, 'delete')
  assert.equal(del.deleted, 2)
})

test('counts binary files separately and includes mode for mode changes', () => {
  const stat = statPatch(parsePatch(patchFixtureText('binary.patch')))
  assert.equal(stat.fileCount, 1)
  assert.equal(stat.binaryCount, 1)

  const patch = [
    'diff --git a/tool b/tool',
    'old mode 100644',
    'new mode 100755',
  ].join('\n') + '\n'
  const mode = statPatch(parsePatch(patch)).files[0]!
  assert.equal(mode.kind, 'mode')
  assert.equal(mode.mode, '100755')
})
