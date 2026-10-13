/**
 * 项目指令（AGENTS.md 层）单测
 * 运行：node --no-warnings --test packages/core/test/instructions.test.ts
 *
 * ⚠️ 全程真造文件、真读盘，但 **home 靠参数注入、绝不碰真实的 ~/.agents** ——
 * 开发机上的家目录里有用户自己写的规矩，那样的测试结果随环境飘，等于没测。
 *
 * 缓存类断言怎么观测：**数加载次数**（给 projectInstructionsFor 注入一个计数的 load，里面包着真加载器）。
 * 为什么不靠「改 mtime 但内容不变」间接推：在我们这套设计里，单动 mtime **就是**一次真重读
 * （指纹里放着 mtimeMs），那个手法区分不出「没读」；计数是唯一能证明「一次盘都没读」的观测点，
 * 顺带还把「重读了但正文逐字节没变 → changed=false」这条语义一起钉住。
 *
 * 为什么这些断言值得写死：发现顺序 / 每层只取一个 / 去重 / 超限不截断 / **改了立刻生效**，全是
 * **静默**行为 —— 少读一个文件、多读一遍、偷偷截掉半截规则、改了不生效，界面上都看不出来，只有模型的行动会变。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { extractInstructionPaths, fingerprintInstructions, hasInstructionAnchor, loadProjectInstructions } from "../src/context/instructions.ts";
import { clearInstructionCache, makeAssembler, projectInstructionsFor } from "../src/agent/assemble-adapter.ts";
import { SEGMENTS, assertSegmentDiscipline, buildSegmentContext } from "../src/context/segments.ts";
import { assembleSystemPrompt } from "../src/context/assemble.ts";
import { AGENTS_MD_ANCHOR, AGENTS_MD_MAX_BYTES } from "../src/constants.ts";
import type { Thread } from "../src/session/types.ts";

const roots: string[] = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function newDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dove-agi-${tag}-`));
  roots.push(dir);
  return dir;
}

/**
 * 写一个真文件（自动建父目录），返回**真身路径**。
 * 必须用 realpathSync 而不是原路：loader 的锚点/去重用的是 realpath 口径
 * （解析符号链接后 macOS 上 /var/folders → /private/var/folders），两边口径不一致会假失败。
 */
function put(file: string, content: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return realpathSync(file);
}

/** 造一个「仓库」：root 带 .git，workdir = root/a/b（中间隔一层，能验根在前叶在后） */
function makeRepo(tag: string): { root: string; workdir: string } {
  const root = newDir(tag);
  mkdirSync(join(root, ".git"), { recursive: true });
  const workdir = join(root, "a", "b");
  mkdirSync(workdir, { recursive: true });
  return { root, workdir };
}

/** 探测目录所在卷是否大小写敏感（macOS 默认不敏感：AGENTS.md 与 agents.md 根本写不出两份） */
function caseSensitive(dir: string): boolean {
  const probe = join(dir, ".dove-case-probe");
  writeFileSync(probe, "x");
  const same = existsSync(join(dir, ".DOVE-CASE-PROBE"));
  rmSync(probe, { force: true });
  return !same;
}

const THREAD: Thread = { id: "th_instructions", kind: "project", title: "测试线程", model: "stub", metadata: {}, createdAt: 0, updatedAt: 0 };

/** 计数的加载器：包着真加载器，用来证明「这一次根本没读盘」（见文件头的说明） */
function countingLoad(): { count: () => number; load: typeof loadProjectInstructions } {
  let n = 0;
  return {
    count: () => n,
    load: async (workdir, configDir, homeDir) => { n++; return loadProjectInstructions(workdir, configDir, homeDir); },
  };
}

/** 注入用的临时来源目录：configDir / homeDir 一律指到临时树上，绝不碰开发机的真家目录 */
function sources(tag: string): { configDir: string; homeDir: string } {
  return { configDir: newDir(`${tag}-cfg`), homeDir: newDir(`${tag}-home`) };
}

