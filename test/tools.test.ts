/**
 * Bundle-contract tests: `apply()` registers the four tools, their parameter
 * and output schemas are well-formed, and every tool's actual emitted JSON
 * matches its declared output schema exactly (keys + nullability) — the drift
 * the harness registry would otherwise reject.
 * @module
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../src/index.ts'
import type { ToolDefinition, ToolContext } from '../src/tools.ts'
import type { ApplyReport } from '../src/apply.ts'
import { parsePatch } from '../src/parse.ts'
import { statPatch } from '../src/stat.ts'
import * as help from './helpers.ts'

/** Minimal fake context that records registrations like the harness registry. */
function fakeContext(): { ctx: ToolContext; defs: ToolDefinition[] } {
  const defs: ToolDefinition[] = []
  const ctx: ToolContext = {
    tools: {
      register: (def: ToolDefinition) => {
        defs.push(def)
        return () => {}
      },
    },
    get: () => undefined,
  }
  return { ctx, defs }
}

/** Validate a value against a closed `additionalProperties:false` schema. */
function assertMatchesSchema(value: Record<string, unknown>, schema: { properties?: Record<string, object>; required?: boolean }): void {
  const props = schema.properties ?? {}
  const keys = Object.keys(value).sort()
  const expected = Object.keys(props).sort()
  assert.deepEqual(keys, expected, `emitted keys ${JSON.stringify(keys)} do not match schema ${JSON.stringify(expected)}`)
  for (const [key, node] of Object.entries(props)) {
    const n = node as {
      required?: boolean
      type?: string | string[]
      oneOf?: Array<{ type: string | string[] }>
    }
    if (n.required === true && !(key in value)) {
      assert.fail(`required schema property ${key} missing from value`)
    }
    const v = value[key]
    const matchesType = (t: string | string[]): boolean => {
      if (t === 'null') return v === null
      if (Array.isArray(t)) return t.some((x) => matchesType(x))
      return Array.isArray(v) || typeof v === t
    }
    if (n.oneOf !== undefined) {
      assert.ok(
        n.oneOf.some((o) => matchesType(o.type)),
        `property ${key}: no oneOf arm matched ${JSON.stringify(v)}`,
      )
    } else if (n.type !== undefined) {
      assert.ok(matchesType(n.type), `property ${key}: expected type ${JSON.stringify(n.type)}, got ${JSON.stringify(v)}`)
    }
  }
}

test('apply() registers exactly the four patch tools with the required parameter', () => {
  const { ctx, defs } = fakeContext()
  apply(ctx, { defaultRoot: process.cwd() })
  assert.deepEqual(defs.map((d) => d.name).sort(), ['patch_apply', 'patch_dry_run', 'patch_reverse', 'patch_stat'])
  for (const def of defs) {
    assert.equal(typeof def.execute, 'function')
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.presentCall, 'function')
    assert.equal(typeof def.description, 'string')
  }
  for (const name of ['patch_apply', 'patch_dry_run', 'patch_reverse']) {
    const def = defs.find((d) => d.name === name)!
    const param = def.parameters.patch as { required?: boolean; type?: string }
    assert.equal(param.required, true)
    assert.equal(param.type, 'string')
  }
})

test('patch_apply emits JSON matching its closed output schema (success and dry-run null states)', async () => {
  const wsOk = await help.setupBasicWorkspace()
  const wsDry = await help.setupBasicWorkspace()
  try {
    const patchText = await help.fixture('basic-multi.patch')
    const { ctx, defs } = fakeContext()
    apply(ctx, {})
    const applyDef = defs.find((d) => d.name === 'patch_apply')!

    // Success path: apply for real into a fresh workspace.
    const ok = await applyDef.execute({ patch: patchText, cwd: wsOk.dir }, { signal: new AbortController().signal })
    const report = ok as unknown as ApplyReport
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assertMatchesSchema(ok as Record<string, unknown>, applyDef.output.schema as never)

    // Dry-run path against a fresh workspace: null undoFile + non-null reversePatch.
    const dryDef = defs.find((d) => d.name === 'patch_dry_run')!
    const dry = await dryDef.execute({ patch: patchText, cwd: wsDry.dir }, { signal: new AbortController().signal })
    assert.equal((dry as unknown as ApplyReport).ok, true, JSON.stringify((dry as unknown as ApplyReport).errors))
    assertMatchesSchema(dry as Record<string, unknown>, dryDef.output.schema as never)

    // Conflict path: corrupt a target so the hunk fails; fields still fit the schema.
    await help.write(wsDry.dir, 'hello.txt', 'not\nmatching\n')
    const bad = await applyDef.execute({ patch: patchText, cwd: wsDry.dir }, { signal: new AbortController().signal })
    assert.equal((bad as unknown as ApplyReport).ok, false)
    assertMatchesSchema(bad as Record<string, unknown>, applyDef.output.schema as never)
  } finally {
    await wsOk.cleanup()
    await wsDry.cleanup()
  }
})

test('patch_reverse output schema matches both the success and the failure shapes', async () => {
  const { dir, cleanup } = await help.makeTempDir()
  try {
    await help.write(dir, 'f.txt', 'a\nb\n')
    const patchText = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
    ].join('\n') + '\n'
    const { ctx, defs } = fakeContext()
    apply(ctx, {})
    const def = defs.find((d) => d.name === 'patch_reverse')!

    const ok = await def.execute({ patch: patchText, cwd: dir }, { signal: new AbortController().signal })
    assert.equal((ok as { ok: boolean }).ok, true)
    assertMatchesSchema(ok as Record<string, unknown>, def.output.schema as never)

    // Failure: patch does not match its target → patch is null, still in schema.
    await help.write(dir, 'f.txt', 'zzz\n')
    const bad = await def.execute({ patch: patchText, cwd: dir }, { signal: new AbortController().signal })
    assert.equal((bad as { ok: boolean }).ok, false)
    assertMatchesSchema(bad as Record<string, unknown>, def.output.schema as never)
  } finally {
    await cleanup()
  }
})

test('patch_stat output schema matches a parsed patch stat', async () => {
  const patchText = await help.fixture('basic-multi.patch')
  const { ctx, defs } = fakeContext()
  apply(ctx, {})
  const def = defs.find((d) => d.name === 'patch_stat')!
  const value = await def.execute({ patch: patchText }, { signal: new AbortController().signal })
  const expected = statPatch(parsePatch(patchText))
  assert.deepEqual(value, expected as unknown as Record<string, unknown>)
  assertMatchesSchema(value as Record<string, unknown>, def.output.schema as never)
})

test('presentCall returns serializable, schema-free cards', () => {
  const { ctx, defs } = fakeContext()
  apply(ctx, {})
  for (const def of defs) {
    const card = def.presentCall!({ patch: 'irrelevant' })
    assert.equal(typeof card.card, 'string')
    assert.equal(typeof card.title, 'string')
    assert.equal(typeof card.kind, 'string')
    JSON.stringify(card) // must not throw
  }
})

test('io: ctx-fs config without a mounted fs service fails loudly on execute', async () => {
  const { ctx, defs } = fakeContext()
  ctx.get = () => undefined // no fs service mounted
  apply(ctx, { io: 'ctx-fs' })
  const def = defs.find((d) => d.name === 'patch_apply')!
  // The adapter is built per call, so the missing service surfaces at execute.
  await assert.rejects(
    def.execute({ patch: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n', cwd: process.cwd() }, { signal: new AbortController().signal }),
    /no fs service is mounted/,
  )
})
