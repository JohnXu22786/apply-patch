/**
 * Apply orchestration: parse, validate every file in memory, then commit.
 *
 * The safety contract:
 *   - **All-or-nothing.** Every patch file is parsed and every hunk is
 *     validated in memory *before* anything touches the disk. If any hunk
 *     cannot be located safely, or any structural precondition fails, nothing
 *     is written at all — the "whole patch rolls back" guarantee is
 *     structural, not best-effort.
 *   - **Version guard.** File identities are captured at validation time using
 *     the same recipe as the official dsh fs (`dev:ino:size:mtimeNs:ctimeNs`).
 *     Guarded writes re-check the identity immediately before publication and
 *     abort with `STALE` on drift.
 *   - **Physical rollback.** Multi-file commits between the first and last
 *     rename cannot be made atomic by any single filesystem call; if a write,
 *     chmod, or unlink fails mid-commit the already-mutated files are restored
 *     from the in-memory originals (best-effort), and the state is reported.
 *   - **Undo journal.** When undo is enabled the reverse patch and read-time
 *     identities are persisted *before* the first mutation, so even a
 *     hard-crash mid-commit leaves a complete reversion path.
 * @module
 */

import * as path from 'node:path'
import { PatchConflictError } from './errors.ts'
import {
  PatchBinaryError,
  PatchError,
  PatchIoError,
  PatchStaleError,
  PatchValidationError,
} from './errors.ts'
import type { PatchErrorCode } from './errors.ts'
import { transformLines } from './engine.ts'
import type { IoAdapter, WriteGuard } from './io.ts'
import { NodeIoAdapter } from './io.ts'
import { writeJournal, JOURNAL_DEFAULT_NAME } from './journal.ts'
import type { UndoJournal } from './journal.ts'
import { joinLines, splitLines } from './lines.ts'
import { parsePatch } from './parse.ts'
import { buildReverseBlock, joinReverseBlocks } from './reverse.ts'
import { blobSha } from './sha.ts'
import type { AppliedHunk, HunkConflict, LineEnding, PatchFile } from './types.ts'

const DEFAULT_FUZZ = 3

/** Outcomes of one file-level operation, for reports and tool output. */
export interface FileOperationResult {
  path: string
  operation: 'create' | 'delete' | 'modify' | 'rename' | 'copy' | 'mode' | 'binary'
  fromPath?: string
  hunks: AppliedHunk[]
  sourceStartLine: number
  skipReason?: string
}

/** A structural or I/O problem that aborted the apply. */
export interface ApplyErrorEntry {
  code: PatchErrorCode
  path: string
  message: string
}

/** The full outcome of one {@link applyPatchText} call. */
export interface ApplyReport {
  ok: boolean
  dryRun: boolean
  /** Per-file outcomes, in patch order (binary files are listed, skipped). */
  files: FileOperationResult[]
  /** Hunks that could not be located safely (empty on success). */
  conflicts: HunkConflict[]
  /** Structural / stale / io errors that aborted the apply. */
  errors: ApplyErrorEntry[]
  /** Informational notes (e.g. SHA-1 pre-flight mismatches). */
  notes: string[]
  /** The reverse unified diff covering every mutation (null when nothing mutates). */
  reversePatch: string | null
  /** The undo journal path written, when undo was enabled and apply succeeded. */
  undoFile: string | null
}

/** Options for {@link applyPatchText}. */
export interface ApplyOptions {
  /** Absolute base directory for relative patch paths. */
  root: string
  /** Maximum leading context lines droppable by fuzzy matching (default 3). */
  fuzzContext?: number
  /** Validate only — never mutate, never journal. */
  dryRun?: boolean
  /** Persist an undo journal (default true). */
  undo?: boolean
  /** Explicit journal path; default `<root>/.dsh-patch-undo.json`. */
  undoFile?: string
  /** Treat `index`-line SHA-1 mismatches as hard conflicts (default false). */
  strictSha?: boolean
  /** Allow patch paths that escape `root` (default false). */
  rootEscape?: boolean
  /** Filesystem backend; default `node`. */
  io?: IoAdapter
  /** Called after validation, before any mutation (race-injection test seam). */
  beforeCommit?: (targets: string[]) => Promise<void> | void
  /** Called after each committed write (failure-injection test seam). */
  onWrite?: (target: string) => Promise<void> | void
}