// ── 发现顺序 ────────────────────────────────────────
test("发现顺序：configDir → ~/.agents → 仓库根 → 中间层 → 工作目录", async () => {
  const { root, workdir } = makeRepo("order");
  const configDir = newDir("order-cfg");
  const home = newDir("order-home");
  const cfgFile = put(join(configDir, "AGENTS.md"), "配置目录的规矩");
  const homeFile = put(join(home, ".agents", "AGENTS.md"), "用户级的规矩");
  const rootFile = put(join(root, "AGENTS.md"), "仓库根的规矩");
  const midFile = put(join(root, "a", "AGENTS.md"), "中间层的规矩");
  const leafFile = put(join(workdir, "AGENTS.md"), "工作目录的规矩");

  const r = await loadProjectInstructions(workdir, configDir, home);

  assert.deepEqual(r.paths, [cfgFile, homeFile, rootFile, midFile, leafFile], "顺序必须与发现顺序逐项一致");
  assert.equal(r.warning, undefined);
  assert.ok(r.text.startsWith(AGENTS_MD_ANCHOR(cfgFile)), "第一段必须是 configDir");

  // 正文里的先后：根在前、叶在后（越靠近 cwd 越靠后）
  const idx = ["配置目录", "用户级", "仓库根", "中间层", "工作目录"].map((s) => r.text.indexOf(s));
  assert.ok(idx.every((i) => i >= 0), `每段正文都该在正文里：${idx}`);
  for (let k = 1; k < idx.length; k++) assert.ok(idx[k]! > idx[k - 1]!, `正文顺序错：${idx}`);

  assert.deepEqual(extractInstructionPaths(r.text), r.paths);
});

test("没有 .git：退化成只扫工作目录自己，不往上层乱读", async () => {
  const dir = newDir("nogit");
  const workdir = join(dir, "x", "y");
  mkdirSync(workdir, { recursive: true });
  put(join(dir, "AGENTS.md"), "上一层但不属于任何仓库");
  const file = put(join(workdir, "AGENTS.md"), "工作目录自己");

  const r = await loadProjectInstructions(workdir, newDir("nogit-cfg"), newDir("nogit-home"));

  assert.deepEqual(r.paths, [file]);
  assert.ok(!r.text.includes("上一层但不属于"), "没有 .git 时不该越界读上层目录");
});

// ── 每层只取一个 ────────────────────────────────────
test("每层取第一个命中：.kimi-code/AGENTS.md 压过同层的 AGENTS.md", async () => {
  const { root, workdir } = makeRepo("first");
  const hidden = put(join(root, ".kimi-code", "AGENTS.md"), "子目录里的规矩");
  put(join(root, "AGENTS.md"), "根目录的规矩");

  const r = await loadProjectInstructions(workdir, newDir("first-cfg"), newDir("first-home"));

  assert.deepEqual(r.paths, [hidden]);
  assert.ok(r.text.includes("子目录里的规矩"));
  assert.ok(!r.text.includes("根目录的规矩"), "同一层命中第一个就停");
});

test("每层只取一个：AGENTS.md 与 agents.md 并存时只认先命中的那个", async () => {
  const { root, workdir } = makeRepo("case");
  put(join(root, "AGENTS.md"), "大写版规矩");
  put(join(root, "agents.md"), "小写版规矩");

  const r = await loadProjectInstructions(workdir, newDir("case-cfg"), newDir("case-home"));

  assert.equal(r.paths.length, 1, `同一层只该读一个文件：${r.paths}`);
  if (caseSensitive(root)) {
    assert.equal(r.paths[0], join(root, "AGENTS.md"), "大小写敏感的卷上必须取 AGENTS.md");
    assert.ok(r.text.includes("大写版规矩"));
  } else {
    // 大小写不敏感的卷上两个名字指同一个文件，写后者覆盖前者 —— 只断言「只读了一个」
    assert.ok(r.text.includes("规矩"));
  }
});

