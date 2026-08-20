/**
 * Shared types for the patch engine.
 *
 * The engine is deliberately transport-agnostic: it never touches the
 * filesystem. Parsing produces {@link ParsedPatch} from text; the in-memory
 * transform layer consumes that patch plus line arrays. Filesystem concerns
 * (reading, atomic writing, version guards) live in `io.ts` / `apply.ts`, so
 * the core can be unit-tested without a disk.
 * @module
 */

/** The two line-ending flavours this engine understands natively. */
export type LineEnding = '\r\n' | '\n'

/** The line separator that terminated this line, or '' for a final line without one. */
export type LineSep = '\r\n' | '\n' | ''

/**
 * One logical line of a file in memory: `text` without the line terminator,
 * plus the literal terminator (`sep`) that preserves byte-exact round trips.
 */
export interface FileLine {
  text: string
  sep: LineSep
}

/** The role a line plays inside a patch hunk. */
export type DiffLineKind = 'context' | 'add' | 'del'

/** One signed line of a hunk body (` `, `+`, or `-` in raw patch form). */
export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** True when this line carries `\ No newline at end of file`. */
  noNewline: boolean
}

/**
 * A parsed `@@ -l,c +l,c @@` hunk. The header numbers are kept verbatim (they
 * drive offset-corrected location), and the old/new side line arrays are
 * rebuilt in file order so location and application stay simple and exact.
 */
export interface Hunk {
  /** 0-based index of this hunk within its file. */
  index: number
  /** 1-based first old-file line from the header; 0 means insert at file start. */
  oldStart: number
  /** Old-side line count from the header. */
  oldCount: number
  /** 1-based first new-file line from the header. */
  newStart: number
  /** New-side line count from the header. */
  newCount: number
  /** Optional section heading text after `@@ ... @@`. */
  section: string
  /** 1-based line of the patch text this hunk header sits on. */
  sourceLine: number
  /** Old-side lines in old-file order (context and deletions). */
  oldLines: DiffLine[]
  /** New-side lines in new-file order (context and additions). */
  newLines: DiffLine[]
  /** Shortcut texts of {@link Hunk.oldLines} for matching. */
  oldTexts: string[]
  /** Parallel no-newline flags for {@link Hunk.oldLines}. */
  oldNewline: boolean[]
  /** True when this hunk's last old-line was the file's final line without a newline. */
  oldEndsWithoutNewline: boolean
  /** True when the new side's last line has no trailing newline. */
  newEndsWithoutNewline: boolean
}

/** The file-level action a parsed patch block requests. */
export type PatchKind =
  | 'create'
  | 'delete'
  | 'modify'
  | 'rename'
  | 'copy'
  | 'mode'
  | 'binary'

/** One parsed file block of a patch (`diff --git` header or bare `---`/`+++`). */
export interface PatchFile {
  /** 0-based index of this file within the patch. */
  index: number
  kind: PatchKind
  /** Old path; null for `/dev/null`. */
  oldPath: string | null
  /** New path; null for `/dev/null`. */
  newPath: string | null
  /** Octal mode (100644 etc. as a number) when the patch states one. */
  oldMode: number | null
  newMode: number | null
  /** Paths from `rename from/to` headers, when present. */
  renameFrom: string | null
  renameTo: string | null
  /** Paths from `copy from/to` headers, when present. */
  copyFrom: string | null
  copyTo: string | null
  /** Blob shas from the `index` line, when present. */
  oldSha: string | null
  newSha: string | null
  hunks: Hunk[]
  /** True when the block labels itself binary (`Binary files ...` / `GIT binary patch`). */
  binary: boolean
  /** Human note about the binary label, for reporting. */
  binaryNote?: string
  /** 1-based patch-text line where the block begins. */
  sourceStartLine: number
}

/** The result of {@link parsePatch}: a whole, validated patch. */
export interface ParsedPatch {
  files: PatchFile[]
}

/** How a hunk was located in the target file. */
export type MatchStatus = 'exact' | 'offset' | 'fuzzy'

/** Outcome of locating one hunk against a file's lines. */
export interface MatchResult {
  status: MatchStatus
  /** 0-based index where the old-side block was found. */
  pos: number
  /** Number of leading context lines dropped during fuzzy matching; 0 otherwise. */
  fuzz: number
}

/** Record of one successfully applied hunk. */
export interface AppliedHunk {
  /** 0-based hunk index within the file. */
  index: number
  /** 1-based hunk number, for messages. */
  hunkNumber: number
  status: MatchStatus
  fuzz: number
  /** 1-based line of the final file where the old-side block started. */
  atLine: number
  /**
   * Old-side lines actually replaced (full window minus any fuzzed leading
   * context) — what the reverse patch must re-add.
   */
  removedLines: DiffLine[]
  /**
   * New-side lines actually inserted (full window minus any fuzzed leading
   * context) — what the reverse patch must remove.
   */
  insertedLines: DiffLine[]
}

/** Precise description of a hunk that could not be located safely. */
export interface HunkConflict {
  /** Display path of the target file. */
  file: string
  /** 1-based hunk number. */
  hunkNumber: number
  /** 1-based line of the failing hunk header in the patch text. */
  sourceLine: number
  /** Why the hunk could not be applied. */
  reason: string
  /** Old-side lines the hunk requires (up to a cap, for messages). */
  expected: string[]
  /** Actual file lines at the relevant location (up to a cap). */
  actual: string[]
  /** 1-based file line the inspection centred on (best-effort). */
  anchorLine: number
}