/** A prepared, validated file operation ready to commit. */
interface PreparedOp {
  file: PatchFile
  kind: PatchFile['kind']
  display: string
  fromDisplay: string | null
  /** Content source key (modify/delete/rename/copy). */
  sourceKey: string | null
  /** File that gets written (create/modify/rename/copy dest). */
  targetKey: string | null
  /** Identity of the content source at read time. */
  sourceIdentity: string | undefined
  contentBefore: string | null
  contentAfter: string | null
  eol: LineEnding
  applied: AppliedHunk[]
}

interface PreparedResult {
  ops: PreparedOp[]
  skipped: FileOperationResult[]
  conflicts: HunkConflict[]
}

/** Parse + prepare every file op (reads happen here, nothing is written). */
async function prepare(
  parsed: { files: PatchFile[] },
  adapter: IoAdapter,
  fuzzContext: number,
): Promise<PreparedResult> {
  const ops: PreparedOp[] = []
  const skipped: FileOperationResult[] = []
  const conflicts: HunkConflict[] = []

  for (const file of parsed.files) {
    if (file.kind === 'binary') {
      skipped.push({
        path: file.newPath ?? file.oldPath ?? '(unknown)',
        operation: 'binary',
        hunks: [],
        sourceStartLine: file.sourceStartLine,
        skipReason: file.binaryNote ?? 'binary patch',
      })
      continue
    }
    try {
      const op = await prepareOne(file, adapter, fuzzContext)
      ops.push(op)
    } catch (error) {
      if (error instanceof PatchBinaryError) {
        // A patch that declares text but whose target is not text: skip, note.
        skipped.push({
          path: file.newPath ?? file.oldPath ?? '(unknown)',
          operation: 'binary',
          hunks: [],
          sourceStartLine: file.sourceStartLine,
          skipReason: error.message,
        })
        continue
      }
      if (error instanceof PatchConflictError) {
        // Keep validating the remaining files so the report lists every
        // conflicting hunk; atomicity means nothing is written regardless.
        conflicts.push(error.conflict)
        continue
      }
      throw error
    }
  }
  return { ops, skipped, conflicts }
}