test("大小写兜底：目录里只有 agents.md 时也要读到", async () => {
  const { root, workdir } = makeRepo("lower");
  const file = put(join(root, "agents.md"), "小写文件名的规矩");

  const r = await loadProjectInstructions(workdir, newDir("lower-cfg"), newDir("lower-home"));

  assert.deepEqual(r.paths, [file]);
  assert.ok(r.text.includes("小写文件名的规矩"));
});

// ── 去重 ────────────────────────────────────────────
test("去重：同一个文件被两条规则命中只出现一次（先写先得）", async () => {
  const { root, workdir } = makeRepo("dedup");
  const file = put(join(root, "AGENTS.md"), "仓库根规矩");

  // configDir 就是仓库根：规则①（品牌 home）与规则③（逐层）指同一个文件
  const r = await loadProjectInstructions(workdir, root, newDir("dedup-home"));

  assert.deepEqual(r.paths, [file]);
  assert.equal(r.text.split(AGENTS_MD_ANCHOR(file)).length - 1, 1, "同一来源只能出现一次");
  assert.ok(r.text.startsWith(AGENTS_MD_ANCHOR(file)), "先写先得：位置由第一次命中决定");
});

// ── 坏文件：静默跳过，绝不抛 ────────────────────────
test("空文件 / 目录 / 断链：静默跳过，不让整轮对话失败", async () => {
  // 每一层放一种坏法（同一个目录里不能同时放 AGENTS.md 与 agents.md：大小写不敏感的卷上它们是同一个名字）
  const root = newDir("skip");
  mkdirSync(join(root, ".git"), { recursive: true });
  const workdir = join(root, "a", "b", "c");
  mkdirSync(workdir, { recursive: true });
  put(join(root, "AGENTS.md"), "   \n\n\t  ");                             // 只有空白 = 没写
  mkdirSync(join(root, "a", "AGENTS.md"), { recursive: true });            // 是目录：读会 EISDIR
  symlinkSync(join(root, "a", "b", "nope.md"), join(root, "a", "b", "AGENTS.md")); // 断链：读会 ENOENT
  const file = put(join(workdir, "AGENTS.md"), "真正有用的规矩");

  const r = await loadProjectInstructions(workdir, newDir("skip-cfg"), newDir("skip-home"));

  assert.deepEqual(r.paths, [file], "坏文件一律跳过，好的照读");
  assert.ok(r.text.includes("真正有用的规矩"));
  assert.equal(r.warning, undefined);
});

// ── 超限：警告但不截断 ──────────────────────────────
test("超过 32 KiB：给 warning，但一个字都不截", async () => {
  const { root, workdir } = makeRepo("big");
  const line = "规矩：产物一律写进 outputs/，不要散落在项目根目录。\n";   // 约 78 字节
  const filler = line.repeat(600);
  const tail = "最后一条规矩：结尾标记 TAIL-MARK";
  const body = filler + tail;
  assert.ok(Buffer.byteLength(body, "utf8") > AGENTS_MD_MAX_BYTES, "用例本身得真的超限");
  const file = put(join(root, "AGENTS.md"), body);

  const r = await loadProjectInstructions(workdir, newDir("big-cfg"), newDir("big-home"));

  assert.ok(r.warning, "超限必须有告警");
  assert.ok(r.warning!.includes(file), "告警要指出是哪个文件超的");
  assert.ok(r.warning!.includes(String(AGENTS_MD_MAX_BYTES)), "告警要带上限数值");
  // 不截断：结尾标记还在，整段正文逐字节等于原文 + 锚点行
  assert.ok(r.text.includes(tail), "尾部被截掉了 —— 半截规则比没有更危险");
  assert.equal(r.text, `${AGENTS_MD_ANCHOR(file)}\n${body}`);
  assert.ok(Buffer.byteLength(r.text, "utf8") > AGENTS_MD_MAX_BYTES);
});

