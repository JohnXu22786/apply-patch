/**
 * Filesystem adapters.
 *
 * `IoAdapter` is the only creature that touches a disk (or the harness
 * filesystem). The engine and the apply/orchestration layer work purely in
 * terms of adapter calls, so:
 *   - the core is unit-testable without a disk (dry-run never calls this),
 *   - the same patch can be applied through different backends,
 *   - stale-protection policy lives in one place.
 *
 * **Version-guard coordination with the official dsh filesystem.** The official
 * `@deepseek-ai/dsh-fs` backend derives its opaque `FsVersion` from stat
 * identity and freshness: `<dev>:<ino>:<size>:<mtimeNs>:<ctimeNs>` (see
 * `dsh-fs-local` `fsio.versionOf`). `NodeIoAdapter` reuses that exact recipe
 * for its {@link ProbeInfo.identity}, so a version token minted here means
 * the same thing as one minted by the harness. Every guarded write checks the
 * recorded identity immediately before publication (`STALE` when it drifts).
 * No runtime dependency on the harness is required for this; the seam is the
 * {@link IoAdapter} interface, so a deployment may substitute its own
 * `ctx.fs`-backed adapter (see {@link CtxFsIoAdapter}) without changing the
 * engine.
 * @module
 */

import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import {
  PatchBinaryError,
  PatchIoError,
  PatchStaleError,
  PatchValidationError,
} from './errors.ts'

