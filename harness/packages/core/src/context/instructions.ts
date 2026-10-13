/**
 * 项目指令文件（AGENTS.md 家族）加载 —— 「项目自己的规矩」这一层。
 *
 * 为什么要有：Dove 原先完全没有项目指令支持 —— 用户在仓库里放一份 AGENTS.md，模型看不见，
 * 于是每个新会话都要重新交代一遍同样的规矩（构建命令、目录禁忌、代码风格、别动哪块）。
 * 发现顺序取三家的交集（Claude Code 的层级 + Codex 的从根到 cwd 逐层拼接 + Kimi 的来源锚点）：
 *   ① <configDir>/AGENTS.md        品牌 home：跨项目的机器级规矩
 *   ② ~/.agents/AGENTS.md          跨工具的用户级约定（Claude Code / Codex / Kimi 都读这一份）
 *   ③ 仓库根 → 工作目录 逐层目录    每层先 .kimi-code/AGENTS.md，再 AGENTS.md / agents.md
 *
 * 四条纪律（都是踩过的坑，改动前先读）：
 *   - **根在前、叶在后**：越靠近工作目录的指令在正文里越靠后。前缀缓存要求顺序完全固定，
 *     而「就近的具体规矩压过上面的泛泛而谈」也是人的直觉 —— 两者在这个顺序上是一致的。
 *   - **每层只取第一个命中的文件**：AGENTS.md / agents.md 两个名字是给大小写敏感的文件系统兜底的，
 *     不是同一层要读两份（macOS 默认大小写不敏感，两个名字指同一个文件）。
 *   - **同一个文件只出现一次**：先写先得，按**真身路径**（realpath）去重 ——
 *     光比字符串不够：macOS / Windows 的卷默认大小写不敏感，AGENTS.md 与 agents.md 是同一个文件，
 *     而「configDir 就是仓库根」这种重叠又很常见。重复注入会让模型以为规矩写了两遍。
 *   - **绝不抛错**：不存在 / 空文件 / 是目录 / 权限不够 / 符号链接打转 —— 一律静默跳过。
 *     一个坏文件不该让整轮对话失败，也不该把用户看不懂的 errno 端到他面前。
 *
 * 不管「受信 / 不受信项目」：Codex 会对不受信项目整个跳过，但 Dove 是活在用户自己电脑上的搭档，
 * 项目指令是他自己（或他信任的仓库）放的 —— 跳过反而让规矩时灵时不灵。安全边界交给 SECURITY 段。
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { AGENTS_MD_ANCHOR, AGENTS_MD_MAX_BYTES, AGENTS_MD_PLAIN_NAMES } from "../constants.ts";

/**
 * 候选指令文件的**廉价指纹**：只记 stat 出来的 (mtimeMs, size)，不读正文。
 * 用途是「磁盘变了吗」的快速判定（缓存侧见 agent/assemble-adapter.ts）。
 * 两个字段合起来够用：编辑内容 → mtime 变（同一毫秒内连改两次还有 size 兜底）；
 * 新增 / 删除文件 → 列表本身长短变。
 * 已知边界：刻意把 mtime 改回原值、又把长度控制回原尺寸的改写会被漏掉 ——
 * 那是「故意骗指纹」，防它要每轮读全部正文，正是这套设计要避免的开销。
 */
export interface InstructionsFingerprint {
  /** path 是候选绝对路径（不解析符号链接：这里只求逐次稳定，realpath 每次还要多打 syscall） */
  files: { path: string; mtimeMs: number; size: number }[];
}

export interface ProjectInstructionsResult {
  /** 拼好的指令正文（每段前面带 AGENTS_MD_ANCHOR 锚点，段间空行分隔）；没有则空串 */
  text: string;
  /** 实际读进来的文件绝对路径（realpath 真身，与锚点里的路径同一个口径），按拼接顺序 */
  paths: string[];
  /** 总字节数超 AGENTS_MD_MAX_BYTES 时给出的人类可读告警（**不截断**），否则 undefined */
  warning?: string;
  /** 本次发现时采到的候选指纹快照（装配层拿它判定「磁盘变了吗」；空结果也带，否则空指令会被每轮重读） */
  fingerprint?: InstructionsFingerprint;
}

/** 品牌 home 只认这一个名字（照 Claude Code 的 user 级单文件，那一层不做大小写兜底） */
const CONFIG_NAMES: readonly string[] = [AGENTS_MD_PLAIN_NAMES[0] ?? "AGENTS.md"];
/** 逐层目录的候选顺序：先 .kimi-code/AGENTS.md（同一个目录里塞多份规矩的场景），再目录自己的 */
const LAYER_NAMES: readonly string[] = [join(".kimi-code", "AGENTS.md"), ...AGENTS_MD_PLAIN_NAMES];

/**
 * 锚点行：整行恰好是 `<!-- From: <path> -->`（前后可以有空白）。
 * 必须独占一行 —— 正文里恰好提到「From: xxx」的句子不算来源声明，否则反查会误命中。
 */