test("一个指令文件都没有：text 是空串、warning 是 undefined", async () => {
  const { workdir } = makeRepo("none");

  const r = await loadProjectInstructions(workdir, newDir("none-cfg"), newDir("none-home"));

  assert.equal(r.text, "");
  assert.deepEqual(r.paths, []);
  assert.equal(r.warning, undefined);
  // 空结果也带指纹：不然「这个项目没有指令」这件事会被每轮装配重新判定成「变了」——白读盘还白报变化
  assert.deepEqual(r.fingerprint, { files: [] });
});

// ── 锚点反查 ────────────────────────────────────────
test("锚点：反查来源按顺序、去重，且不误命中无关文本", () => {
  const a = "/tmp/x/AGENTS.md";
  const b = "/tmp/y/AGENTS.md";
  const text = [AGENTS_MD_ANCHOR(a), "规矩一", "", AGENTS_MD_ANCHOR(b), "规矩二", "", AGENTS_MD_ANCHOR(a), "又一条"].join("\n");

  assert.deepEqual(extractInstructionPaths(text), [a, b], "顺序与首次出现位置一致，重复来源只报一次");
  assert.deepEqual(extractInstructionPaths("普通正文\n没有锚点"), []);
  assert.equal(hasInstructionAnchor(text), true);
  assert.equal(hasInstructionAnchor(`From: ${a}`), false, "没有注释壳不算锚点");
  assert.equal(hasInstructionAnchor("<!-- 只是普通注释 -->"), false);
  assert.equal(hasInstructionAnchor(`前置 <!-- From: ${a} --> 后置`), false, "锚点必须独占一行");
});

// ── 段落注册 ────────────────────────────────────────
test("段注册：s12 存在、是最后一个，顺序没有被人插队", () => {
  // 这条断言是给未来的自己看的：**只许在尾部追加**，插到中间 = 其后全部前缀缓存失效
  assert.deepEqual(SEGMENTS.map((s) => s.id), [
    "s01-identity", "s02-personality", "s03-tone", "s04-working-dir", "s05-date-awareness",
    "s06-security", "s07-global-config", "s08-skills-first", "s09-execution",
    "s10-retrievable-context", "s11-artifacts", "s12-project-instructions",
  ]);
  const last = SEGMENTS[SEGMENTS.length - 1]!;
  assert.equal(last.id, "s12-project-instructions");
  assert.equal(last.kind, "semi");
  assert.ok((last.reason ?? "").length > 0, "非 static 段必须写 reason");
  assertSegmentDiscipline();
});

test("段渲染：有指令时带锚点与正文，没有指令时整段为空（不留只有标题的空段）", async () => {
  const { root, workdir } = makeRepo("seg");
  const configDir = newDir("seg-cfg");
  const body = "本项目规矩：产物一律写进 outputs/，不要动 legacy/ 目录。";
  const file = put(join(root, "AGENTS.md"), body);
  const loaded = await loadProjectInstructions(workdir, configDir, newDir("seg-home"));
  const last = SEGMENTS[SEGMENTS.length - 1]!;

  const withRules = await last.render(buildSegmentContext({ thread: THREAD, projectContext: { workdir, configDir, projectInstructions: loaded } }));
  assert.ok(withRules.startsWith("PROJECT INSTRUCTIONS"), "说明文字在前，指令正文在后");
  assert.ok(withRules.includes(AGENTS_MD_ANCHOR(file)));
  assert.ok(withRules.includes(body));
  assert.ok(withRules.indexOf(body) > withRules.indexOf("PROJECT INSTRUCTIONS"));

  const without = await last.render(buildSegmentContext({ thread: THREAD, projectContext: { workdir, configDir } }));
  assert.equal(without.trim(), "", "没有指令时整段为空");

  // 端到端：进了系统提示词，且落在非冻结的那一半（进 block1 就等于每轮重付全价）
  const a = await assembleSystemPrompt({ thread: THREAD, projectContext: { workdir, configDir, projectInstructions: loaded } });
  assert.ok(a.block2?.includes(body), "项目指令应在 block2");
  assert.ok(!a.block1.includes(body) && !a.block1.includes("PROJECT INSTRUCTIONS"), "绝不能进冻结前缀");
  const b = await assembleSystemPrompt({ thread: THREAD, projectContext: { workdir, configDir } });
  assert.ok(!`${b.block1}${b.block2 ?? ""}`.includes("PROJECT INSTRUCTIONS"), "没有指令时连标题都不该出现");
});

