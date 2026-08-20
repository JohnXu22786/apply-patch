/**
 * Patch statistics — a pure, filesystem-free summary of a parsed patch.
 * @module
 */

import type { ParsedPatch, PatchKind } from './types.ts'

export interface FileStat {
  path: string
  kind: PatchKind
  hunks: number
  added: number
  deleted: number
  context: number
  mode: string | null
}

export interface PatchStat {
  fileCount: number
  files: FileStat[]
  totalHunks: number
  totalAdded: number
  totalDeleted: number
  totalContext: number
  binaryCount: number
}

/** Summarise a parsed patch. */
export function statPatch(parsed: ParsedPatch): PatchStat {
  const files: FileStat[] = []
  let totalHunks = 0
  let totalAdded = 0
  let totalDeleted = 0
  let totalContext = 0
  let binaryCount = 0

  for (const file of parsed.files) {
    const added = file.hunks.reduce((n, h) => n + h.newLines.filter((l) => l.kind === 'add').length, 0)
    const deleted = file.hunks.reduce((n, h) => n + h.oldLines.filter((l) => l.kind === 'del').length, 0)
    const context = file.hunks.reduce((n, h) => n + h.oldLines.filter((l) => l.kind === 'context').length, 0)
    totalHunks += file.hunks.length
    totalAdded += added
    totalDeleted += deleted
    totalContext += context
    if (file.kind === 'binary') binaryCount++
    files.push({
      path: file.newPath ?? file.oldPath ?? '(unknown)',
      kind: file.kind,
      hunks: file.hunks.length,
      added,
      deleted,
      context,
      mode: file.newMode !== null ? file.newMode.toString(8) : null,
    })
  }

  return {
    fileCount: parsed.files.length,
    files,
    totalHunks,
    totalAdded,
    totalDeleted,
    totalContext,
    binaryCount,
  }
}
