# dsh-patch-apply

**在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）以及任何 Node 运行时中，将结构化 unified diff（git 格式）应用到真实文件系统。**

dsh 官方只提供字符串级的 `edit`/`write` 工具，没有任何**会落盘**的结构化 diff 应用工具。`dsh-patch-apply` 填补了这一空白：它解析 unified diff，逐 hunk 应用（含模糊匹配与行号偏移修正），让整个过程**要么全成功、要么全回滚**，并在应用前生成**反向补丁**以实现字节级精确回滚（undo）。

零运行时依赖。TypeScript 源码、纯对象工具定义、使用 Node 内置测试运行器。

---

## 特性一览

- **完整的 `git diff` 覆盖** —— 多文件、多 hunk、`±`/上下文/新增/删除、`/dev/null` 新建与删除、`rename from/to`、`copy from/to`、`old mode`/`new mode`、`index` SHA、`\ No newline at end of file`、二进制标记（`Binary files … differ`、`GIT binary patch`）、带空格引号路径。同时支持经典的无 git 头的裸 `---`/`+++` 补丁。
- **自研解析器** —— 无重型依赖；解析器会把 hunk 头与实际行数严格校验，遇到格式错误立即给出精确的补丁行号。
- **精确的 hunk 定位** —— 锚点精确匹配 → 全文精确匹配（行号偏移修正）→ 模糊匹配（前导上下文容错，GNU patch 风格）。**删除行永远不会被模糊丢弃**，因此模糊匹配绝不会误删内容。
- **全有或全无的原子性** —— 任何写入发生之前，所有文件都在内存中完成解析与校验；一旦存在 hunk 冲突或结构性违规，**什么都不写**。
- **版本守卫** —— 复用与官方 dsh 文件系统**完全相同的身份配方**（`dev:ino:size:mtimeNs:ctimeNs`，见「与官方 dsh fs 的版本守卫协同」）；每次写入在发布前会重新校验身份，一旦漂移即报 `STALE` 并中止。
- **随处可撤销** —— 在变更前计算反向补丁，并先写入 undo 日志；`undo` 可以字节级还原。同样覆盖新建、删除、重命名、复制与权限变更。
- **dry-run 模式** —— 静态校验可应用性；逐 hunk 报告冲突（`期望/实际内容`、hunk 序号、补丁行号），不改文件。
- **CRLF / LF 保真** —— 文件按<行, 各自行终止符>建模；未被触动的区域逐字节原样往返，包括混合换行与文件末尾无换行的情况。
- **二进制安全** —— 二进制标记的文件会被跳过并报告；指向二进制目标的文本补丁会被识别（NUL 字节 / 非法 UTF-8）并跳过，绝不会破坏数据。

---

## 安装

### 作为 dsh bundle（推荐）

本包是标准 dsh bundle：`package.json` 声明
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，补丁会插入一行 Cordis
插件项，其模块导出 `{ name, inject, apply }`，并在工具注册表（`ctx.tools`）
上注册四个工具。

```sh
# 已发布到 registry
dsh plugin --profile <name> add dsh-patch-apply

# 或使用本地检出目录
dsh plugin --profile <name> add /path/to/apply-patch
```

无需其他配置——`patch_apply`、`patch_dry_run`、`patch_reverse`、`patch_stat`
立即可供模型调用。

可选插件配置（在 profile 中针对 `patch-apply` 行的后续补丁层，或直接写在该行的 `config` 中）：

```yaml
- config:
    id: patch-apply
    defaultRoot: /abs/path/to/workspace   # 相对补丁路径的基准目录（默认：process.cwd()）
    io: node                              # node | ctx-fs（见下文）
    fuzzContext: 3                        # 模糊匹配最多可丢弃的前导上下文行数
    undo: true                            # patch_apply 是否持久化 undo 日志
    strictSha: false                      # 是否把 index 行 SHA-1 不匹配视为硬冲突
```

### 作为独立 CLI

```sh
npm install dsh-patch-apply          # 或从本地检出目录 link
npx dsh-patch --help
```

### 作为库

```sh
npm install dsh-patch-apply
```

```ts
import { applyPatchText, applyUndo, parsePatch, statPatch } from 'dsh-patch-apply'
```

---

## 使用

### 1. dsh 工具

| 工具 | 用途 |
|---|---|
| `patch_apply` | 应用 unified diff，全有或全无，带 undo 日志。 |
| `patch_dry_run` | 校验可应用性；报告所有冲突；不写任何东西。 |
| `patch_reverse` | 只生成反向补丁（先校验），不应用。 |
| `patch_stat` | 汇总补丁（文件、hunk、+/−/上下文行数），不访问文件系统。 |