/** Build the load-bearing operation record for one patch file. */
async function prepareOne(
  file: PatchFile,
  adapter: IoAdapter,
  fuzzContext: number,
): Promise<PreparedOp> {
  const base = {
    file,
    kind: file.kind,
    sourceStartLine: file.sourceStartLine,
    fromDisplay: null as string | null,
  }

  // ---- create --------------------------------------------------------------
  if (file.kind === 'create') {
    const target = await adapter.resolve(file.newPath ?? '')
    const probe = await adapter.probe(target.key)
    if (probe.exists) {
      throw new PatchValidationError(`cannot create ${target.display}: file already exists`)
    }
    // The hunks add every line to the empty buffer; apply them for real so the
    // created file carries its content and gets a usable reverse patch.
    const transform = transformLines([], '\n', file.hunks, { fuzzContext, fileLabel: target.display })
    if (!transform.ok) {
      throw new PatchConflictError(
        `cannot apply hunk ${transform.conflict.hunkNumber} of ${target.display} (patch line ${transform.conflict.sourceLine}): ${transform.conflict.reason}`,
        transform.conflict,
      )
    }
    return {
      ...base,
      kind: 'create',
      display: target.display,
      fromDisplay: null,
      sourceKey: null,
      targetKey: target.key,
      sourceIdentity: undefined,
      contentBefore: null,
      contentAfter: joinLines(transform.lines),
      eol: transform.eol,
      applied: transform.applied,
    }
  }

  // ---- everything else reads its content source first -----------------------
  const sourcePath = file.renameFrom ?? file.copyFrom ?? file.oldPath
  const source = await adapter.resolve(sourcePath ?? '')
  const probe = await adapter.probe(source.key)
  if (!probe.exists) {
    throw new PatchValidationError(`target file not found: ${source.display}`)
  }

  // ---- delete --------------------------------------------------------------
  if (file.kind === 'delete') {
    // Hunks on a delete patch validate the current content, then we remove it.
    const contentBefore = await adapter.readText(source.key)
    const { lines, eol } = splitLines(contentBefore)
    const transform = transformLines(lines, eol, file.hunks, { fuzzContext, fileLabel: source.display })
    if (!transform.ok) {
      throw new PatchConflictError(
        `cannot apply hunk ${transform.conflict.hunkNumber} of ${source.display} (patch line ${transform.conflict.sourceLine}): ${transform.conflict.reason}`,
        transform.conflict,
      )
    }
    return {
      ...base,
      kind: 'delete',
      display: source.display,
      fromDisplay: null,
      sourceKey: source.key,
      targetKey: null,
      sourceIdentity: probe.identity,
      contentBefore,
      contentAfter: null,
      eol,
      applied: [],
    }
  }

  // ---- mode-only ------------------------------------------------------------
  if (file.kind === 'mode') {
    return {
      ...base,
      display: source.display,
      fromDisplay: null,
      sourceKey: source.key,
      targetKey: source.key,
      sourceIdentity: probe.identity,
      contentBefore: null,
      contentAfter: null,
      eol: '\n',
      applied: [],
    }
  }

  // ---- modify / rename / copy ------------------------------------------------
  const contentBefore = await adapter.readText(source.key)
  const { lines, eol } = splitLines(contentBefore)

  let target = { key: source.key, display: source.display }
  if (file.kind === 'rename' || file.kind === 'copy') {
    const dest = await adapter.resolve(file.newPath ?? '')
    const destProbe = await adapter.probe(dest.key)
    if (destProbe.exists) {
      throw new PatchValidationError(`${file.kind} destination already exists: ${dest.display}`)
    }
    target = dest
  }

  const transform = transformLines(lines, eol, file.hunks, {
    fuzzContext,
    fileLabel: target.display,
  })
  if (!transform.ok) {
    throw new PatchConflictError(
      `cannot apply hunk ${transform.conflict.hunkNumber} of ${target.display} (patch line ${transform.conflict.sourceLine}): ${transform.conflict.reason}`,
      transform.conflict,
    )
  }

  return {
    ...base,
    display: target.display,
    fromDisplay: file.kind === 'rename' || file.kind === 'copy' ? source.display : null,
    sourceKey: source.key,
    targetKey: target.key,
    sourceIdentity: probe.identity,
    contentBefore,
    contentAfter: joinLines(transform.lines),
    eol: transform.eol,
    applied: transform.applied,
  }
}

/** Build the reverse patch block for one prepared op. */
function reverseBlockFor(op: PreparedOp): string[] {
  return buildReverseBlock({
    file: op.file,
    applied: op.applied.length > 0 ? op.applied : null,
    contentAfter: op.contentAfter,
    contentBefore: op.contentBefore,
  })
}

function resultFor(op: PreparedOp): FileOperationResult {
  const result: FileOperationResult = {
    path: op.display,
    operation: op.file.kind === 'binary'
      ? 'binary'
      : (op.file.kind as FileOperationResult['operation']),
    hunks: op.applied,
    sourceStartLine: op.file.sourceStartLine,
  }
  if (op.fromDisplay !== null) result.fromPath = op.fromDisplay
  return result
}

/** Compare an abbreviated `index`-line sha against a full computed blob sha (prefix-insensitive). */
function shaMatches(indexSha: string, fullSha: string): boolean {
  return indexSha.length <= fullSha.length
    && indexSha.toLowerCase() === fullSha.slice(0, indexSha.length).toLowerCase()
}