/** Identity token for a target, minted the same way as the official dsh fs. */
export function identityFrom(st: {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
}

/** A stat-like snapshot of a target. */
export interface ProbeInfo {
  exists: boolean
  isFile: boolean
  isDirectory: boolean
  /** Raw byte size when stat could report it. */
  size: number | undefined
  /** Permissions bits (`mode & 0o777`), when the backend reports them. */
  mode: number | undefined
  /** Version identity token, or undefined for directories / absent paths. */
  identity: string | undefined
}

/** Guard a write: `absent` refuses to overwrite; `identity` rejects staleness. */
export type WriteGuard =
  | { kind: 'absent' }
  | { kind: 'identity'; identity: string }

/** Which verbs an adapter can perform (mirrors the official fs Service Definition gaps). */
export interface Capabilities {
  /** Can remove (delete) a file. */
  unlink: boolean
  /** Can change permissions. */
  chmod: boolean
  /** Can create intermediate directories. */
  mkdir: boolean
}

/** A resolved location inside a backend. */
export interface ResolvedTarget {
  /** Opaque key used for every subsequent adapter call. */
  key: string
  /** Human/UI-facing path for reports and journals. */
  display: string
}

/**
 * The filesystem contract the apply layer depends on. All paths are raw patch
 * paths (relative to {@link IoAdapter.root} or patch-absolute); each method
 * resolves internally so backends own their resolution semantics.
 */
export interface IoAdapter {
  readonly name: string
  readonly root: string
  readonly capabilities: Capabilities
  resolve(p: string): Promise<ResolvedTarget>
  probe(key: string): Promise<ProbeInfo>
  /** UTF-8 text or throws {@link PatchBinaryError}. */
  readText(key: string): Promise<string>
  /** Atomic write; `guard` enforces freshness/absence at publication time. */
  writeText(key: string, content: string, guard?: WriteGuard): Promise<void>
  remove(key: string): Promise<void>
  chmod(key: string, mode: number): Promise<void>
  mkdirp(key: string): Promise<void>
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === code
}

/** Options for the host-filesystem adapter. */
export interface NodeIoOptions {
  /** Absolute base directory; relative patch paths resolve against it. */
  root: string
  /** Permit patch paths that escape `root` (not recommended). */
  allowRootEscape?: boolean
  /** Skip the host rename, replacing target contents by direct write. */
  disableRename?: boolean
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * The default host-filesystem adapter: node:fs with atomic temp-file+rename
 * writes and the dsh-compatible version guard.
 */
export class NodeIoAdapter implements IoAdapter {
  readonly name = 'node'
  readonly root: string
  readonly capabilities: Capabilities = { unlink: true, chmod: true, mkdir: true }
  private readonly allowRootEscape: boolean
  private readonly disableRename: boolean

  constructor(options: NodeIoOptions) {
    const root = path.resolve(options.root)
    if (!path.isAbsolute(root)) throw new PatchValidationError(`root must be absolute: ${JSON.stringify(options.root)}`)
    this.root = root
    this.allowRootEscape = options.allowRootEscape ?? false
    this.disableRename = options.disableRename ?? false
  }

  /** Resolve a patch path to an absolute path, rejecting root escapes. */
  resolve(p: string): Promise<ResolvedTarget> {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.root, p)
    if (!this.allowRootEscape && !isInside(this.root, abs)) {
      throw new PatchValidationError(`patch path escapes the root (${this.root}): ${p}`)
    }
    return Promise.resolve({ key: abs, display: abs })
  }

  async probe(key: string): Promise<ProbeInfo> {
    try {
      const st = await fsp.stat(key, { bigint: true })
      if (st.isDirectory()) {
        return { exists: true, isFile: false, isDirectory: true, size: undefined, mode: undefined, identity: undefined }
      }
      return {
        exists: true,
        isFile: st.isFile(),
        isDirectory: false,
        size: Number(st.size),
        mode: Number(st.mode & 0o777n),
        identity: identityFrom(st),
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
        return { exists: false, isFile: false, isDirectory: false, size: undefined, mode: undefined, identity: undefined }
      }
      throw new PatchIoError(`stat failed: ${(error as Error).message}`, 'stat', key, { cause: error })
    }
  }

  async readText(key: string): Promise<string> {
    let buf: Buffer
    try {
      buf = await fsp.readFile(key)
    } catch (error) {
      throw new PatchIoError(`read failed: ${(error as Error).message}`, 'read', key, { cause: error })
    }
    if (buf.includes(0)) throw new PatchBinaryError(`file is binary (contains NUL bytes): ${key}`)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      throw new PatchBinaryError(`file is not valid UTF-8 text: ${key}`)
    }
  }

  async writeText(key: string, content: string, guard?: WriteGuard): Promise<void> {
    if (guard !== undefined) {
      const probe = await this.probe(key)
      if (guard.kind === 'absent') {
        if (probe.exists) {
          throw new PatchValidationError(`cannot create ${key}: file already exists`)
        }
      } else {
        if (!probe.exists || probe.identity !== guard.identity || !probe.isFile) {
          throw new PatchStaleError(
            `refusing to write ${key}: file changed since it was read (expected identity ${guard.identity})`,
          )
        }
      }
    }
    const dir = path.dirname(key)
    await this.mkdirp(dir)
    const tmp = path.join(dir, `.${path.basename(key)}.${process.pid}.${randomSuffix()}.tmp`)
    try {
      await fsp.writeFile(tmp, content, 'utf8')
      if (this.disableRename) {
        // Replace contents where rename-over is not possible (rare hosts).
        await fsp.rm(key, { force: true })
        await fsp.writeFile(key, content, 'utf8')
        await fsp.rm(tmp, { force: true })
      } else {
        await fsp.rename(tmp, key)
      }
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw new PatchIoError(`write failed: ${(error as Error).message}`, 'write', key, { cause: error })
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await fsp.unlink(key)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return
      throw new PatchIoError(`unlink failed: ${(error as Error).message}`, 'unlink', key, { cause: error })
    }
  }

  async chmod(key: string, mode: number): Promise<void> {
    try {
      await fsp.chmod(key, mode)
    } catch (error) {
      throw new PatchIoError(`chmod failed: ${(error as Error).message}`, 'chmod', key, { cause: error })
    }
  }

  async mkdirp(key: string): Promise<void> {
    try {
      await fsp.mkdir(key, { recursive: true })
    } catch (error) {
      throw new PatchIoError(`mkdir failed: ${(error as Error).message}`, 'mkdir', key, { cause: error })
    }
  }
}

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

/**
 * Structural shape of the harness `ctx.fs` Service used by {@link CtxFsIoAdapter}.
 * Only the verbs needed are declared; the runtime object from the harness
 * satisfies it structurally without any import (zero runtime dependency).
 */
