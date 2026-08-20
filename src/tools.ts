/**
 * The four dsh tools this bundle registers: `patch_apply`, `patch_dry_run`,
 * `patch_reverse`, `patch_stat`.
 *
 * The registrations are plain definitions (no helper dependency): parameters
 * use the standard `ParameterSchemaSpec` shape the harness's tool registry
 * accepts, `output.schema` declares the canonical JSON, and `render` formats
 * the model-facing text. Everything is applied through the shared
 * {@link applyPatchText} / {@link statPatch} core.
 *
 * **Filesystem mode.** `config.io` selects the backend:
 *   - `node` (default) — direct host filesystem via {@link NodeIoAdapter} with
 *     the dsh-compatible version guard.
 *   - `ctx-fs` — routes resolve/stat/read/write through the harness `ctx.fs`
 *     service (respecting a sandbox/permission backend and its own version
 *     guards); unlink/rename/chmod are unavailable there and fail precisely
 *     before any mutation because the official Service Definition exposes no
 *     such verbs.
 * @module
 */

import { applyPatchText } from './apply.ts'
import type { ApplyErrorEntry, ApplyOptions, ApplyReport, FileOperationResult } from './apply.ts'
import { CtxFsIoAdapter, NodeIoAdapter } from './io.ts'
import type { IoAdapter } from './io.ts'
import { parsePatch } from './parse.ts'
import { statPatch } from './stat.ts'
import type { PatchStat } from './stat.ts'
import type { HunkConflict } from './types.ts'

/** Structural subset of the harness `Context` this bundle depends on. */
export interface ToolContext {
  tools: {
    register(definition: ToolDefinition): (() => void) | void
  }
  /** Optional service access (used for the `ctx-fs` io mode). */
  get?(name: 'fs'): unknown
}

/** Structural shape of one tool definition — matches the registry's accepted form. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, object>
  output: {
    schema: object
    render(args: Record<string, unknown>, value: Record<string, unknown>): Array<{ type: string; text: string }>
  }
  execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown>
  presentCall?(args: Record<string, unknown>): { card: string; title: string; kind: string; rawInput?: unknown }
}

/** Plugin configuration. */
export interface Config {
  /** Base directory relative patch paths resolve against (`process.cwd()` default). */
  defaultRoot?: string
  /** Filesystem backend: `node` (default) or `ctx-fs`. */
  io?: 'node' | 'ctx-fs'
  /** Maximum leading context lines droppable by fuzzy matching (default 3). */
  fuzzContext?: number
  /** Whether `patch_apply` persists an undo journal (default true). */
  undo?: boolean
  /** Treat `index` SHA-1 mismatches as hard conflicts (default false). */
  strictSha?: boolean
}

const tool = (def: ToolDefinition): ToolDefinition => def

/** Shared args → (patch, cwd). */
function patchAndCwd(args: Record<string, unknown>, config: Config): { patchText: string; cwd: string } {
  const patchText = args.patch
  if (typeof patchText !== 'string' || patchText.length === 0) {
    throw new Error('`patch` must be a non-empty string of unified diff text')
  }
  const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : (config.defaultRoot ?? process.cwd())
  return { patchText, cwd }
}

/** Build the adapter the configured io mode calls for. */
function adapterFor(config: Config, ctx: ToolContext, cwd: string): IoAdapter {
  const mode = config.io ?? 'node'
  if (mode === 'node') return new NodeIoAdapter({ root: cwd })
  const fs = typeof ctx.get === 'function' ? ctx.get('fs') : undefined
  if (fs === undefined) {
    throw new Error('`io: ctx-fs` was configured but no fs service is mounted in this context')
  }
  return new CtxFsIoAdapter({ root: cwd, fs: fs as never })
}

function commonOptions(config: Config, ctx: ToolContext, cwd: string): ApplyOptions {
  return {
    root: cwd,
    fuzzContext: config.fuzzContext ?? 3,
    undo: config.undo ?? true,
    strictSha: config.strictSha ?? false,
    io: adapterFor(config, ctx, cwd),
  }
}

