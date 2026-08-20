/**
 * Synchronous fixture reading for parse tests.
 * @module
 */

import { readFileSync } from 'node:fs'

/** Read a fixture patch as a string (synchronous; parse tests are pure). */
export function patchFixtureText(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8')
}