// ── 指纹与缓存：改了立刻生效，没改一次盘都不读 ─────────
test("指纹：磁盘没动时逐项相等，动了一个文件就不同", async () => {
  const { root, workdir } = makeRepo("fp");
  const src = sources("fp");
  const file = join(root, "AGENTS.md");   // 指纹记的是**候选路径**（不解析符号链接）——比 join 而不是 realpath
  put(file, "第一版规矩\n");
  const fp = () => fingerprintInstructions(workdir, src.configDir, src.homeDir);
  const a = await fp(), b = await fp();
  assert.deepEqual(b, a, "同一个 workdir 连取两次必须完全相等（否则每轮装配都被判成「变了」）");
  // 大小写不敏感卷（macOS 默认）上 AGENTS.md 与 agents.md 是同一个文件 → 两个候选名各记一条，都指向它
  assert.deepEqual(a.files.map((f) => f.path), caseSensitive(root) ? [file] : [file, join(root, "agents.md")], "只收真实存在的候选");
  assert.ok(a.files[0]!.size > 0 && a.files[0]!.mtimeMs > 0);
  assert.deepEqual((await loadProjectInstructions(workdir, src.configDir, src.homeDir)).fingerprint, a, "装载结果也带同一份指纹");
  put(file, "第二版规矩：多写一些内容，size 一定会变\n");
  const c = await fp();
  assert.notDeepEqual(c, a, "改了内容（mtime/size 动）→ 指纹必须不同");
  const st = statSync(file);   // 只动时间戳、size 不变：也要能被发现（mtimeMs 在指纹里）
  utimesSync(file, st.atime, new Date(st.mtimeMs + 5_000));
  assert.notDeepEqual(await fp(), c);
});

test("缓存：指纹没变就不重读盘（用计数观测），只有真改动才算「变化」", async () => {
  const { root, workdir } = makeRepo("cache");
  const src = sources("cache");
  const file = join(root, "AGENTS.md");
  put(file, "缓存里的规矩");
  clearInstructionCache();
  const counter = countingLoad();

  const first = await projectInstructionsFor(workdir, { ...src, load: counter.load });
  const second = await projectInstructionsFor(workdir, { ...src, load: counter.load });
  assert.equal(counter.count(), 1, "指纹没变 → 第二次必须命中缓存，一次盘都不读");
  assert.equal(second.text, first.text, "逐字节相同 → 系统提示词的前缀缓存不被打断");
  assert.equal(first.changed, false, "冷启动不是「变化」：没有上一版可比，提醒通道不该说话");
  assert.equal(second.changed, false);
  // 单动 mtime、内容一字不改：会重读（指纹里有 mtimeMs），但正文逐字节没变 → 仍不算「变化」
  const st = statSync(file);
  utimesSync(file, st.atime, new Date(st.mtimeMs + 5_000));
  const third = await projectInstructionsFor(workdir, { ...src, load: counter.load });
  assert.equal(counter.count(), 2, "mtime 变了 → 宁可多读一次，不可漏读");
  assert.equal(third.changed, false, "重读了但正文没变 → 不能说「规则变了」");
});