公共参数：

- `patch` *(string，必填)* —— unified diff 文本。
- `cwd` *(string，可选)* —— 相对路径的基准目录（默认：`config.defaultRoot`）。
- `dry_run` / `verify_sha` *(boolean，可选)* —— dry-run 模式 / 硬性 SHA-1 校验。

`patch_apply` 返回：

```jsonc
{
  "ok": true,
  "dryRun": false,
  "files": [{ "path": "...", "operation": "modify", "hunks": [{ "hunkNumber": 1, "status": "offset", "atLine": 12 }] }],
  "conflicts": [],            // [{ file, hunkNumber, sourceLine, reason, expected[], actual[], anchorLine }]
  "errors": [],               // [{ code, path, message }]
  "notes": [],                // 信息性说明，例如 SHA-1 预检不匹配
  "reversePatch": "diff --git ...",
  "undoFile": "/abs/.dsh-patch-undo.json"
}
```

`files` 会列出每个已准备的文件操作及其逐 hunk 状态——成功时是*已应用*的结果，
dry-run 时则是*将要应用*的结果。「全有或全无」的含义：只要 `ok` 为 `false`
（`conflicts`/`errors` 任一非空），就保证什么都没写入；成功时则每个文件的每个
hunk 都已定位并提交。

### 2. CLI

```
dsh-patch <command> [options] <file>

Commands
  apply   <patch>    应用 unified diff（默认写入 undo 日志）
  dry-run <patch>    校验可应用性；报告冲突；绝不写入
  reverse <patch>    打印反向补丁（或用 --out 写入文件）
  stat    <patch>    汇总补丁，不访问文件系统
  undo    <journal>  应用 undo 日志中记录的反向补丁
  help               显示帮助

Options
  --root <dir>      相对补丁路径的基准目录（默认：cwd）
  --dry-run         apply 命令等同 dry-run 行为
  --no-undo         不写入 undo 日志
  --undo-file <p>   apply 的 undo 日志路径（默认：<root>/.dsh-patch-undo.json）
  --fuzz <n>        模糊匹配最多可丢弃的前导上下文行数（默认：3）
  --strict-sha      把 index 行 SHA-1 不匹配视为硬冲突
  --out <file>      反向输出写入文件而非 stdout
  --json            在 stdout 输出机器可读 JSON
  --help            显示帮助
```

退出码：`0` 成功 · `1` 补丁无法应用 · `2` 用法错误。

```sh
dsh-patch apply changes.patch --root /workspace
dsh-patch dry-run changes.patch
dsh-patch reverse changes.patch > revert.patch
dsh-patch undo .dsh-patch-undo.json
```

### 3. 库

```ts
import { applyPatchText } from 'dsh-patch-apply'

const report = await applyPatchText(patchText, {
  root: process.cwd(),          // 相对路径的绝对基准目录
  fuzzContext: 3,               // 模糊容错
  dryRun: false,                // 是否只校验
  undo: true,                   // 是否写入 undo 日志
  undoFile: '.dsh-patch-undo.json',
  strictSha: false,             // index SHA-1 不匹配是否视为硬冲突
})
```

其他导出：`parsePatch`、`statPatch`、`applyUndo(journal)`、
`readJournal` / `writeJournal`、`blobSha`、文件系统接缝
`IoAdapter`/`NodeIoAdapter`/`CtxFsIoAdapter`，以及各类带类型的错误类。

---

## 错误码

| 代码 | 含义 |
|---|---|
| `PARSE` | diff 格式错误；消息内包含补丁行号。 |
| `CONFLICT` | hunk 无法安全定位；携带 hunk 附近的 `期望/实际` 内容。 |
| `VALIDATION` | 应用前的结构性问题（覆盖已存在文件、目标缺失、路径越界）。 |
| `STALE` | 校验与提交之间文件身份发生变化（版本守卫被触发）。 |
| `IO` | 文件系统操作失败（写/chmod/unlink/…）。 |
| `BINARY` | 二进制目标 / 二进制标记——跳过，绝不破坏。 |
| `UNSUPPORTED` | 超出解析范围（如合并 `diff --cc`）或后端能力不足的动词。 |

---

## 工作原理

### 解析器（`parse.ts`）

一个状态机理解 git diff 的每个块以及经典的无头 `---`/`+++` 形式。每个 `@@`
头都会在实际消费其正文行时核对行数——欠供或超供的 hunk 会立刻抛出带补丁行号的
`PARSE` 错误，因此被截断或损坏的补丁绝不会悄然误应用。