const ANCHOR_LINE = /^<!--\s*From:\s*(.+?)\s*-->$/;

/** 判断某段文本是否含锚点（无关文件不要误命中） */
export function hasInstructionAnchor(text: string): boolean {
  for (const line of text.split("\n")) if (ANCHOR_LINE.test(line.trim())) return true;
  return false;
}

/** 从正文里把 AGENTS_MD_ANCHOR 写的来源路径反查出来（用于「这条规则来自哪个文件」） */
export function extractInstructionPaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const path = ANCHOR_LINE.exec(line.trim())?.[1];
    // 去重：与 paths 的语义对齐（同一个来源只报一次，「重复出现 = 写了两份」是另一回事）
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 仓库根 = 从工作目录向上最近一个含 .git 的目录；一路到根都没有就用工作目录自己 */
async function findRepoRoot(workdir: string): Promise<string> {
  for (let dir = workdir; ; ) {
    // .git 可能是目录（普通仓库）也可能是文件（worktree / submodule），stat 两种都认
    if (await exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return workdir;
    dir = parent;
  }
}

/** 仓库根 → 工作目录的目录链，根在前；工作目录自己是最后一层 */
function dirsFromRoot(root: string, workdir: string): string[] {
  const rel = relative(root, workdir);
  if (rel === "") return [root];
  // 理论上 root 一定是 workdir 的祖先（它是从 workdir 往上找出来的）；
  // 这里只防大小写 / 挂载点之类的怪情况，坏了就退化成只读工作目录，绝不越界去读别的树。
  if (rel.startsWith("..") || isAbsolute(rel)) return [workdir];
  const dirs = [root];
  let cur = root;
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    dirs.push(cur);
  }
  return dirs;
}

/**
 * 候选文件全集，**与发现顺序同一口径**（复用同一份 CONFIG_NAMES / LAYER_NAMES / dirsFromRoot）。
 * 只拼路径不看内容（findRepoRoot 要 stat 各层的 .git，但那本来就是发现过程本身的开销），
 * 字符串去重：configDir 与仓库根重叠（很常见）时同一个路径不该在指纹里出现两遍。
 *
 * 为什么指纹要扫**全部候选**，而不是只扫「上次实际读到的那几个文件」：
 *   ① 判定发生在发现过程**之前**（要先知道变没变，才知道要不要重跑发现）——
 *      只扫已读文件的话，「新增 / 删掉一个 AGENTS.md」这类集合变化根本看不见；
 *   ② 想按「读到第一个非空就算命中」提前收手也做不到：是不是空文件必须读正文才知道，
 *      stat 只能给出 size > 0（只有空白字符的文件照样非零），早停会把真正生效的那个文件漏在指纹外。
 * 代价：影子候选（被更优先的名字压住、根本不会被读的文件）也在指纹里，改它们会触发一次**多余**的重载。
 * 重载后正文没变就不算「变化」（changed 另按正文逐字节比对），所以这只是几毫秒 ——
 * 换来的是「改了就必须生效」。宁可多失效一次，不可漏失效一次。
 */
async function candidateFiles(workdir: string, configDir: string, homeDir: string): Promise<string[]> {
  const dir = resolve(workdir);
  const out: string[] = [];
  const push = (layerDir: string, names: readonly string[]): void => {
    for (const name of names) out.push(resolve(join(layerDir, name)));
  };
  push(resolve(configDir), CONFIG_NAMES);                              // ① 品牌 home
  push(join(resolve(homeDir), ".agents"), AGENTS_MD_PLAIN_NAMES);      // ② 跨工具的 ~/.agents
  for (const layer of dirsFromRoot(await findRepoRoot(dir), dir)) {    // ③ 根 → 叶
    push(layer, LAYER_NAMES);
  }
  return [...new Set(out)];
}

/**
 * 采集候选指令文件的指纹：逐个 statSync，**绝不抛错**。
 * 为什么同步：一次装配打的是个位数到十几个 stat（每个一次 syscall、微秒级），不值得为它排事件循环。
 */
export async function fingerprintInstructions(
  workdir: string,
  configDir: string,
  homeDir: string = homedir(),
): Promise<InstructionsFingerprint> {
  const files: InstructionsFingerprint["files"] = [];
  for (const path of await candidateFiles(workdir, configDir, homeDir)) {
    try {
      const st = statSync(path);
      // 只收普通文件：目录 / 断链 / 特殊文件不会被读出正文，收进指纹只会白引一次重载
      if (st.isFile()) files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // 不存在 / 断链 / 权限不够 / 中间某段不是目录 —— 一律当作「这项不在指纹里」，绝不往上抛。
      // 「删掉一个已发现的 AGENTS.md」走的正是这条路：列表里少一项 = 指纹变了 = 触发重载，
      // 而这里吞掉的 errno 不会把整次装配带崩（与发现过程「绝不抛错」同一条纪律）。
    }
  }
  return { files };
}