test("失效（核心）：改了 AGENTS.md 内容 → 下一次装配立刻看到新内容", async () => {
  const { root, workdir } = makeRepo("invalidate");
  const src = sources("invalidate");
  put(join(root, "AGENTS.md"), "旧规矩：产物放在项目根目录");
  clearInstructionCache();

  const before = await projectInstructionsFor(workdir, src);
  assert.ok(before.text.includes("旧规矩"));
  assert.equal(before.changed, false);
  put(join(root, "AGENTS.md"), "新规矩：产物一律写进 outputs/ 目录再交付");
  const after = await projectInstructionsFor(workdir, src);
  assert.ok(after.text.includes("新规矩"), "编辑后必须立刻生效 —— 这是本任务的核心");
  assert.ok(!after.text.includes("旧规矩"), "旧正文整段消失，不许新旧混排");
  assert.equal(after.changed, true, "变了就要标记出来（提醒通道据此说话）");
  assert.equal((await projectInstructionsFor(workdir, src)).changed, false, "稳定后不该一直报「变了」");
});

test("集合变化：新增一个更靠近 cwd 的 AGENTS.md → 下一次装配带上它", async () => {
  const { root, workdir } = makeRepo("add");
  const src = sources("add");
  const rootFile = put(join(root, "AGENTS.md"), "根的规矩");
  clearInstructionCache();
  assert.deepEqual((await projectInstructionsFor(workdir, src)).paths, [rootFile]);

  const leafFile = put(join(workdir, "AGENTS.md"), "叶子的新规矩");
  const after = await projectInstructionsFor(workdir, src);
  assert.deepEqual(after.paths, [rootFile, leafFile], "新加的文件必须被下一次装配看见");
  assert.ok(after.text.includes("叶子的新规矩"));
  assert.equal(after.changed, true);
});

test("文件消失：删掉已发现的 AGENTS.md → 不抛错、正文里不再有它", async () => {
  const { root, workdir } = makeRepo("vanish");
  const src = sources("vanish");
  const rootFile = put(join(root, "AGENTS.md"), "根的规矩");
  const leafFile = put(join(workdir, "AGENTS.md"), "叶子的规矩");
  clearInstructionCache();
  assert.deepEqual((await projectInstructionsFor(workdir, src)).paths, [rootFile, leafFile]);

  rmSync(leafFile);
  const after = await projectInstructionsFor(workdir, src);
  assert.deepEqual(after.paths, [rootFile], "被删的文件不该留在正文里");
  assert.ok(!after.text.includes("叶子的规矩"));
  assert.equal(after.changed, true);

  // 原地留一个断链（statSync 会抛 ENOENT）：指纹采集必须吞掉这个 errno，整次装配不许崩
  symlinkSync(join(workdir, "nope.md"), join(workdir, "AGENTS.md"));
  const last = await projectInstructionsFor(workdir, src);
  assert.deepEqual(last.paths, [rootFile], "断链不进指纹，也不该被读进来");
  assert.equal(last.changed, false, "集合没变（断链不算）→ 不重读、不报变化");
});

test("装配接线：一次 assemble 只取一次指令；没改逐字节不变，改了下轮立刻进提示词", async () => {
  const { root, workdir } = makeRepo("wire");
  const src = sources("wire");
  put(join(root, "AGENTS.md"), "装配时期的旧规矩");
  clearInstructionCache();
  const counter = countingLoad();
  const assemble = makeAssembler({ instructions: { ...src, load: counter.load } });
  const input = { thread: THREAD, projectId: null, userText: "在吗", workdir, outputsDir: join(workdir, "outputs") };

  const first = await assemble(input);
  assert.equal(counter.count(), 1, "一次装配恰取一次指令（轮内重复取会破坏轮内稳定）");
  assert.ok(first.systemPrompt.includes("装配时期的旧规矩"));

  const second = await assemble(input);
  assert.equal(counter.count(), 1, "磁盘没动 → 第二轮装配不该重读");
  assert.equal(second.systemPrompt, first.systemPrompt, "没改 → 系统提示词逐字节相同（前缀缓存不断）");

  put(join(root, "AGENTS.md"), "装配时期的新规矩");
  const third = await assemble(input);
  assert.equal(counter.count(), 2, "改了 → 下一轮装配重读");
  assert.ok(third.systemPrompt.includes("装配时期的新规矩") && !third.systemPrompt.includes("装配时期的旧规矩"));
});
