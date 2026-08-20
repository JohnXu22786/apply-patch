/**
 * Unified-diff parser (self-implemented, no dependencies).
 *
 * Understands the standard `git diff` output format:
 *   - `diff --git a/x b/y` multi-file blocks
 *   - bare `--- a/x` / `+++ b/y` blocks (classic unified, no git header)
 *   - `index` shas, `old mode` / `new mode`, `new file mode`, `deleted file mode`
 *   - `rename from/to`, `copy from/to`, `similarity index`
 *   - `@@ -l,c +l,c @@` hunks with ` ` / `+` / `-` body lines
 *   - `\ No newline at end of file` markers
 *   - binary labels (`Binary files ... differ`, `GIT binary patch`) â†’ skipped
 *   - `/dev/null` old/new sides â†’ create / delete
 *
 * Hunk headers are validated against the actual body line counts so a
 * malformed patch fails immediately with a precise line number instead of
 * misapplying. Combined (`diff --cc` / `diff --combined`) diffs are rejected
 * as unsupported rather than misapplied.
 * @module
 */

import { PatchParseError, PatchUnsupportedError } from './errors.ts'
import type { DiffLine, Hunk, ParsedPatch, PatchFile, PatchKind } from './types.ts'

interface CurrentHunk {
  index: number
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  section: string
  sourceLine: number
  oldLines: DiffLine[]
  newLines: DiffLine[]
  oldRemaining: number
  newRemaining: number
  /** Kind of the last emitted body line, for `\ No newline` labeling. */
  lastKind: 'context' | 'add' | 'del' | null
}

interface FileBuilder {
  index: number
  sourceStartLine: number
  sawNewHeader: boolean
  oldPath: string | null
  newPath: string | null
  oldMode: number | null
  newMode: number | null
  oldSha: string | null
  newSha: string | null
  renameFrom: string | null
  renameTo: string | null
  copyFrom: string | null
  copyTo: string | null
  binary: boolean
  binaryNote: string | undefined
  hunks: Hunk[]
  current: CurrentHunk | null
}

/** Remove surrounding C-style quotes git emits for unusual paths. */
function unquote(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replaceAll('\\"', '"')
  }
  return p
}