/** Preflight SHA-1 notes when `index` shas are present. */
function shaNotes(ops: readonly PreparedOp[], strictSha: boolean, notes: string[], conflicts: HunkConflict[]): void {
  for (const op of ops) {
    const f = op.file
    if (f.oldSha === null && f.newSha === null) continue
    if (op.contentBefore !== null && f.oldSha !== null) {
      const got = blobSha(op.contentBefore)
      if (!shaMatches(f.oldSha, got)) {
        const note = `${op.display}: old blob SHA-1 (${got.slice(0, 12)}…) does not match the patch's index line (${f.oldSha.slice(0, 12)}…)`
        if (strictSha) {
          conflicts.push({
            file: op.display,
            hunkNumber: 0,
            sourceLine: f.sourceStartLine,
            reason: 'old content does not match the patch basis (index line SHA-1)',
            expected: [f.oldSha],
            actual: [got],
            anchorLine: 1,
          })
        } else {
          notes.push(note)
        }
      }
    }
    if (op.contentAfter !== null && f.newSha !== null) {
      const got = blobSha(op.contentAfter)
      if (!shaMatches(f.newSha, got)) {
        const note = `${op.display}: resulting blob SHA-1 (${got.slice(0, 12)}…) does not match the patch's index line (${f.newSha.slice(0, 12)}…)`
        notes.push(note)
      }
    }
  }
}

/**
 * Apply a unified diff to the filesystem.
 * @param patchText - the raw patch.
 * @param options - {@link ApplyOptions}.
 * @returns {@link ApplyReport}; throws only on unexpected (non-`PatchError`) failures.
 */
export async function applyPatchText(patchText: string, options: ApplyOptions): Promise<ApplyReport> {
  const dryRun = options.dryRun ?? false
  const undo = options.undo ?? true
  const strictSha = options.strictSha ?? false
  const adapter: IoAdapter = options.io ?? new NodeIoAdapter({ root: options.root, allowRootEscape: options.rootEscape })
  const root = adapter.root
  const fuzzContext = options.fuzzContext ?? DEFAULT_FUZZ

  const report: ApplyReport = {
    ok: false,
    dryRun,
    files: [],
    conflicts: [],
    errors: [],
    notes: [],
    reversePatch: null,
    undoFile: null,
  }

  // ---- Phase 0: parse (fail fast, precise line numbers) --------------------
  let parsed
  try {
    parsed = parsePatch(patchText)
  } catch (error) {
    if (error instanceof PatchError) {
      report.errors.push({ code: error.code, path: '', message: error.message })
      return report
    }
    throw error
  }

  // ---- Phase 1: prepare + validate everything in memory ---------------------
  let prepared: PreparedResult
  try {
    prepared = await prepare(parsed, adapter, fuzzContext)
  } catch (error) {
    if (error instanceof PatchError) {
      report.errors.push({
        code: error.code,
        path: error instanceof PatchIoError ? error.path : '',
        message: error.message,
      })
      return report
    }
    throw error
  }

  const { ops, skipped, conflicts } = prepared
  report.files.push(
    ...skipped,
    ...(dryRun ? ops.map(resultFor) : []),
  )
  report.conflicts.push(...conflicts)
  shaNotes(ops, strictSha, report.notes, report.conflicts)

  if (dryRun) {
    // Never mutate; still surface what the reverse patch *would* be when the
    // patch is clean (keeps the `reverse` command free of side effects).
    if (report.conflicts.length === 0 && report.errors.length === 0) {
      try {
        const allBlocks = ops.map(reverseBlockFor)
        report.reversePatch = allBlocks.some((b) => b.length > 0) ? joinReverseBlocks(allBlocks) : null
      } catch {
        // Reverse computation is best-effort in dry-run; not load-bearing.
      }
    }
    report.ok = report.errors.length === 0 && report.conflicts.length === 0
    return report
  }

  if (report.errors.length > 0 || report.conflicts.length > 0) {
    report.files.push(...ops.map(resultFor))
    report.ok = false
    return report
  }

  // ---- Phase 2: build reverse + journal, then commit -------------------------
  let reverseText: string | null = null
  try {
    const allBlocks = ops.map(reverseBlockFor)
    reverseText = allBlocks.some((b) => b.length > 0) ? joinReverseBlocks(allBlocks) : null
  } catch (error) {
    if (error instanceof PatchError) {
      report.errors.push({ code: error.code, path: '', message: error.message })
      report.ok = false
      return report
    }
    throw error
  }

  const undoFile = options.undoFile ?? path.join(root, JOURNAL_DEFAULT_NAME)
  let journalWritten = false
  if (undo && reverseText !== null) {
    const identities: Record<string, string> = {}
    for (const op of ops) {
      if (op.sourceIdentity !== undefined && op.sourceKey !== null) {
        identities[toRel(root, op.sourceKey)] = op.sourceIdentity
      }
    }
    try {
      await writeJournal(undoFile, {
        schema: 'dsh-patch-apply/undo',
        version: 1,
        createdAt: new Date().toISOString(),
        root,
        reversePatch: reverseText,
        files: ops.map((op) => ({ path: toRel(root, op.display), kind: op.file.kind })),
        identities,
      })
      journalWritten = true
    } catch (error) {
      if (error instanceof PatchError) {
        report.errors.push({ code: error.code, path: undoFile, message: error.message })
        report.ok = false
        return report
      }
      throw error
    }
  }

  const targets = ops
    .map((op) => (op.kind !== 'mode' ? op.targetKey : null) ?? op.sourceKey)
    .filter((x): x is string => x !== null)
  if (options.beforeCommit !== undefined) {
    try {
      await options.beforeCommit(targets)
    } catch (error) {
      // Nothing has been mutated yet; the journal (if any) is left in place.
      report.errors.push(toErrorEntry(error))
      report.ok = false
      return report
    }
  }

  const commitError = await runCommit(ops, adapter, options, root)
  if (commitError !== null) {
    report.files.push(...ops.map(resultFor))
    report.errors.push(commitError)
    report.ok = false
    // Journal (if any) is left in place so the user can still revert by hand.
    return report
  }

  report.files.push(...ops.map(resultFor))
  report.reversePatch = reverseText
  report.undoFile = journalWritten && undo ? undoFile : null
  report.ok = true
  return report
}