/** Render a compact human-readable summary line for the report text. */
export function summarizeReport(report: ApplyReport): string {
  const lines: string[] = []
  if (report.conflicts.length > 0) {
    for (const c of report.conflicts) {
      lines.push(
        `CONFLICT ${c.file} hunk #${c.hunkNumber} (patch line ${c.sourceLine}): ${c.reason}`,
      )
      lines.push(`  expected:`)
      for (const e of c.expected) lines.push(`    | ${e}`)
      lines.push(`  actual (around line ${c.anchorLine}):`)
      for (const a of c.actual) lines.push(`    | ${a}`)
    }
    return lines.join('\n')
  }
  if (report.errors.length > 0) {
    for (const e of report.errors) lines.push(`ERROR [${e.code}] ${e.path} ${e.message}`)
    return lines.join('\n')
  }
  for (const f of report.files) {
    const hunks = f.hunks.map((h) => `#${h.hunkNumber}:${h.status}${h.fuzz > 0 ? `(fuzz ${h.fuzz})` : ''}@${h.atLine}`).join(' ')
    const note = f.operation === 'binary' ? `[skip] ${f.skipReason ?? 'binary'}` : `[${f.operation}]`
    lines.push(`${note} ${f.path}${hunks ? ` — ${hunks}` : ''}`)
  }
  for (const n of report.notes) lines.push(`note: ${n}`)
  if (report.dryRun) lines.push('(dry-run: nothing was written)')
  if (report.undoFile !== null) lines.push(`undo journal: ${report.undoFile}`)
  return lines.join('\n')
}

/** The `patch_apply` tool: apply a unified diff, all-or-nothing. */
export function applyTool(ctx: ToolContext, config: Config): ToolDefinition {
  return tool({
    name: 'patch_apply',
    description:
      'Apply a structured unified diff (standard git diff format: multi-file, multi-hunk, create/delete/rename/mode/binary) to real files ON DISK. '
      + 'All-or-nothing: every file and hunk is validated in memory first; if any hunk cannot be located (with fuzzy context tolerance and line-offset correction) '
      + 'the whole patch is rejected and nothing is written. A reverse patch is computed and an undo journal is written before mutating, so applying the reverse '
      + 'patch restores the exact prior state. Binary files are skipped and reported. Prefer over string-level edit/write when you have a patch.',
    parameters: {
      patch: { type: 'string', required: true, description: 'The unified diff text (git format) to apply.' },
      cwd: { type: 'string', description: 'Base directory for relative paths in the patch; defaults to the plugin defaultRoot.' },
      dry_run: { type: 'boolean', description: 'Validate only: report conflicts and the files/hunks that would change, never write.' },
      verify_sha: { type: 'boolean', description: 'Treat index-line blob SHA-1 mismatches as hard conflicts (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          files: { type: 'array', items: { type: 'object' } },
          conflicts: { type: 'array', items: { type: 'object' } },
          errors: { type: 'array', items: { type: 'object' } },
          notes: { type: 'array', items: { type: 'string' } },
          reversePatch: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          undoFile: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: summarizeReport(value as unknown as ApplyReport) }],
    },
    async execute(args, exec) {
      void exec
      const { patchText, cwd } = patchAndCwd(args, config)
      const report = await applyPatchText(patchText, {
        ...commonOptions(config, ctx, cwd),
        dryRun: args.dry_run === true,
        strictSha: args.verify_sha === true || (config.strictSha ?? false),
      })
      return report
    },
    presentCall(args) {
      return { card: 'generic', title: 'Apply unified diff', kind: 'other', rawInput: args.patch }
    },
  })
}

/** The `patch_dry_run` tool: static applicability check, no mutation. */
export function dryRunTool(ctx: ToolContext, config: Config): ToolDefinition {
  return tool({
    name: 'patch_dry_run',
    description:
      'Validate whether a unified diff can be applied (parse + per-hunk location with fuzzy context tolerance and offset correction): '
      + 'reports every conflicting hunk (file, hunk number, expected vs actual content) and every would-be change, writes NOTHING.',
    parameters: {
      patch: { type: 'string', required: true, description: 'The unified diff text to validate.' },
      cwd: { type: 'string', description: 'Base directory for relative paths; defaults to the plugin defaultRoot.' },
      verify_sha: { type: 'boolean', description: 'Treat index-line blob SHA-1 mismatches as hard conflicts.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          files: { type: 'array', items: { type: 'object' } },
          conflicts: { type: 'array', items: { type: 'object' } },
          errors: { type: 'array', items: { type: 'object' } },
          notes: { type: 'array', items: { type: 'string' } },
          reversePatch: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          undoFile: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: summarizeReport(value as unknown as ApplyReport) }],
    },
    async execute(args, exec) {
      void exec
      const { patchText, cwd } = patchAndCwd(args, config)
      const report = await applyPatchText(patchText, {
        ...commonOptions(config, ctx, cwd),
        dryRun: true,
        undo: false,
        strictSha: args.verify_sha === true || (config.strictSha ?? false),
      })
      return report
    },
    presentCall(args) {
      return { card: 'generic', title: 'Dry-run unified diff', kind: 'other', rawInput: args.patch }
    },
  })
}

