/**
 * Line splitting / joining with line-ending preservation.
 *
 * A file is modelled as `FileLine[]` where each element carries its own
 * terminator. Untouched regions therefore round-trip byte-for-byte, including
 * mixed LF/CRLF files and a missing trailing newline on the final line.
 * @module
 */

import type { FileLine, LineEnding, LineSep } from './types.ts'

export const LF = '\n' as const
export const CRLF = '\r\n' as const

export interface SplitResult {
  lines: FileLine[]
  /** The dominant line ending, used when inserting new patch lines. */
  eol: LineEnding
}

/** Split a file string into lines, remembering each line's literal terminator. */
export function splitLines(content: string): SplitResult {
  if (content === '') return { lines: [], eol: LF }
  const lines: FileLine[] = []
  const re = /\r\n|\n/g
  let lastIndex = 0
  let crlf = 0
  let lf = 0
  let firstEol: LineEnding | undefined
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    const text = content.slice(lastIndex, match.index)
    const sep = match[0] as LineSep
    if (sep === CRLF) crlf++
    else lf++
    if (firstEol === undefined) firstEol = sep === CRLF ? CRLF : LF
    lines.push({ text, sep })
    lastIndex = match.index + sep.length
  }
  if (lastIndex < content.length) {
    lines.push({ text: content.slice(lastIndex), sep: '' })
  }
  const eol: LineEnding = crlf > lf ? CRLF : firstEol ?? LF
  return { lines, eol }
}

/** Join lines back into a file string (byte-exact when untouched). */
export function joinLines(lines: readonly FileLine[]): string {
  let out = ''
  for (const line of lines) out += line.text + line.sep
  return out
}
