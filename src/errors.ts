/**
 * Typed error vocabulary. Every failure surfaces a stable `code` plus, where
 * useful, structured context, so callers (tools, CLI, tests) can branch on
 * machine-readable codes instead of parsing messages.
 * @module
 */

import type { HunkConflict } from './types.ts'

/** Every code this package emits. */
export type PatchErrorCode =
  | 'PARSE'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'STALE'
  | 'IO'
  | 'BINARY'
  | 'UNSUPPORTED'

/** A base package error carrying a stable machine code. */
export class PatchError extends Error {
  override name: string = 'PatchError'
  readonly code: PatchErrorCode

  constructor(message: string, code: PatchErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** Malformed or unparseable diff text; `sourceLine` is 1-based into the patch text. */
export class PatchParseError extends PatchError {
  override readonly name = 'PatchParseError'
  readonly sourceLine: number
  readonly near: string

  constructor(message: string, sourceLine: number, near: string) {
    super(`parse error at patch line ${sourceLine}: ${message} (near: ${JSON.stringify(near)})`, 'PARSE')
    this.sourceLine = sourceLine
    this.near = near
  }
}

/** A hunk could not be located safely; carries the full structured report. */
export class PatchConflictError extends PatchError {
  override readonly name = 'PatchConflictError'
  readonly conflict: HunkConflict

  constructor(message: string, conflict: HunkConflict) {
    super(message, 'CONFLICT')
    this.conflict = conflict
  }
}

/** Structural problem independent of hunk content (create-over-existing, etc.). */
export class PatchValidationError extends PatchError {
  override readonly name = 'PatchValidationError'

  constructor(message: string) {
    super(message, 'VALIDATION')
  }
}

/** The on-disk identity of a file changed between read and write. */
export class PatchStaleError extends PatchError {
  override readonly name = 'PatchStaleError'

  constructor(message: string) {
    super(message, 'STALE')
  }
}

/** A filesystem operation failed. */
export class PatchIoError extends PatchError {
  override readonly name = 'PatchIoError'
  readonly operation: string
  readonly path: string

  constructor(message: string, operation: string, path: string, options?: ErrorOptions) {
    super(message, 'IO', options)
    this.operation = operation
    this.path = path
  }
}

/** A patched target is binary or a patch labels a file binary. */
export class PatchBinaryError extends PatchError {
  override readonly name = 'PatchBinaryError'

  constructor(message: string) {
    super(message, 'BINARY')
  }
}

/** The patch uses a feature outside this parser's scope. */
export class PatchUnsupportedError extends PatchError {
  override readonly name = 'PatchUnsupportedError'

  constructor(message: string) {
    super(message, 'UNSUPPORTED')
  }
}
