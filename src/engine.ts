/**
 * In-memory patch application: transform a text buffer by a file's hunks.
 *
 * This is the pure core the filesystem layer drives. It never touches a disk
 * and never mutates its inputs — callers decide how (and whether) the result
 * is committed. Hunk-by-hunk it:
 *   1. computes the expected anchor (header position + net shift),
 *   2. locates the old-side block (exact / offset / fuzzy),
 *   3. replaces the block with the new-side lines, attaching line separators
 *      so the reconstructed file round-trips EOL style and the
 *      no-trailing-newline state exactly,
 * and stops on the first unsafe location, returning a precise {@link HunkConflict}.
 * @module
 */

import { anchorFor, locateHunk } from './locate.ts'
import type { LineEnding, HunkConflict } from './types.ts'
import type { AppliedHunk, FileLine, Hunk } from './types.ts'

export interface TransformOptions {
  /** Maximum leading context lines droppable in fuzzy matching. */
  fuzzContext: number
  /** Display path used when reporting a conflict. */
  fileLabel: string
  /** Maximum old-side lines echoed in a conflict report. */
  capExpected?: number
}

export interface TransformOk {
  ok: true
  lines: FileLine[]
  eol: LineEnding
  applied: AppliedHunk[]
}

export interface TransformFail {
  ok: false
  conflict: HunkConflict
}

export type TransformResult = TransformOk | TransformFail

const DEFAULT_CAP = 8

/**
 * Transform `lines` by the hunks of one file.
 * @param items - the file's current lines (not mutated).
 * @param eol - dominant line ending, used for inserted lines.
 * @param hunks - this file's hunks, in patch order.
 * @param options - {@link TransformOptions}.
 * @returns the transformed lines or a precise conflict report.
 */
export function transformLines(
  items: readonly FileLine[],
  eol: LineEnding,
  hunks: readonly Hunk[],
  options: TransformOptions,
): TransformResult {
  const lines = [...items]
  let netDelta = 0
  const applied: AppliedHunk[] = []
  let minPos = 0

  for (const hunk of hunks) {
    const anchor = anchorFor(hunk, netDelta)
    const match = locateHunk(hunk, lines, anchor, minPos, { fuzzContext: options.fuzzContext })
    if (match === null) {
      return { ok: false, conflict: buildConflict(hunk, lines, anchor, options) }
    }

    const beforeLen = lines.length
    const removedWindow = hunk.oldLines.slice(match.fuzz)
    const insertedWindow = hunk.newLines.slice(match.fuzz)
    const removed = lines.splice(match.pos, removedWindow.length)
    const reachedEof = match.pos + removedWindow.length === beforeLen
    const removedFinalSep = removed.length > 0 ? removed[removed.length - 1]!.sep : undefined

    const inserted: FileLine[] = []
    insertedWindow.forEach((dl, j) => {
      const lastInWindow = j === insertedWindow.length - 1
      let sep: string = eol
      if (lastInWindow && reachedEof) {
        // The hunk covers the end of the file: honour the explicit
        // no-trailing-newline request, otherwise keep whatever terminator the
        // replaced final line had (CRLF preserved).
        sep = dl.noNewline ? '' : (removedFinalSep !== undefined && removedFinalSep !== '' ? removedFinalSep : eol)
      }
      inserted.push({ text: dl.text, sep: sep as FileLine['sep'] })
    })
    lines.splice(match.pos, 0, ...inserted)

    netDelta += insertedWindow.length - removedWindow.length
    applied.push({
      index: hunk.index,
      hunkNumber: hunk.index + 1,
      status: match.status,
      fuzz: match.fuzz,
      atLine: match.pos + 1,
      removedLines: removedWindow,
      insertedLines: insertedWindow,
    })
    minPos = match.pos + inserted.length
  }

  return { ok: true, lines, eol, applied }
}

/** Build a human- and machine-readable conflict report for a failed hunk. */
export function buildConflict(
  hunk: Hunk,
  lines: readonly FileLine[],
  anchor: number,
  options: TransformOptions,
): HunkConflict {
  const cap = options.capExpected ?? DEFAULT_CAP
  const expected = hunk.oldTexts.slice(0, cap)
  if (expected.length < hunk.oldTexts.length) expected.push(`… ${hunk.oldTexts.length - expected.length} more line(s)`)

  const start = Math.max(0, Math.min(anchor - 2, Math.max(0, lines.length - cap)))
  const actual = lines.slice(start, start + cap).map((l) => l.text)
  const anchorLine = Math.min(Math.max(anchor + 1, 1), Math.max(lines.length, 1))

  const requiresNoNewline = hunk.oldNewline.some(Boolean)
  const fileHasFinalNewline = lines.length === 0 || lines[lines.length - 1]!.sep !== ''
  const reason = requiresNoNewline && fileHasFinalNewline
    ? 'hunk expects the file to end without a trailing newline, but the file ends with one'
    : 'hunk context does not match the file at the expected location'

  return {
    file: options.fileLabel,
    hunkNumber: hunk.index + 1,
    sourceLine: hunk.sourceLine,
    reason,
    expected,
    actual,
    anchorLine,
  }
}