/** The `patch_reverse` tool: produce the reverse patch without applying. */
export function reverseTool(ctx: ToolContext, config: Config): ToolDefinition {
  return tool({
    name: 'patch_reverse',
    description:
      'Compute the reverse of a unified diff (swaps additions/deletions, inverts renames, turns creates into deletes and vice versa) '
      + 'validating applicability first (dry-run, nothing is written). The reverse patch, applied later, restores the exact prior state.',
    parameters: {
      patch: { type: 'string', required: true, description: 'The unified diff text to reverse.' },
      cwd: { type: 'string', description: 'Base directory for relative paths; defaults to the plugin defaultRoot.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          patch: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          conflicts: { type: 'array', items: { type: 'object' } },
          errors: { type: 'array', items: { type: 'object' } },
        },
      },
      render: (_args, value) => {
        const v = value as unknown as { ok: boolean; patch?: string }
        if (!v.ok) return [{ type: 'text', text: `cannot reverse this patch (see conflicts/errors)` }]
        return [{ type: 'text', text: v.patch ?? '' }]
      },
    },
    async execute(args, exec) {
      void exec
      const { patchText, cwd } = patchAndCwd(args, config)
      const report = await applyPatchText(patchText, {
        ...commonOptions(config, ctx, cwd),
        dryRun: true,
        undo: false,
      })
      if (!report.ok) {
        return { ok: false, patch: null, conflicts: report.conflicts, errors: report.errors }
      }
      return { ok: true, patch: report.reversePatch ?? '', conflicts: [], errors: [] }
    },
    presentCall(args) {
      return { card: 'generic', title: 'Reverse unified diff', kind: 'other', rawInput: args.patch }
    },
  })
}

/** The `patch_stat` tool: summarize a patch without touching the filesystem. */
export function statTool(_ctx: ToolContext, _config: Config): ToolDefinition {
  return tool({
    name: 'patch_stat',
    description:
      'Summarize a unified diff without touching the filesystem: per-file kind (create/delete/modify/rename/copy/mode/binary), hunk counts, '
      + 'added/deleted/context line counts, and totals.',
    parameters: {
      patch: { type: 'string', required: true, description: 'The unified diff text to summarize.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fileCount: { type: 'number', required: true },
          files: { type: 'array', items: { type: 'object' } },
          totalHunks: { type: 'number', required: true },
          totalAdded: { type: 'number', required: true },
          totalDeleted: { type: 'number', required: true },
          totalContext: { type: 'number', required: true },
          binaryCount: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatStat(value as unknown as PatchStat) }],
    },
    async execute(args, exec) {
      void exec
      if (typeof args.patch !== 'string' || args.patch.length === 0) {
        throw new Error('`patch` must be a non-empty string')
      }
      return statPatch(parsePatch(args.patch))
    },
    presentCall(args) {
      return { card: 'generic', title: 'Stat unified diff', kind: 'other', rawInput: args.patch }
    },
  })
}

/** Human-readable stat formatting (shared with the CLI). */
export function formatStat(stat: PatchStat): string {
  const rows = stat.files.map((f) => {
    const mode = f.mode !== null ? ` mode:${f.mode}` : ''
    return `${f.kind.padEnd(8)} ${f.path} hunks:${f.hunks} +${f.added} -${f.deleted}${mode}`
  })
  const suffix = stat.binaryCount > 0 ? `, ${stat.binaryCount} binary` : ''
  return [
    `files: ${stat.fileCount}, hunks: ${stat.totalHunks}, +${stat.totalAdded} / -${stat.totalDeleted} / ${stat.totalContext} context${suffix}`,
    ...rows,
  ].join('\n')
}

/** Wrap a throw into the dsh error path idiom used by the tools. */
export type { ApplyErrorEntry, ApplyReport, FileOperationResult, HunkConflict }
