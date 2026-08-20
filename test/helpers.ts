/**
 * Shared test helpers: temporary workspaces on the real filesystem.
 * @module
 */

import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Create a throwaway directory; returns an async cleanup that deletes it. */
export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-patch-apply-'))
  return {
    dir,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
  }
}

/** Write a file (creating parents) inside a temp dir. */
export async function write(dir: string, rel: string, content: string | Buffer): Promise<string> {
  const abs = path.join(dir, rel)
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content)
  return abs
}

/** Read a text file from a temp dir (or its abs path). */
export async function read(abs: string): Promise<string> {
  return fsp.readFile(abs, 'utf8')
}

/** Read a fixture patch from the fixtures directory. */
export async function fixture(name: string): Promise<string> {
  const url = new URL(`../../test/fixtures/${name}`, import.meta.url)
  return fsp.readFile(url, 'utf8')
}

/** Set up a workspace containing the files the standard fixture patch expects. */
export async function setupBasicWorkspace(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const { dir, cleanup } = await makeTempDir()
  await write(dir, 'hello.txt', 'hello\nworld\ngoodbye\n')
  await write(dir, 'gone.txt', 'just\ngone\n')
  await write(dir, 'old.txt', 'keep me\n')
  await write(dir, 'script.sh', '#!/bin/sh\necho hi\n')
  await write(dir, 'unrelated.txt', 'untouched\n')
  return { dir, cleanup }
}