export interface CtxFsLike {
  resolve(
    p: string,
    opts?: { cwd?: string },
  ): Promise<{ targetKey: string; displayPath: string }>
  stat(target: { targetKey: string }): Promise<{ version: string; type: string; size?: number } | undefined>
  readText(target: { targetKey: string }, signal?: AbortSignal): Promise<string>
  writeText(
    target: { targetKey: string },
    content: string,
    intent?: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string },
  ): Promise<{ version: string }>
}

/**
 * Harness `ctx.fs`-backed adapter. Exactly the verb set the official Service
 * Definition supports is implemented: resolve/stat/read/write, with guarded
 * writes mapped onto the harness's `createIfAbsent` / `replaceIfVersion`
 * intents — the version guard is exercised through the backend itself rather
 * than re-implemented. The Service Definition exposes no unlink/rename/chmod/
 * mkdir verbs, so those are declared unsupported and the apply layer fails
 * such operations with a precise `UNSUPPORTED` error *before* any mutation.
 *
 * This is the documented "do not force coupling" seam: the plugin runs and is
 * fully tested on {@link NodeIoAdapter}; deployments that want mutations to
 * flow through a confining or remote harness filesystem mount this adapter
 * instead via config `io: ctx-fs`.
 */
export class CtxFsIoAdapter implements IoAdapter {
  readonly name = 'ctx-fs'
  readonly root: string
  readonly capabilities: Capabilities = { unlink: false, chmod: false, mkdir: false }
  private readonly fs: CtxFsLike
  private readonly allowRootEscape: boolean

  constructor(options: { root: string; fs: CtxFsLike; allowRootEscape?: boolean }) {
    this.fs = options.fs
    this.allowRootEscape = options.allowRootEscape ?? false
    this.root = path.resolve(options.root)
  }

  resolve(p: string): Promise<ResolvedTarget> {
    if (!this.allowRootEscape && path.isAbsolute(p) && !isInside(this.root, path.resolve(p))) {
      throw new PatchValidationError(`patch path escapes the root (${this.root}): ${p}`)
    }
    return this.fs.resolve(p).then(
      (target) => ({ key: target.targetKey, display: target.displayPath }),
    )
  }

  async probe(key: string): Promise<ProbeInfo> {
    let info
    try {
      info = await this.fs.stat({ targetKey: key })
    } catch (error) {
      throw new PatchIoError(`stat failed: ${(error as Error).message}`, 'stat', key, { cause: error })
    }
    if (info === undefined) {
      return { exists: false, isFile: false, isDirectory: false, size: undefined, mode: undefined, identity: undefined }
    }
    return {
      exists: true,
      isFile: info.type === 'file',
      isDirectory: info.type === 'directory',
      size: info.size,
      mode: undefined,
      identity: info.version,
    }
  }

  async readText(key: string): Promise<string> {
    try {
      return await this.fs.readText({ targetKey: key })
    } catch (error) {
      throw new PatchIoError(`read failed: ${(error as Error).message}`, 'read', key, { cause: error })
    }
  }

  async writeText(key: string, content: string, guard?: WriteGuard): Promise<void> {
    let intent: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string } | undefined
    if (guard !== undefined) {
      intent = guard.kind === 'absent'
        ? { kind: 'createIfAbsent' }
        : { kind: 'replaceIfVersion', version: guard.identity }
    }
    try {
      await this.fs.writeText({ targetKey: key }, content, intent)
    } catch (error) {
      throw new PatchIoError(`write failed: ${(error as Error).message}`, 'write', key, { cause: error })
    }
  }

  async remove(_key: string): Promise<void> {
    throw new PatchIoError(
      'the harness ctx.fs Service Definition has no unlink verb; delete operations are unavailable in ctx-fs mode',
      'unlink',
      _key,
    )
  }

  async chmod(_key: string, _mode: number): Promise<void> {
    throw new PatchIoError(
      'the harness ctx.fs Service Definition has no chmod verb; mode changes are unavailable in ctx-fs mode',
      'chmod',
      _key,
    )
  }

  async mkdirp(_key: string): Promise<void> {
    // Backend-owned; intermediate directories must already exist in ctx-fs mode.
  }
}
