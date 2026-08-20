/**
 * Reverse-patch generation.
 *
 * A reverse patch is built from *what was actually applied* (recorded hunk
 * positions from the transformer), not from naive re-parsing, so it applies
 * exactly â€” `undo` restores byte-identical content. Whole-file operations
 * (create/delete) embed the full content, and rename/copy inverse hunks are
 * interleaved the way git emits them.
 * @module
 */

import { splitLines } from './lines.ts'
import type { AppliedHunk, DiffLine, FileLine, PatchFile } from './types.ts'

/** Max lines emitted per hunk when materializing a whole-file add/delete. */
const CHUNK = 500

export interface ReverseInput {
  file: PatchFile
  applied: AppliedHunk[] | null
  /** Final content (post-apply) for create/delete/copy whole-content reversal. */
  contentAfter: string | null
  /** Original content (pre-apply) for delete restoration. */
  contentBefore: string | null
}

function fmtMode(mode: number | null): string {
  if (mode === null) return ''
  return mode.toString(8)
}

function relWithPrefix(p: string | null, prefix: 'a' | 'b'): string {
  if (p === null) return '/dev/null'
  return `${prefix}/${p}`
}

function quoteIfNeeded(p: string): string {
  if (/[\s"]/.test(p)) return `"${p.replaceAll('"', '\\"')}"`
  return p
}

/** Emit the inverse-hunk blocks for a file's applied hunks.
 * Positions come from each hunk's recorded `atLine` (its 1-based start in the
 * final file), NOT from accumulation â€” hunks may be separated by preserved
 * lines, so a running total would drift.
 */
function emitInverseHunks(applied: readonly AppliedHunk[]): string[] {
  const out: string[] = []
  for (const item of applied) {
    const ro = item.insertedLines // reverse old side (current-file lines to remove)
    const rn = item.removedLines // reverse new side (lines to re-add)
    const roCtx = contextIndexes(ro)
    const rnCtx = contextIndexes(rn)
    out.push(`@@ -${item.atLine},${ro.length} +${item.atLine},${rn.length} @@`)
    const body: string[] = []
    let ri = 0
    let ni = 0
    for (let c = 0; c < roCtx.length; c++) {
      const r = roCtx[c]!
      const n = rnCtx[c]!
      emitAsRemove(body, ro, ri, r)
      emitAsAdd(body, rn, ni, n)
      body.push(` ${ro[r]!.text}`)
      if (ro[r]!.noNewline && (r === ro.length - 1)) body.push('\\ No newline at end of file')
      ri = r + 1
      ni = n + 1
    }
    emitAsRemove(body, ro, ri, ro.length)
    emitAsAdd(body, rn, ni, rn.length)
    for (const b of body) out.push(b)
  }
  return out
}

/** Push `-<text>` lines for RO-only (originally additions) within [from, to). */
function emitAsRemove(body: string[], ro: readonly DiffLine[], from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const l = ro[i]!
    body.push(`-${l.text}`)
    if (l.noNewline) body.push('\\ No newline at end of file')
  }
}

/** Push `+<text>` lines for RN-only (originally deletions) within [from, to). */
function emitAsAdd(body: string[], rn: readonly DiffLine[], from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const l = rn[i]!
    body.push(`+${l.text}`)
    if (l.noNewline) body.push('\\ No newline at end of file')
  }
}

function contextIndexes(lines: readonly DiffLine[]): number[] {
  const out: number[] = []
  lines.forEach((l, i) => {
    if (l.kind === 'context') out.push(i)
  })
  return out
}

/** Materialize a whole-file reverse as add (`+`) or delete (`-`) hunks. */
function emitWholeFile(content: string, mode: 'add' | 'delete', initialLine: number): string[] {
  const { lines } = splitLines(content)
  const chunks: FileLine[][] = []
  for (let i = 0; i < lines.length; i += CHUNK) chunks.push(lines.slice(i, i + CHUNK))
  const out: string[] = []
  let line = initialLine
  for (const chunk of chunks) {
    const prefix = mode === 'add' ? '-' : '+'
    if (mode === 'add') {
      // Current file lines are being removed (we are reversing a create).
      out.push(`@@ -${line},${chunk.length} +0,0 @@`)
    } else {
      // Lines are being added back (we are reversing a delete).
      out.push(`@@ -0,0 +${line},${chunk.length} @@`)
    }
    for (let i = 0; i < chunk.length; i++) {
      out.push(`${prefix}${chunk[i]!.text}`)
      const isLastOfFile = chunk === chunks[chunks.length - 1] && i === chunk.length - 1
      if (chunk[i]!.sep === '' && isLastOfFile) out.push('\\ No newline at end of file')
    }
    line += chunk.length
  }
  return out
}

