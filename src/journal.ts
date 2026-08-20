/**
 * Undo journaling.
 *
 * Every successful apply (when undo is enabled) writes a JSON journal holding
 * the reverse patch and the identities each file had when read. `undo` reads
 * the journal and applies the recorded reverse patch; content matching plus
 * the identity check give the same staleness guarantee as a forward apply.
 * @module
 */

import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { PatchIoError, PatchValidationError } from './errors.ts'

export interface UndoJournal {
  schema: 'dsh-patch-apply/undo'
  version: 1
  /** ISO timestamp of the apply. */
  createdAt: string
  /** Absolute root the reverse patch paths resolve against. */
  root: string
  /** Path of the applied patch, when the caller knew one. */
  patchFile?: string
  /** The reverse unified diff — applying it restores the pre-apply state. */
  reversePatch: string
  /** Every target touched, relative to `root`. */
  files: Array<{ path: string; kind: string }>
  /** Relative path → identity token at read time (best-effort stale guard). */
  identities: Record<string, string>
}

export const JOURNAL_DEFAULT_NAME = '.dsh-patch-undo.json'

/** Write a journal atomically. */
export async function writeJournal(file: string, journal: UndoJournal): Promise<void> {
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true }).catch((error) => {
    throw new PatchIoError(`journal mkdir failed: ${(error as Error).message}`, 'mkdir', dir, { cause: error })
  })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    await fsp.writeFile(tmp, JSON.stringify(journal, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw new PatchIoError(`journal write failed: ${(error as Error).message}`, 'write', file, { cause: error })
  }
}

/** Read and validate a journal. */
export async function readJournal(file: string): Promise<UndoJournal> {
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    throw new PatchIoError(`journal read failed: ${(error as Error).message}`, 'read', file, { cause: error })
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new PatchValidationError(`undo journal ${file} is not valid JSON: ${(error as Error).message}`)
  }
  const j = data as Partial<UndoJournal>
  if (j.schema !== 'dsh-patch-apply/undo' || j.version !== 1 || typeof j.reversePatch !== 'string') {
    throw new PatchValidationError(`undo journal ${file} does not match the expected schema`)
  }
  return j as UndoJournal
}
