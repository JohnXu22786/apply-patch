/**
 * dsh-patch-apply — DeepSeek Harness bundle entry.
 *
 * Exports the Cordis plugin contract (`name` / `inject` / `apply`) the loader
 * mounts through the bundle's `cordis.patch.yml` row, and re-exports the
 * library API so the same engine is usable standalone (CLI, scripts, tests).
 *
 * Zero runtime dependencies: the `ctx` parameter is used structurally (tools
 * registry + optional service access), so no cordis/dsh package is required
 * at runtime.
 * @module
 */

import type { Config, ToolContext } from './tools.ts'
import { applyTool, dryRunTool, reverseTool, statTool } from './tools.ts'

/** Cordis plugin name (reader-facing label in diagnostics). */
export const name = 'dsh-patch-apply'

/** Services this plugin requires to be mounted before `apply`. */
export const inject = ['tools']

/** Plugin version, mirroring package.json. */
export const VERSION = '1.0.0'

/**
 * Mount the four patch tools on `ctx.tools`.
 *
 * Returns a disposer that unregisters the tools when the plugin is unmounted,
 * matching the dsh/cordis `apply` contract.
 *
 * @param ctx - the Cordis context with the `tools` service injected.
 * @param config - optional plugin configuration (defaults applied here).
 */
export function apply(ctx: ToolContext, config: Config = {}): () => void {
  const cfg: Config = {
    defaultRoot: config.defaultRoot ?? process.cwd(),
    io: config.io ?? 'node',
    fuzzContext: config.fuzzContext ?? 3,
    undo: config.undo ?? true,
    strictSha: config.strictSha ?? false,
  }
  const disposers: Array<(() => void) | void> = [
    ctx.tools.register(applyTool(ctx, cfg)),
    ctx.tools.register(dryRunTool(ctx, cfg)),
    ctx.tools.register(reverseTool(ctx, cfg)),
    ctx.tools.register(statTool(ctx, cfg)),
  ]
  return () => {
    for (const dispose of disposers) dispose?.()
  }
}

/** Config schema marker so the loader can expose structured configuration. */
export { Config } from './tools.ts'

// Public library API -----------------------------------------------------------
export { applyPatchText, applyUndo } from './apply.ts'
export type {
  ApplyErrorEntry,
  ApplyOptions,
  ApplyReport,
  FileOperationResult,
} from './apply.ts'
export { parsePatch } from './parse.ts'
export type { ParsedPatch, PatchFile, Hunk, HunkConflict, DiffLine } from './types.ts'
export { statPatch } from './stat.ts'
export type { PatchStat, FileStat } from './stat.ts'
export { NodeIoAdapter, CtxFsIoAdapter } from './io.ts'
export type { IoAdapter, Capabilities, ProbeInfo, WriteGuard } from './io.ts'
export { readJournal, writeJournal } from './journal.ts'
export type { UndoJournal } from './journal.ts'
export { blobSha } from './sha.ts'
export {
  PatchError,
  PatchParseError,
  PatchConflictError,
  PatchValidationError,
  PatchStaleError,
  PatchIoError,
  PatchBinaryError,
  PatchUnsupportedError,
} from './errors.ts'
export type { PatchErrorCode } from './errors.ts'