/** Run the mutation pipeline; returns the first error entry or null. */
async function runCommit(
  ops: readonly PreparedOp[],
  adapter: IoAdapter,
  options: ApplyOptions,
  root: string,
): Promise<ApplyErrorEntry | null> {
  const written: PreparedOp[] = []
  const chmodded: PreparedOp[] = []
  const removed: PreparedOp[] = []

  try {
    // 1. Content writes (guarded), creates first in order.
    for (const op of ops) {
      if (op.contentAfter === null || op.targetKey === null) continue
      // In-place modify that produces identical content: not a mutation.
      if (op.file.kind === 'modify' && op.contentBefore === op.contentAfter) continue

      let guard: WriteGuard | undefined
      if (op.file.kind === 'create' || op.file.kind === 'rename' || op.file.kind === 'copy') {
        guard = { kind: 'absent' }
      } else if (op.file.kind === 'modify' && op.sourceIdentity !== undefined && op.sourceKey === op.targetKey) {
        guard = { kind: 'identity', identity: op.sourceIdentity }
      }

      if (adapter.capabilities.mkdir) {
        await adapter.mkdirp(path.dirname(op.targetKey))
      }
      await adapter.writeText(op.targetKey, op.contentAfter, guard)
      if (options.onWrite !== undefined) await options.onWrite(op.targetKey)
      written.push(op)
    }

    // 2. Permission changes.
    for (const op of ops) {
      const newMode = op.file.newMode === null ? null : op.file.newMode & 0o777
      const oldMode = op.file.oldMode === null ? null : op.file.oldMode & 0o777
      if (newMode === null || op.targetKey === null) continue
      const needsChmod = op.file.kind === 'mode'
        || op.file.kind === 'create'
        || (op.file.kind !== 'delete' && oldMode !== null && newMode !== oldMode)
      if (!needsChmod) continue
      if (!adapter.capabilities.chmod) {
        throw new PatchIoError(
          'this backend cannot change permissions; cannot apply a mode change',
          'chmod',
          op.targetKey,
        )
      }
      await adapter.chmod(op.targetKey, newMode)
      chmodded.push(op)
    }

    // 3. Removals (delete / rename source) after all content is in place.
    //    Removals are version-guarded too: a file that changed since it was
    //    validated must not be silently removed.
    for (const op of ops) {
      if (op.file.kind !== 'delete' && op.file.kind !== 'rename') continue
      if (op.sourceKey === null) continue
      if (!adapter.capabilities.unlink) {
        throw new PatchIoError(
          'this backend cannot unlink files; cannot apply a delete/rename',
          'unlink',
          op.sourceKey,
        )
      }
      const probe = await adapter.probe(op.sourceKey)
      if (!probe.exists || probe.identity !== op.sourceIdentity) {
        throw new PatchStaleError(
          `refusing to remove ${op.sourceKey}: file changed since it was validated (expected identity ${op.sourceIdentity})`,
        )
      }
      await adapter.remove(op.sourceKey)
      removed.push(op)
    }
  } catch (error) {
    const entry = toErrorEntry(error)
    const restored = await rollback(written, chmodded, removed, adapter)
    if (!restored) {
      entry.message += ' — partial rollback: at least one file could not be restored; run `undo` if a journal was written'
    }
    void root
    return entry
  }
  return null
}

