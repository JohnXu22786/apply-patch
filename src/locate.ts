/**
 * Hunk location: find where a hunk's old-side lines sit in a file's lines.
 *
 * Three strategies, tried in order:
 *   1. **exact**  — the old-side block matches at the anchor (header line
 *      number adjusted by the net shift of earlier hunks).
 *   2. **offset** — the anchor missed (earlier lines changed), but the full
 *      old-side block matches exactly somewhere else; the closest match to
 *      the anchor wins.
 *   3. **fuzzy**  — no exact match anywhere: up to `fuzzContext` leading
 *      context lines may be dropped to find a bolt. Only *context* lines are
 *      ever droppable (deletions must always match exactly), so a fuzzy match
 *      can never delete wrong content — it only tolerates drift in surrounding
 *      context.
 *
 * Location never mutates anything; it returns a position or null.
 * @module
 */

import type { FileLine, Hunk, MatchResult } from './types.ts'

export interface LocateOptions {
  /** Maximum number of leading context lines droppable in fuzzy mode. */
  fuzzContext: number
}

const NO_RANGE: LocateOptions = { fuzzContext: 3 }

/** Compare `texts` against `lines` starting at `pos`. */
function matchBlock(
  lines: readonly FileLine[],
  texts: readonly string[],
  newlineFlags: readonly boolean[],
  pos: number,
): boolean {
  if (pos < 0 || pos + texts.length > lines.length) return false
  for (let k = 0; k < texts.length; k++) {
    if (lines[pos + k]!.text !== texts[k]) return false
  }
  // A patch line marked `\ No newline at end of file` can only sit on the
  // actual final line of the file, and only when that line has no terminator.
  for (let k = 0; k < texts.length; k++) {
    if (newlineFlags[k] && !(pos + k === lines.length - 1 && lines[pos + k]!.sep === '')) {
      return false
    }
  }
  return true
}

/** Number of leading context lines before the first change (the fuzzy headroom). */
function leadingContextCount(lines: readonly { kind: string }[]): number {
  let count = 0
  for (const line of lines) {
    if (line.kind !== 'context') break
    count++
  }
  return count
}

/**
 * Locate a hunk's old-side block within `lines`.
 * @param hunk - the hunk to locate.
 * @param lines - the file's current lines.
 * @param anchor - 0-based expected position (header line minus one, adjusted
 *   by the net shift of previously applied hunks).
 * @param minPos - inclusive lower bound (start of previously applied content),
 *   keeping hunks ordered and non-overlapping.
 * @param options - {@link LocateOptions}; defaults to a 3-line fuzz budget.
 * @returns the match, or null when no safe location exists.
 */
export function locateHunk(
  hunk: Hunk,
  lines: readonly FileLine[],
  anchor: number,
  minPos: number,
  options: LocateOptions = NO_RANGE,
): MatchResult | null {
  const texts = hunk.oldTexts
  const nw = hunk.oldNewline

  // Pure-insertion hunk: nothing to match, anchor is the insertion point.
  if (texts.length === 0) {
    const pos = Math.max(Math.min(anchor, lines.length), Math.min(minPos, lines.length))
    return { status: 'exact', pos, fuzz: 0 }
  }

  if (matchBlock(lines, texts, nw, anchor)) {
    return { status: 'exact', pos: anchor, fuzz: 0 }
  }

  // Offset correction: full exact match somewhere else; nearest to anchor wins.
  {
    let best: { pos: number; dist: number } | null = null
    const limit = lines.length - texts.length
    for (let pos = 0; pos <= limit; pos++) {
      if (pos < minPos) continue
      if (matchBlock(lines, texts, nw, pos)) {
        const dist = Math.abs(pos - anchor)
        if (best === null || dist < best.dist) best = { pos, dist }
      }
    }
    if (best !== null) return { status: 'offset', pos: best.pos, fuzz: 0 }
  }

  // Fuzzy: drop leading context lines one at a time until a bolt is found.
  // Both sides must share the dropped prefix (it is unchanged context), so the
  // budget is capped by the NEW side's leading-context count too — otherwise a
  // leading addition would be silently discarded.
  const oldHead = leadingContextCount(hunk.oldLines)
  const newHead = leadingContextCount(hunk.newLines)
  const maxFuzz = Math.min(oldHead, newHead, Math.max(0, options.fuzzContext))
  for (let fuzz = 1; fuzz <= maxFuzz; fuzz++) {
    const window = texts.slice(fuzz)
    const flags = nw.slice(fuzz)
    const limit = lines.length - window.length
    let cand: { pos: number; dist: number } | null = null
    for (let pos = 0; pos <= limit; pos++) {
      if (pos < minPos) continue
      if (matchBlock(lines, window, flags, pos)) {
        const dist = Math.abs(pos - anchor)
        if (cand === null || dist < cand.dist) cand = { pos, dist }
      }
    }
    if (cand !== null) return { status: 'fuzzy', pos: cand.pos, fuzz }
  }

  return null
}

/** Compute the anchor position for a hunk with a running net shift. */
export function anchorFor(hunk: Hunk, netDelta: number): number {
  return hunk.oldStart === 0 ? 0 : hunk.oldStart - 1 + netDelta
}