/** Split a quoted/plain space-separated path tail into tokens. */
function splitTokens(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of s) {
    if (ch === '"') {
      inQuote = !inQuote
      cur += ch
      continue
    }
    if (ch === ' ' && !inQuote) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** Split the `diff --git a/x b/y` tail into old and new paths. */
function splitGitPaths(tail: string): [string, string] {
  const tokens = splitTokens(tail)
  const clean = (t: string): string => {
    const u = unquote(t)
    if (u.startsWith('a/') || u.startsWith('b/')) return u.slice(2)
    return u
  }
  if (tokens.length >= 2) return [clean(tokens[0]!), clean(tokens[1]!)]
  if (tokens.length === 1) {
    const p = clean(tokens[0]!)
    return [p, p]
  }
  const idx = tail.lastIndexOf(' b/')
  if (idx < 0) return ['', '']
  return [tail.slice(0, idx).replace(/^a\//, ''), tail.slice(idx + 3).replace(/^b\//, '')]
}

/** Normalize a `---`/`+++` header path: quotes â†’ stripped, prefix â†’ stripped, `/dev/null` â†’ null. */
function normalizeHeaderPath(p: string): string | null {
  let s = unquote(p.trim())
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2)
  if (s === '/dev/null') return null
  return s
}

/** Parse an octal mode like `100644`. */
function parseMode(s: string): number {
  const parsed = Number.parseInt(s, 8)
  if (!Number.isSafeInteger(parsed)) throw new Error(`bad mode ${JSON.stringify(s)}`)
  return parsed
}

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/

/** Finish a completed hunk into its {@link Hunk} form. */
function completeHunk(b: FileBuilder): void {
  const c = b.current!
  const oldLast = c.oldLines.length > 0 ? c.oldLines[c.oldLines.length - 1]! : null
  const newLast = c.newLines.length > 0 ? c.newLines[c.newLines.length - 1]! : null
  b.hunks.push({
    index: c.index,
    oldStart: c.oldStart,
    oldCount: c.oldCount,
    newStart: c.newStart,
    newCount: c.newCount,
    section: c.section,
    sourceLine: c.sourceLine,
    oldLines: c.oldLines,
    newLines: c.newLines,
    oldTexts: c.oldLines.map((l) => l.text),
    oldNewline: c.oldLines.map((l) => l.noNewline),
    oldEndsWithoutNewline: oldLast !== null && oldLast.noNewline && c.oldLines.length === c.oldCount,
    newEndsWithoutNewline: newLast !== null && newLast.noNewline && c.newLines.length === c.newCount,
  })
  b.current = null
}

/**
 * Parse a full unified diff into an in-memory {@link ParsedPatch}.
 * @param text - the raw patch text (LF or CRLF line endings both accepted).
 * @throws {@link PatchParseError} on malformed content with a patch line number.
 */
export function parsePatch(text: string): ParsedPatch {
  const raw = text.split(/\r\n|\n/)
  const files: PatchFile[] = []
  let builder: FileBuilder | null = null

  // Flush a finished builder into `files`. `builder` is passed as a parameter
  // (never captured) so the outer `let` reassignment stays visible to TS flow
  // analysis inside the loop.
  const finish = (b: FileBuilder): void => {
    if (b.current !== null) {
      const c = b.current
      throw new PatchParseError(
        `hunk ended unexpectedly: expected ${c.oldCount} old / ${c.newCount} new line(s), got ${c.oldLines.length} / ${c.newLines.length}`,
        c.sourceLine,
        '',
      )
    }
    if (b.binary && b.hunks.length > 0) b.hunks = []
    files.push({
      index: b.index,
      kind: classifyKind(b),
      oldPath: b.oldPath,
      newPath: b.newPath,
      oldMode: b.oldMode,
      newMode: b.newMode,
      renameFrom: b.renameFrom,
      renameTo: b.renameTo,
      copyFrom: b.copyFrom,
      copyTo: b.copyTo,
      oldSha: b.oldSha,
      newSha: b.newSha,
      hunks: b.hunks,
      binary: b.binary,
      binaryNote: b.binaryNote,
      sourceStartLine: b.sourceStartLine,
    })
  }

  /** A fresh file block builder; callers assign `builder = makeBuilder(...)`. */
  const makeBuilder = (sourceStartLine: number): FileBuilder => ({
    index: files.length,
    sourceStartLine,
    sawNewHeader: false,
    oldPath: null,
    newPath: null,
    oldMode: null,
    newMode: null,
    oldSha: null,
    newSha: null,
    renameFrom: null,
    renameTo: null,
    copyFrom: null,
    copyTo: null,
    binary: false,
    binaryNote: undefined,
    hunks: [],
    current: null,
  })

  /** Flush `builder` then open a fresh block. */
  const openNext = (sourceStartLine: number): FileBuilder => {
    if (builder !== null) finish(builder)
    return makeBuilder(sourceStartLine)
  }

  const openHunk = (b: FileBuilder, line: string, lineNo: number): void => {
    const m = HUNK_RE.exec(line)
    if (m === null) throw new PatchParseError('malformed @@ hunk header', lineNo, line)
    if (b.current !== null) throw new PatchParseError('nested @@ header without finishing previous hunk', lineNo, line)
    b.current = {
      index: b.hunks.length,
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
      section: m[5] === undefined ? '' : m[5].trim(),
      sourceLine: lineNo,
      oldLines: [],
      newLines: [],
      oldRemaining: m[2] === undefined ? 1 : Number(m[2]),
      newRemaining: m[4] === undefined ? 1 : Number(m[4]),
      lastKind: null,
    }
  }

  const pushBodyLine = (b: FileBuilder, lineNo: number, kind: 'context' | 'add' | 'del', text: string): void => {
    const c = b.current
    if (c === null) throw new PatchParseError('body line without an @@ hunk', lineNo, text)
    const dl: DiffLine = { kind, text, noNewline: false }
    if (kind === 'context') {
      c.oldLines.push(dl)
      c.newLines.push({ ...dl })
      c.oldRemaining--
      c.newRemaining--
    } else if (kind === 'add') {
      c.newLines.push(dl)
      c.newRemaining--
    } else {
      c.oldLines.push(dl)
      c.oldRemaining--
    }
    c.lastKind = kind
    if (c.oldRemaining < 0 || c.newRemaining < 0) {
      throw new PatchParseError(
        `hunk has more lines than its header declares (old ${c.oldCount}, new ${c.newCount})`,
        c.sourceLine,
        text,
      )
    }
  }

  /** True when the current hunk's declared line counts are fully consumed. */
  const hunkSatisfied = (c: CurrentHunk): boolean => c.oldRemaining === 0 && c.newRemaining === 0

  /**
   * Close the current hunk lazily: completion is deferred until a non-body,
   * non-marker line arrives, so a trailing `\ No newline` marker (which can be
   * the very last line of a hunk) is still attributed correctly.
   */
  function closeHunkIfSatisfied(b: FileBuilder): boolean {
    if (b.current === null || !hunkSatisfied(b.current)) return false
    completeHunk(b)
    return true
  }

  const markNoNewline = (b: FileBuilder, lineNo: number): void => {
    const c = b.current
    if (c === null) throw new PatchParseError(`'\\ No newline' marker without an open hunk`, lineNo, lineText)
    if (c.lastKind === 'add') {
      const last = c.newLines[c.newLines.length - 1]
      if (last === undefined) throw new PatchParseError(`'\\ No newline' marker without a preceding line`, lineNo, lineText)
      last.noNewline = true
    } else if (c.lastKind === 'del') {
      const last = c.oldLines[c.oldLines.length - 1]
      if (last === undefined) throw new PatchParseError(`'\\ No newline' marker without a preceding line`, lineNo, lineText)
      last.noNewline = true
    } else {
      // A context line sits on both sides of the hunk.
      const oldLast = c.oldLines[c.oldLines.length - 1]
      const newLast = c.newLines[c.newLines.length - 1]
      if (oldLast === undefined || newLast === undefined) {
        throw new PatchParseError(`'\\ No newline' marker without a preceding line`, lineNo, lineText)
      }
      oldLast.noNewline = true
      newLast.noNewline = true
    }
  }

  // Current raw line, for precise error messages.
  let lineText = ''

  let i = 0
  while (i < raw.length) {
    const rawLine = raw[i]!
    lineText = rawLine
    // 0-based index tracks enthusiastically; errors report 1-based.
    const lineNo = i + 1
    const bodyOnly = builder !== null && builder.current !== null

    if (rawLine.startsWith('diff --cc ') || rawLine.startsWith('diff --combined ')) {
      throw new PatchUnsupportedError(`combined diffs are not supported (line ${lineNo})`)
    }

    if (rawLine === '') {
      // Never part of a hunk body (context lines carry a leading space), so a
      // safe separator.
      i++
      continue
    }

    // A line addressed while a hunk is open: marker / body / close-then-reprocess.
    // This must run before the `diff --git` branch so a new file header while a
    // hunk is still open closes that hunk cleanly.
    if (bodyOnly) {
      const b = builder!
      if (rawLine.startsWith('\\ No newline at end of file')) {
        markNoNewline(b, lineNo)
        i++
        continue
      }
      const prefix = rawLine[0]
      if (prefix === ' ' || prefix === '+' || prefix === '-') {
        pushBodyLine(b, lineNo, prefix === '+' ? 'add' : prefix === '-' ? 'del' : 'context', rawLine.slice(1))
        i++
        continue
      }
      // A line that is not a body line while a hunk is open: if the hunk's
      // counts are satisfied, close it and re-process this line as a header;
      // otherwise the hunk is malformed.
      if (!closeHunkIfSatisfied(b)) {
        throw new PatchParseError('unexpected line inside hunk body', lineNo, rawLine)
      }
      i-- // reprocess the same line in header position
      continue
    }

    if (rawLine.startsWith('diff --git ')) {
      builder = openNext(lineNo)
      const b = builder!
      const [oldPath, newPath] = splitGitPaths(rawLine.slice('diff --git '.length))
      b.oldPath = oldPath === '' ? null : oldPath
      b.newPath = newPath === '' ? null : newPath
      i++
      continue
    }

    if (builder === null && (rawLine.startsWith('--- ') || rawLine.startsWith('+++ '))) {
      // Classic unified patch without a git header: the first `--- `/`+++ `
      // pair starts the block.
      builder = openNext(lineNo)
      if (rawLine.startsWith('--- ')) {
        builder!.oldPath = normalizeHeaderPath(rawLine.slice(4))
      } else {
        builder!.newPath = normalizeHeaderPath(rawLine.slice(4))
        builder!.sawNewHeader = true
      }
      i++
      continue
    }

    if (builder !== null) {
      const b = builder!
      if (rawLine.startsWith('--- ')) {
        // Exactly one ---/+++ pair per block; a second `--- ` after headers
        // means a new bare block has begun.
        if (b.sawNewHeader) {
          i--
          builder = openNext(lineNo)
          continue
        }
        b.oldPath = normalizeHeaderPath(rawLine.slice(4))
        i++
        continue
      }
      if (rawLine.startsWith('+++ ')) {
        if (b.sawNewHeader) {
          i--
          builder = openNext(lineNo)
          continue
        }
        b.newPath = normalizeHeaderPath(rawLine.slice(4))
        b.sawNewHeader = true
        i++
        continue
      }
      if (rawLine.startsWith('index ')) {
        const parts = rawLine.slice(6).split(/\s+/)
        const range = parts[0] ?? ''
        const dot = range.indexOf('..')
        if (dot > 0) {
          b.oldSha = range.slice(0, dot) || null
          b.newSha = range.slice(dot + 2) || null
          const mode = parts[1]
          if (mode !== undefined) b.newMode = parseMode(mode)
        }
        i++
        continue
      }
      if (rawLine.startsWith('new file mode ')) {
        b.oldMode = parseMode(rawLine.slice('new file mode '.length))
        b.newMode = b.oldMode
        i++
        continue
      }
      if (rawLine.startsWith('deleted file mode ')) {
        b.newMode = parseMode(rawLine.slice('deleted file mode '.length))
        b.oldMode = b.newMode
        i++
        continue
      }
      if (rawLine.startsWith('old mode ')) {
        b.oldMode = parseMode(rawLine.slice('old mode '.length))
        i++
        continue
      }
      if (rawLine.startsWith('new mode ')) {
        b.newMode = parseMode(rawLine.slice('new mode '.length))
        i++
        continue
      }
      if (rawLine.startsWith('rename from ')) {
        b.renameFrom = unquote(rawLine.slice('rename from '.length))
        i++
        continue
      }
      if (rawLine.startsWith('rename to ')) {
        b.renameTo = unquote(rawLine.slice('rename to '.length))
        i++
        continue
      }
      if (rawLine.startsWith('copy from ')) {
        b.copyFrom = unquote(rawLine.slice('copy from '.length))
        i++
        continue
      }
      if (rawLine.startsWith('copy to ')) {
        b.copyTo = unquote(rawLine.slice('copy to '.length))
        i++
        continue
      }
      if (rawLine.startsWith('similarity index ') || rawLine.startsWith('dissimilarity index ')) {
        i++
        continue
      }
      if (rawLine.startsWith('Binary files ')) {
        b.binary = true
        b.binaryNote ??= rawLine
        i++
        continue
      }
      if (rawLine.startsWith('GIT binary patch')) {
        b.binary = true
        b.binaryNote ??= 'GIT binary patch'
        // `literal <n>` data lines follow; they would not parse as hunks, so
        // they are consumed as header noise until the block ends.
        i++
        continue
      }
      if (rawLine.startsWith('@@')) {
        openHunk(b, rawLine, lineNo)
        i++
        continue
      }
      // Unknown non-hunk noise between blocks: ignore, do not fail.
      i++
      continue
    }

    // Any other stray line with no open block tolerated as noise.
    i++
  }

  // End of input: close a completed hunk (its closing boundary was the EOF),
  // then flush; a dangling unsatisfied hunk is an error.
  if (builder !== null) {
    if (builder.current !== null && hunkSatisfied(builder.current)) completeHunk(builder)
    finish(builder)
  }

  if (files.length === 0) {
    throw new PatchParseError('no file blocks found in patch', 1, text.slice(0, 60))
  }
  return { files }
}

/** Decide the {@link PatchKind} a fully parsed block requests. */
function classifyKind(b: FileBuilder): PatchKind {
  if (b.binary) return 'binary'
  if (b.renameFrom !== null && b.renameTo !== null) return 'rename'
  if (b.copyFrom !== null && b.copyTo !== null) return 'copy'
  if (b.oldPath === null && b.newPath !== null) return 'create'
  if (b.newPath === null && b.oldPath !== null) return 'delete'
  if (b.oldPath === null || b.newPath === null) return 'modify'
  const modeChange = b.oldMode !== null && b.newMode !== null && b.oldMode !== b.newMode
  if (modeChange && b.hunks.length === 0) return 'mode'
  return 'modify'
}