/** Best-effort restore of every mutation performed so far; true when complete. */
async function rollback(
  written: readonly PreparedOp[],
  chmodded: readonly PreparedOp[],
  removed: readonly PreparedOp[],
  adapter: IoAdapter,
): Promise<boolean> {
  const steps: Array<() => Promise<void>> = []
  for (const op of [...written].reverse()) {
    const targetKey = op.targetKey
    if (op.file.kind === 'create' || op.file.kind === 'rename' || op.file.kind === 'copy') {
      if (targetKey !== null) steps.push(() => adapter.remove(targetKey))
    } else if (op.contentBefore !== null && targetKey !== null) {
      const before = op.contentBefore
      steps.push(() => adapter.writeText(targetKey, before))
    }
  }
  for (const op of [...removed].reverse()) {
    const sourceKey = op.sourceKey
    if (op.contentBefore !== null && sourceKey !== null) {
      const before = op.contentBefore
      steps.push(() => adapter.writeText(sourceKey, before))
    }
  }
  for (const op of [...chmodded].reverse()) {
    const oldMode = op.file.oldMode === null ? null : op.file.oldMode & 0o777
    const targetKey = op.targetKey
    if (oldMode !== null && targetKey !== null) steps.push(() => adapter.chmod(targetKey, oldMode))
  }
  try {
    for (const step of steps) await step()
    return true
  } catch {
    return false
  }
}

function toErrorEntry(error: unknown): ApplyErrorEntry {
  if (error instanceof PatchError) {
    return {
      code: error.code,
      path: error instanceof PatchIoError ? error.path : '',
      message: error.message,
    }
  }
  return { code: 'IO', path: '', message: (error as Error).message }
}

/** Relative path helper (presentation only). */
function toRel(root: string, abs: string): string {
  const rel = path.relative(root, abs)
  return rel === '' ? path.basename(abs) : rel
}

/**
 * Undo a recorded apply by applying its reverse patch.
 *
 * Staleness is enforced by exact content matching, not by the recorded
 * identities: the reverse hunks only match the state the apply produced, so
 * any editing since then surfaces as a precise CONFLICT (expected vs actual)
 * and nothing is written. The journal's `identities` field documents the
 * pre-apply baseline for diagnostics only.
 * @param journal - a previously recorded undo journal.
 * @param options - root override, fuzzy tolerance, adapter, test seams.
 */
export async function applyUndo(
  journal: UndoJournal,
  options?: { root?: string; fuzzContext?: number; io?: IoAdapter; beforeCommit?: ApplyOptions['beforeCommit'] },
): Promise<ApplyReport> {
  const root = options?.root ?? journal.root
  const adapter: IoAdapter = options?.io ?? new NodeIoAdapter({ root, allowRootEscape: false })

  return applyPatchText(journal.reversePatch, {
    root,
    fuzzContext: options?.fuzzContext ?? DEFAULT_FUZZ,
    undo: false,
    io: adapter,
    beforeCommit: options?.beforeCommit,
  })
}