/**
 * 读一层目录：按名字顺序试，**第一个读到非空内容的**即为该层的命中。
 * 读失败（不存在 / 是目录 / 权限 / 断链）继续试下一个名字：读不到就不是命中。
 * seen 在读之前先挡（同一个绝对路径不会读第二遍），读成功后登记真身：先写先得，位置由第一次出现决定。
 */
async function readLayer(dir: string, names: readonly string[], seen: Set<string>): Promise<{ path: string; body: string } | null> {
  for (const name of names) {
    const file = resolve(join(dir, name));
    if (seen.has(file)) continue;
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    // ⚠️ 读完之后必须把身份**规范化到真身**（realpath），不能只认候选名字。
    // 实测踩过：macOS / Windows 的卷默认大小写不敏感，AGENTS.md 与 agents.md 是**同一个文件** ——
    // 只按字符串去重时，configDir 与仓库根重叠的那种常见布局会让同一份规矩被注入两遍
    // （模型以为规矩写了两遍）；而录进锚点的还会是「我问的那个名字」而不是磁盘上真实的名字。
    // 代价：符号链接会被解析（mac 上 /var → /private/var 前缀会变），换来的路径是能直接打开的真身。
    const real = await realpath(file).catch(() => file);
    if (seen.has(real)) continue;
    seen.add(file);
    seen.add(real);
    const body = raw.trim();   // 空文件 / 只有空白的文件 = 没写，不算命中
    if (body.length > 0) return { path: real, body };
  }
  return null;
}

/**
 * 按固定顺序发现并拼好项目指令。
 *
 * @param workdir 工作目录（项目根 = 从它向上找 .git）
 * @param configDir Dove 的持久化目录（品牌 home）
 * @param homeDir 用户家目录。**可注入是为了测试**：真实 ~/.agents 每台机器不一样，
 *                测发现顺序时绝不能去读开发机上那份真文件（否则测试结果随环境飘）。
 */
export async function loadProjectInstructions(
  workdir: string,
  configDir: string,
  homeDir: string = homedir(),
): Promise<ProjectInstructionsResult> {
  const dir = resolve(workdir);
  // ⚠️ 指纹必须在**读正文之前**采，缓存里的指纹才永远不新于它对应的正文：
  // 之后任何一次写入都会让「当前指纹 ≠ 缓存指纹」，下次装配必然重读。
  // 反过来（读完再采）有个漏：采指纹与读正文之间发生的写入，会把「新指纹 + 旧正文」存进缓存，
  // 此后指纹再也不变，那份旧正文就永远赖在系统提示词里 —— 正是这次要修的病的变体。
  const fingerprint = await fingerprintInstructions(dir, configDir, homeDir);
  const seen = new Set<string>();
  const files: { path: string; bytes: number }[] = [];
  const parts: string[] = [];

  const collect = async (layerDir: string, names: readonly string[]): Promise<void> => {
    const hit = await readLayer(layerDir, names, seen);
    if (!hit) return;
    files.push({ path: hit.path, bytes: Buffer.byteLength(hit.body, "utf8") });
    parts.push(`${AGENTS_MD_ANCHOR(hit.path)}\n${hit.body}`);
  };

  await collect(resolve(configDir), CONFIG_NAMES);                                  // ① 品牌 home
  await collect(join(resolve(homeDir), ".agents"), AGENTS_MD_PLAIN_NAMES);          // ② 跨工具的 ~/.agents
  for (const layer of dirsFromRoot(await findRepoRoot(dir), dir)) {                 // ③ 根 → 叶
    await collect(layer, LAYER_NAMES);
  }

  const text = parts.join("\n\n");
  const paths = files.map((f) => f.path);
  if (files.length === 0) return { text: "", paths: [], fingerprint };

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= AGENTS_MD_MAX_BYTES) return { text, paths, fingerprint };

  // ⚠️ 超限只警告、**绝不截断**（与 Codex 的 project_doc_max_bytes 不同：那边是硬截断）。
  // 截断后模型看到的是半截规则，而半截的「不要动 legacy/ 目录」比完全没有这条更危险 ——
  // 模型会拿着残缺的规矩自信地越界，而且没人看得出它缺了哪一段。
  // 「上下文被撑大」这件事用户自己能解决（精简文件），不该由我们替他砍掉。
  const detail = files.map((f) => `${f.path}（${f.bytes} 字节）`).join("、");
  const limitKiB = Math.round(AGENTS_MD_MAX_BYTES / 1024);
  return {
    text,
    paths,
    fingerprint,
    warning: `项目指令合计 ${bytes} 字节，超过上限 ${AGENTS_MD_MAX_BYTES} 字节（${limitKiB} KiB）：已全部注入、未截断，但请你精简（过长的指令会挤占上下文并稀释注意力）。明细：${detail}`,
  };
}
