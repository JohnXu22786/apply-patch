/**
 * Command-line interface for dsh-patch-apply (no runtime dependencies).
 *
 * Commands:
 *   apply   <patch>   apply a unified diff (all-or-nothing; undo journal by default)
 *   dry-run <patch>   validate applicability without touching anything
 *   reverse <patch>   print (or --out) the reverse patch
 *   stat    <patch>   summarize a patch without touching the filesystem
 *   undo    <journal> apply a recorded reverse patch
 *
 * Exit codes: 0 success, 1 the patch could not be applied (conflict/error),
 * 2 usage error. `--json` prints machine-readable output on stdout.
 * @module
 */

import { applyPatchText, applyUndo } from './apply.ts'
import type { ApplyReport } from './apply.ts'
import { PatchError } from './errors.ts'
import { readJournal } from './journal.ts'
import { parsePatch } from './parse.ts'
import { statPatch } from './stat.ts'
import { formatStat } from './tools.ts'
import { summarizeReport } from './tools.ts'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

/** Console-shaped output abstraction (swappable in tests). */
export interface CliStreams {
  out: (s: string) => void
  err: (s: string) => void
}

const USAGE = `dsh-patch — apply unified diffs to the real filesystem

Usage: dsh-patch <command> [options] <file>

Commands
  apply   <patch>    apply a unified diff (all-or-nothing; writes an undo journal)
  dry-run <patch>    validate applicability; report conflicts; never write
  reverse <patch>    print the reverse patch (or write it with --out)
  stat    <patch>    summarize a patch without touching the filesystem
  undo    <journal>  apply the reverse patch recorded in an undo journal
  help               show this help

Options
  --root <dir>      base directory for relative patch paths (default: cwd)
  --dry-run         alias for the dry-run behavior on 'apply'
  --no-undo         do not write an undo journal
  --undo-file <p>   undo journal path for 'apply' (default: <root>/.dsh-patch-undo.json)
  --fuzz <n>        max leading context lines droppable in fuzzy match (default: 3)
  --strict-sha      treat index-line SHA-1 mismatches as hard conflicts
  --out <file>      write reverse output to a file instead of stdout
  --json            machine-readable JSON output on stdout
  --help            show this help

Exit codes: 0 success, 1 patch could not be applied, 2 usage error.
`

interface Options {
  root: string
  dryRun: boolean
  noUndo: boolean
  undoFile: string | undefined
  fuzz: number
  strictSha: boolean
  json: boolean
  outFile: string | undefined
}

const BOOLEAN_FLAGS = new Set([
  '--dry-run', '--no-undo', '--strict-sha', '--json', '--help',
])
const VALUE_FLAGS = new Set(['--root', '--undo-file', '--out', '--fuzz'])

function parseArgs(argv: string[], cwd: string): { command: string | null; file: string | null; opts: Options; help: boolean } {
  const opts: Options = {
    root: cwd,
    dryRun: false,
    noUndo: false,
    undoFile: undefined,
    fuzz: 3,
    strictSha: false,
    json: false,
    outFile: undefined,
  }
  let command: string | null = null
  let file: string | null = null
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--help') {
      help = true
      continue
    }
    if (arg.startsWith('--')) {      const eq = arg.indexOf('=')
      const key = eq >= 0 ? arg.slice(0, eq) : arg
      let value: string | null = eq >= 0 ? arg.slice(eq + 1) : null
      if (BOOLEAN_FLAGS.has(key)) {
        if (eq >= 0) throw new UsageError(`flag ${key} does not take a value`)
        if (key === '--dry-run') opts.dryRun = true
        else if (key === '--no-undo') opts.noUndo = true
        else if (key === '--strict-sha') opts.strictSha = true
        else if (key === '--json') opts.json = true
        continue
      }
      if (VALUE_FLAGS.has(key)) {
        if (value === null) {
          value = argv[i + 1] ?? null
          if (value !== null && value.startsWith('--')) value = null
          else i++
        }
        if (value === null || value === '') throw new UsageError(`flag ${key} requires a value`)
        if (key === '--root') opts.root = value
        else if (key === '--undo-file') opts.undoFile = value
        else if (key === '--out') opts.outFile = value
        else if (key === '--fuzz') {
          const n = Number(value)
          if (!Number.isInteger(n) || n < 0) throw new UsageError(`--fuzz must be a non-negative integer (got ${value})`)
          opts.fuzz = n
        }
        continue
      }
      throw new UsageError(`unknown flag ${key}`)
    }
    if (command === null) command = arg
    else if (file === null) file = arg
    else throw new UsageError(`unexpected extra argument: ${arg}`)
  }
  return { command, file, opts, help }
}
class UsageError extends Error {}

