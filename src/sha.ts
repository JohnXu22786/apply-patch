/**
 * Content-addressed checksums (node:crypto only).
 * `blobSha` reproduces a git blob object hash, so the `index` lines of a
 * generated patch can be cross-checked against actual content — optional
 * pre-flight validation, never load-bearing for application.
 * @module
 */

import { createHash } from 'node:crypto'

/** Compute the git blob SHA-1 of a UTF-8 string. */
export function blobSha(content: string): string {
  const bytes = Buffer.byteLength(content, 'utf8')
  return createHash('sha1').update(`blob ${bytes}\0`).update(content, 'utf8').digest('hex')
}
