# dsh-patch-apply

[![CI](https://github.com/JohnXu22786/apply-patch/actions/workflows/ci.yml/badge.svg)](https://github.com/JohnXu22786/apply-patch/actions/workflows/ci.yml)

**Apply structured unified diffs (git format) to the real filesystem inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — and anywhere else Node runs.**

> **中文文档：[README.zh.md](README.zh.md)**

dsh ships string-level `edit`/`write` tools but no structured diff-applier that **writes** to disk. `dsh-patch-apply` fills that gap: it parses a unified diff, applies every hunk with fuzzy context tolerance and line-offset correction, guards the whole operation so it is **all-or-nothing**, and records a **reverse patch** for byte-exact undo.

Zero runtime dependencies. TypeScript sources, plain-object tool definitions, Node's built-in test runner.

---

## Highlights

- **Full `git diff` coverage** — multi-file, multi-hunk, `±`/context/add/delete, `/dev/null` creates & deletes, `rename from/to`, `copy from/to`, `old mode`/`new mode`, `index` shas, `\ No newline at end of file`, binary labels (`Binary files … differ`, `GIT binary patch`), quoted paths with spaces. Classic bare `---`/`+++` patches are accepted too.
- **Self-implemented parser** — no heavy dependencies; the parser validates hunk headers against actual body line counts and fails with the precise patch line number on malformed input.
- **Precise hunk location** — exact-at-anchor → exact-anywhere (line-offset correction) → fuzzy (leading-context tolerance, GNU-patch style), where *deletions can never be fuzzed*, so a fuzzy match cannot delete wrong content.
- **All-or-nothing atomicity** — every file is parsed and validated in memory before anything is written; any hunk conflict or structural violation means *nothing* is written.
- **Version guard** — uses the *identical identity recipe* as the official dsh filesystem (`dev:ino:size:mtimeNs:ctimeNs`, see [Version-guard coordination](#version-guard-coordination-with-the-official-dsh-fs)); writes re-check identity at publication time and abort with `STALE` on drift.
- **Undo everywhere** — a reverse patch is computed before mutating and an undo journal is written first; `undo` restores byte-identical state. Applies to creates, deletes, renames, copies and mode changes too.
- **dry-run** — validates applicability statically; reports conflicts (`expected` vs `actual`, hunk number, patch line) without touching the disk.
- **CRLF / LF fidelity** — files are modelled line-by-line with their own terminators; untouched regions round-trip byte-for-byte, including mixed endings and a missing trailing newline.
- **Binary safety** — binary-labelled files are skipped and reported; a text patch aimed at a binary target is detected (NUL bytes / invalid UTF-8) and skipped, never corrupted.

---

## Installation

### As a dsh bundle (recommended)

The package is a standard dsh bundle: `package.json` declares
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, and the patch inserts
one Cordis plugin row whose module exports `{ name, inject, apply }` and
registers the four tools on the harness tool registry (`ctx.tools`).

```sh
# published to a registry
dsh plugin --profile <name> add dsh-patch-apply

# straight from this repository
dsh plugin --profile <name> add github:JohnXu22786/apply-patch

# or from a local checkout
dsh plugin --profile <name> add /path/to/apply-patch
```

Nothing else to configure — the tools `patch_apply`, `patch_dry_run`,
`patch_reverse`, `patch_stat` become available to the model immediately.

Optional plugin config (set as a later profile patch layer targeting the
`patch-apply` row, or in the row's `config`):

```yaml
- config:
    id: patch-apply
    defaultRoot: /abs/path/to/workspace   # base for relative patch paths (default: process.cwd())
    io: node                              # node | ctx-fs (see below)
    fuzzContext: 3                        # max leading context lines droppable by fuzzy matching
    undo: true                            # persist an undo journal on patch_apply
    strictSha: false                      # treat index-line SHA-1 mismatches as hard conflicts
```

### As a standalone CLI

```sh
npm install dsh-patch-apply          # or: link from a local checkout
npx dsh-patch --help
```

### As a library

```sh
npm install dsh-patch-apply
```

```ts
import { applyPatchText, applyUndo, parsePatch, statPatch } from 'dsh-patch-apply'
```

---

## Usage

### 1. dsh tools

| Tool | Purpose |
|---|---|
| `patch_apply` | Apply a unified diff, all-or-nothing, with undo journaling. |
| `patch_dry_run` | Validate applicability; report every conflict; write nothing. |
| `patch_reverse` | Produce the reverse patch (validated first) without applying. |
| `patch_stat` | Summarise a patch (files, hunks, +/−/context counts) without touching the filesystem. |

Common arguments:

- `patch` *(string, required)* — the unified diff text.
- `cwd` *(string, optional)* — base directory for relative paths (default: `config.defaultRoot`).
- `dry_run` / `verify_sha` *(boolean, optional)* — dry-run mode / hard SHA-1 mismatch.

`patch_apply` returns:

```jsonc
{
  "ok": true,
  "dryRun": false,
  "files": [{ "path": "...", "operation": "modify", "hunks": [{ "hunkNumber": 1, "status": "offset", "atLine": 12 }] }],
  "conflicts": [],            // [{ file, hunkNumber, sourceLine, reason, expected[], actual[], anchorLine }]
  "errors": [],               // [{ code, path, message }]
  "notes": [],                // informational, e.g. SHA-1 pre-flight mismatches
  "reversePatch": "diff --git ...",
  "undoFile": "/abs/.dsh-patch-undo.json"
}
```

`files` lists each prepared file operation with its per-hunk statuses — what
*was* applied on success, or what *would* be applied in dry-run. All-or-nothing
means: `ok: false` (any non-empty `conflicts`/`errors`) guarantees nothing was
written, and on success every hunk of every file was located and committed.

### 2. CLI

```
dsh-patch <command> [options] <file>

Commands
  apply   <patch>    apply a unified diff (writes an undo journal by default)
  dry-run <patch>    validate applicability; report conflicts; never write
  reverse <patch>    print the reverse patch (or write it with --out)
  stat    <patch>    summarize a patch without touching the filesystem
  undo    <journal>  apply the reverse patch recorded in an undo journal
  help               show this help

Options
  --root <dir>      base directory for relative patch paths (default: cwd)
  --dry-run         alias for dry-run behavior on 'apply'
  --no-undo         do not write an undo journal
  --undo-file <p>   undo journal path for 'apply' (default: <root>/.dsh-patch-undo.json)
  --fuzz <n>        max leading context lines droppable in fuzzy match (default: 3)
  --strict-sha      treat index-line SHA-1 mismatches as hard conflicts
  --out <file>      write reverse output to a file instead of stdout
  --json            machine-readable JSON output on stdout
  --help            show this help
```

Exit codes: `0` success · `1` the patch could not be applied · `2` usage error.

```sh
dsh-patch apply changes.patch --root /workspace
dsh-patch dry-run changes.patch
dsh-patch reverse changes.patch > revert.patch
dsh-patch undo .dsh-patch-undo.json
```

### 3. Library

```ts
import { applyPatchText } from 'dsh-patch-apply'

const report = await applyPatchText(patchText, {
  root: process.cwd(),          // absolute base for relative paths
  fuzzContext: 3,               // fuzzy tolerance
  dryRun: false,                // validate only?
  undo: true,                   // write an undo journal?
  undoFile: '.dsh-patch-undo.json',
  strictSha: false,             // index SHA-1 mismatches as hard conflicts?
})
```

Other exports: `parsePatch`, `statPatch`, `applyUndo(journal)`,
`readJournal` / `writeJournal`, `blobSha`, the `IoAdapter`/`NodeIoAdapter`/
`CtxFsIoAdapter` filesystem seam, and the typed error classes.

---

## Error codes

| Code | Meaning |
|---|---|
| `PARSE` | Malformed diff; message includes the patch line number. |
| `CONFLICT` | A hunk could not be located safely; carries `expected` vs `actual` around the hunk's line. |
| `VALIDATION` | Structural problem before application (create-over-existing, missing target, path escape). |
| `STALE` | A file's identity changed between validation and commit (version guard tripped). |
| `IO` | A filesystem operation failed (write/chmod/unlink/…). |
| `BINARY` | A binary target / binary label — skipped, never corrupted. |
| `UNSUPPORTED` | Out-of-scope syntax (e.g. combined `diff --cc`) or an unavailable backend verb. |

---

## How it works

### Parser (`parse.ts`)

A state machine understands every block of a git diff and the classic bare
`---`/`+++` form. Each `@@` header is checked against the actual body line
counts as it is consumed — an over- or under-supplied hunk raises `PARSE` with
the offending patch line immediately, so a truncated or corrupted patch can
never misapply silently.

### Hunk location (`locate.ts`, `engine.ts`)

For each file, hunks are applied in order against the current in-memory buffer:

1. **exact** — the old-side block matches at the anchor (header line minus one,
   shifted by the net delta of earlier hunks);
2. **offset** — the full old-side block matches exactly elsewhere; the closest
   match to the anchor wins (corrects line-number drift);
3. **fuzzy** — up to `fuzzContext` *leading context* lines may be dropped to
   find a bolt. Only **context** lines are ever droppable (deletions must match
   exactly), and both the old and new sides drop the same prefix, so a fuzzy
   match can never delete wrong content or duplicate fuzzed context lines.

If no safe location exists the hunk is reported as a conflict with its 1-based
hunk number, its patch line, and a short excerpt of expected vs actual content
— and the whole patch is rejected without touching the disk.

### Atomicity & rollback (`apply.ts`, `io.ts`)

- All files are parsed, read, and transformed **in memory first**. Any conflict
  or structural violation ⇒ nothing is written.
- The reverse patch and (when enabled) the undo journal are written **before**
  the first mutation, so even a crash mid-commit leaves a complete reversion
  path.
- Content writes are **atomic per file** (temp file + rename) with parent
  directories created on demand, then permission changes, then
  deletes/rename-sources (so a destination is always fully written before its
  source disappears).
- If any write/chmod/unlink fails mid-commit, every already-mutated file is
  restored from the in-memory originals (best effort) and the error is
  reported. Physical multi-file atomicity across renames is not possible with a
  single filesystem call; the pre-commit validation is what makes the guarantee
  structural.

### Version-guard coordination with the official dsh fs

The official `@deepseek-ai/dsh-fs` backend derives its opaque `FsVersion` from
stat identity and freshness: `dev:ino:size:mtimeNs:ctimeNs`. This package
mirrors that exact recipe in `NodeIoAdapter.probe().identity`, so a version
token minted here means the same thing as one the harness mints. Before each
guarded write, the identity is re-probed at publication time and a drift aborts
with `STALE` and rolls back — the same stale-protection contract as the
official `writeText(…, { kind: 'replaceIfVersion' })`.

Two configuration notes, kept deliberately un-coupled:

- **Default `io: node`** — direct host access through `NodeIoAdapter`. This is
  what the CLI uses and what the whole test suite exercises.
- **`io: ctx-fs`** — resolves/stats/reads/writes route through the mounted
  harness `ctx.fs` service (`CtxFsIoAdapter`), mapping guarded writes onto the
  backend's own `createIfAbsent` / `replaceIfVersion` intents, i.e. the version
  guard is enforced by the backend itself. Because the official Service
  Definition exposes **no unlink/rename/chmod/mkdir verbs**, a patch needing
  those fails with a precise `UNSUPPORTED` error *before* any mutation rather
  than silently doing something surprising. For full coverage of delete /
  rename / mode operations, use `io: node`.

### Line endings

Files are kept as a list of `{ text, sep }` lines where `sep` is the line's own
literal terminator (`\r\n`, `\n`, or `''` for a final line without one). Patch
lines are matched on text only, so CRLF and LF files both apply cleanly; new
lines inserted by the patch inherit the file's dominant ending, and the
no-trailing-newline state is carried through the `\ No newline at end of file`
marker (old and new sides independently).

---

## Development

```sh
npm install
npm test          # tsc build, then node --test over build/test/*.test.js
npm run build     # tsc -> build/
npm run typecheck # tsc --noEmit
```

Test layout: `parse` (format coverage + malformed-input precision),
`apply` (single/multi-file, CRLF, create/delete/rename/copy/mode, binary,
dry-run purity, undo round-trips), `fuzzy` (offset / fuzzy / refusal paths,
SHA-1), `conflict` (report precision), `rollback` (all-or-nothing, physical
rollback on injected I/O failure, `STALE` guard), `cli` (exit codes, JSON,
reverse/undo flows).

## License

MIT — see [LICENSE](LICENSE). © 2026 dsh-patch-apply contributors.