### hunk 定位（`locate.ts`、`engine.ts`）

对每个文件，按顺序对当前内存缓冲逐 hunk 应用：

1. **exact** —— 旧侧块在锚点（头行号减一，并按此前 hunk 的净增量平移）处匹配；
2. **offset** —— 完整旧侧块在别处精确匹配；取离锚点最近者（修正行号漂移）；
3. **fuzzy** —— 允许丢弃最多 `fuzzContext` 行**前导上下文**来寻找螺栓。只有
   **上下文**行可被丢弃（删除行必须精确匹配），且旧、新两侧丢弃同一前缀，
   因此模糊匹配绝不会误删内容，也不会重复插入被模糊掉的上下文行。

若不存在安全位置，该 hunk 会作为冲突上报：包含 1 起始的 hunk 序号、补丁行号、
以及期望/实际内容的短摘录——整个补丁随即被拒绝，磁盘不被触碰。

### 原子性与回滚（`apply.ts`、`io.ts`）

- 所有文件在**内存中**首先完成解析、读取与转换。任何冲突或结构性问题 ⇒
  什么都不写。
- 反向补丁与（启用时的）undo 日志会在第一次变更**之前**写入，因此即使
  提交中途崩溃，也始终存在完整的还原路径。
- 内容写入**逐文件原子**（临时文件 + rename），按需创建父目录；随后做权限
  变更；最后做删除 / 重命名源清理（先确保目标完整写好后，源才消失）。
- 若提交中途任何一次写入/chmod/unlink 失败，会把已变更的每个文件从内存中的
  原始内容恢复（尽力而为）并上报错误。跨多个 rename 无法用单次文件系统调用
  实现物理原子性；提交前的校验才是把保证变为结构性的关键。

### 与官方 dsh fs 的版本守卫协同

官方 `@deepseek-ai/dsh-fs` 后端用 stat 身份与新鲜度派生出不透明的 `FsVersion`：
`dev:ino:size:mtimeNs:ctimeNs`。本包在 `NodeIoAdapter.probe().identity` 中复刻了
完全相同的配方，因此这里产生的版本令牌与 Harness 产生的是同一含义。每次受守卫
写入前会在发布时重新探测身份，一旦漂移即以 `STALE` 中止并回滚——与官方
`writeText(…, { kind: 'replaceIfVersion' })` 的过期保护契约一致。

两点配置说明（刻意保持解耦）：

- **默认 `io: node`** —— 通过 `NodeIoAdapter` 直接访问主机。CLI 与整个测试套件
  均在此模式下运行。
- **`io: ctx-fs`** —— 解析/stat/读取/写入经由已挂载的 Harness `ctx.fs` 服务
  （`CtxFsIoAdapter`），把受守卫的写入映射到后端自己的 `createIfAbsent` /
  `replaceIfVersion` 意图上，即版本守卫由后端自己执行。由于官方 Service
  Definition **没有 unlink/rename/chmod/mkdir 动词**，需要这些操作的补丁会在
  **任何变更之前**以精确的 `UNSUPPORTED` 报错，而不是做一些出人意料的事。
  需要完整覆盖删除 / 重命名 / 权限变更时，请使用 `io: node`。

### 行尾符

文件被表示为 `{ text, sep }` 行列表，`sep` 是该行自身的逐字终止符（`\r\n`、
`\n`，或末尾无换行时的 `''`）。补丁行仅按文本匹配，因此 CRLF 与 LF 文件都能
干净应用；补丁插入的新行继承文件的主导换行；`\ No newline at end of file`
标记（旧、新两侧独立）会把文件末尾无换行的状态正确传递下去。

---

## 开发

```sh
npm install
npm test          # 先 tsc 构建，再 node --test 运行 build/test/*.test.js
npm run build     # tsc -> build/
npm run typecheck # tsc --noEmit
```

测试布局：`parse`（格式覆盖 + 畸形输入定位精度）、`apply`（单/多文件、CRLF、
新建/删除/重命名/复制/权限、二进制、dry-run 纯净性、undo 往返）、`fuzzy`
（偏移 / 模糊 / 拒绝路径、SHA-1）、`conflict`（报告精度）、`rollback`
（全有或全无、注入 I/O 失败后的物理回滚、`STALE` 守卫）、`cli`（退出码、
JSON、reverse/undo 流程）。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。© 2026 dsh-patch-apply contributors。