/**
 * Build the reverse-patch text blocks for one applied file operation.
 * @returns raw patch block lines (joined by `\n` by the caller).
 */
export function buildReverseBlock(input: ReverseInput): string[] {
  const { file, applied, contentAfter, contentBefore } = input
  const out: string[] = []

  switch (file.kind) {
    case 'create': {
      // Reverse: delete what was created.
      const mode = file.newMode
      out.push(`diff --git ${quoteIfNeeded(relWithPrefix(file.newPath, 'a'))} ${quoteIfNeeded(relWithPrefix(file.newPath, 'b'))}`)
      if (mode !== null) out.push(`deleted file mode ${fmtMode(mode)}`)
      out.push(`--- ${quoteIfNeeded(relWithPrefix(file.newPath, 'a'))}`)
      out.push('+++ /dev/null')
      out.push(...emitWholeFile(contentAfter ?? '', 'add', 1))
      break
    }
    case 'delete': {
      // Reverse: recreate the deleted file from its original content.
      const mode = file.oldMode
      out.push(`diff --git ${quoteIfNeeded(relWithPrefix(file.oldPath, 'a'))} ${quoteIfNeeded(relWithPrefix(file.oldPath, 'b'))}`)
      if (mode !== null) out.push(`new file mode ${fmtMode(mode)}`)
      out.push('--- /dev/null')
      out.push(`+++ ${quoteIfNeeded(relWithPrefix(file.oldPath, 'b'))}`)
      out.push(...emitWholeFile(contentBefore ?? '', 'delete', 1))
      break
    }
    case 'rename': {
      // Reverse: rename back and invert the content hunks.
      const old = file.renameTo ?? file.newPath
      const target = file.renameFrom ?? file.oldPath
      out.push(`diff --git ${quoteIfNeeded(relWithPrefix(old, 'a'))} ${quoteIfNeeded(relWithPrefix(target, 'b'))}`)
      out.push(`rename from ${quoteIfNeeded(old ?? '')}`)
      out.push(`rename to ${quoteIfNeeded(target ?? '')}`)
      out.push(`--- ${quoteIfNeeded(relWithPrefix(old, 'a'))}`)
      out.push(`+++ ${quoteIfNeeded(relWithPrefix(target, 'b'))}`)
      if (applied !== null && applied.length > 0) {
        out.push(...emitInverseHunks(applied))
      }
      break
    }
    case 'copy': {
      // Reverse: the copy target no longer existed before; remove it.
      const mode = file.newMode
      out.push(`diff --git ${quoteIfNeeded(relWithPrefix(file.newPath, 'a'))} ${quoteIfNeeded(relWithPrefix(file.newPath, 'b'))}`)
      if (mode !== null) out.push(`deleted file mode ${fmtMode(mode)}`)
      out.push(`--- ${quoteIfNeeded(relWithPrefix(file.newPath, 'a'))}`)
      out.push('+++ /dev/null')
      out.push(...emitWholeFile(contentAfter ?? '', 'add', 1))
      break
    }
    case 'mode': {
      const old = file.oldPath ?? file.newPath
      out.push(`diff --git ${quoteIfNeeded(relWithPrefix(old, 'a'))} ${quoteIfNeeded(relWithPrefix(old, 'b'))}`)
      if (file.newMode !== null) out.push(`old mode ${fmtMode(file.newMode)}`)
      if (file.oldMode !== null) out.push(`new mode ${fmtMode(file.oldMode)}`)
      break
    }
    case 'modify':
    default: {
      const target = file.newPath ?? file.oldPath
      if (target === null) break
      out.push(`diff --git ${quoteIfNeeded(relWithPrefix(target, 'a'))} ${quoteIfNeeded(relWithPrefix(target, 'b'))}`)
      out.push(`--- ${quoteIfNeeded(relWithPrefix(target, 'a'))}`)
      out.push(`+++ ${quoteIfNeeded(relWithPrefix(target, 'b'))}`)
      if (applied !== null && applied.length > 0) {
        out.push(...emitInverseHunks(applied))
      }
      break
    }
  }
  return out
}

/** Convenience: turn reverse blocks into one patch string. */
export function joinReverseBlocks(blocks: string[][]): string {
  return blocks.map((b) => b.join('\n')).join('\n')
}