/** Entry point returning a process exit code. */
export async function run(argv: string[], streams: CliStreams, env?: { cwd?: string }): Promise<number> {
  const cwd = env?.cwd ?? process.cwd()
  let parsed
  try {
    parsed = parseArgs(argv, cwd)
  } catch (error) {
    streams.err(`dsh-patch: ${(error as Error).message}\n\n${USAGE}`)
    return 2
  }
  const { command, file, opts, help } = parsed

  if (help || command === null || command === 'help') {
    streams.out(USAGE)
    return help ? 0 : command === null ? 2 : 0
  }

  try {
    switch (command) {
      case 'apply':
      case 'dry-run': {
        const patchText = await readFile(file, 'patch', cwd)
        const report = await applyPatchText(patchText, {
          root: opts.root,
          fuzzContext: opts.fuzz,
          dryRun: opts.dryRun || command === 'dry-run',
          undo: !opts.noUndo,
          undoFile: opts.undoFile,
          strictSha: opts.strictSha,
        })
        return emitReport(report, opts, streams)
      }
      case 'reverse': {
        const patchText = await readFile(file, 'patch', cwd)
        const report = await applyPatchText(patchText, {
          root: opts.root,
          fuzzContext: opts.fuzz,
          dryRun: true,
          undo: false,
          strictSha: opts.strictSha,
        })
        if (!report.ok) {
          if (opts.json) streams.out(JSON.stringify(report))
          else streams.err(summarizeReport(report))
          return 1
        }
        const text = report.reversePatch ?? ''
        if (opts.outFile !== undefined) {
          await fsp.mkdir(path.dirname(path.resolve(opts.outFile)), { recursive: true })
          await fsp.writeFile(opts.outFile, text, 'utf8')
        } else if (opts.json) {
          streams.out(JSON.stringify({ ok: true, patch: text }))
        } else {
          streams.out(text + (text.length > 0 && !text.endsWith('\n') ? '\n' : ''))
        }
        return 0
      }
      case 'stat': {
        const patchText = await readFile(file, 'patch', cwd)
        const stat = statPatch(parsePatch(patchText))
        if (opts.json) streams.out(JSON.stringify(stat, null, 2))
        else streams.out(formatStat(stat))
        return 0
      }
      case 'undo': {
        const journal = await readJournal(requireFile(file, 'journal'))
        const report = await applyUndo(journal, { root: journal.root, fuzzContext: opts.fuzz })
        return emitReport(report, opts, streams)
      }
      default:
        streams.err(`dsh-patch: unknown command ${command}\n\n${USAGE}`)
        return 2
    }
  } catch (error) {
    if (error instanceof PatchError) {
      if (opts.json) streams.out(JSON.stringify({ ok: false, errors: [{ code: error.code, path: '', message: error.message }] }))
      else streams.err(`dsh-patch: [${error.code}] ${error.message}`)
      return 1
    }
    if (error instanceof UsageError) {
      streams.err(`dsh-patch: ${error.message}\n\n${USAGE}`)
      return 2
    }
    streams.err(`dsh-patch: unexpected failure: ${(error as Error)?.stack ?? String(error)}`)
    return 1
  }
}

/** Non-null variant of `file`, throwing a usage error like readFile would. */
function requireFile(file: string | null, what: string): string {
  if (file === null) throw new UsageError(`${what} file argument is required`)
  return file
}

async function readFile(file: string | null, what: string, cwd: string): Promise<string> {
  if (file === null) throw new UsageError(`${what} file argument is required`)
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file)
  try {
    return await fsp.readFile(abs, 'utf8')
  } catch (error) {
    throw new PatchError(`cannot read ${what} file ${abs}: ${(error as Error).message}`, 'IO')
  }
}

function emitReport(report: ApplyReport, opts: Options, streams: CliStreams): number {
  if (opts.json) {
    streams.out(JSON.stringify(report, null, 2))
  } else if (report.ok) {
    streams.out(summarizeReport(report))
  } else {
    streams.err(summarizeReport(report))
  }
  return report.ok ? 0 : 1
}

/** Process-level entry used by bin/dsh-patch.js. */
export async function main(argv: string[]): Promise<number> {
  return run(argv, {
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
  })
}
