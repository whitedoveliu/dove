/**
 * 读侧路径护栏：security/paths.ts 的判定规则 + Read / Glob / Grep 三个工具的**可观察行为**。
 *
 * 为什么不能只测判定函数：规则写对了但工具没接上，等于没有护栏 ——
 * 写侧就踩过这个坑（Write/Edit 标了 approval:"heuristic"，审批判定却只看 args.command，
 * 于是「从不审批」，档位的名字是假的）。所以这里真的调 execute，断言模型拿到的是错误 / 过滤后的结果。
 *
 * 另一条纪律：测试里的敏感路径都用**临时目录**拼出来，不碰真实的 ~/.ssh。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assertReadablePath, filterSensitiveEntries, isSensitivePath, sensitiveFilterNote } from "../src/security/paths.ts";
import { ReadTool } from "../src/tools/builtin/read.ts";
import { GlobTool } from "../src/tools/builtin/glob.ts";
import { GrepTool } from "../src/tools/builtin/grep.ts";
import type { ToolContext } from "../src/tools/types.ts";

const MARKER = "DOVE_PATH_SECRET_MARKER";

function ctxWith(workdir: string): ToolContext {
  return {
    toolCallId: "call-pathsec", threadId: "th-pathsec", workdir, outputsDir: join(workdir, "outputs"),
    emit: () => { /* 测试不关心事件 */ },
    // 读侧护栏是硬拒，不该有任何一条路走到审批；走到这里说明设计被改坏了
    requestApproval: async () => { throw new Error("读侧护栏不应该走审批"); },
    services: {},
  };
}

/** 按 {相对路径: 内容} 造一棵临时目录树 */
function tmpTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dove-pathsec-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

// ── 1. 判定规则：该拦的拦 ───────────────────────────────────────────
test("路径护栏：私钥 / 云凭证 / .env / 证书类命中", () => {
  const hits = [
    "/Users/u/.ssh/id_rsa",
    "/Users/u/.ssh/id_ed25519",
    "/Users/u/.aws/credentials",
    "/Users/u/.gnupg/secring.gpg", // 目录段命中 .gnupg，与文件名无关
    "/Users/u/.config/gcloud/credentials.db", // 多段规则：.config/gcloud
    "/proj/.env",
    "/proj/.env.local",
    "/proj/config/.env.production",
    "/proj/certs/apikey.pem",
    "/proj/certs/server.p12",
    "/proj/service-account-prod.json",
    "/proj/.npmrc",
    "/Users/u/.kube/config",
    "/proj/.ENV", // macOS/Windows 文件系统大小写不敏感，.ENV 就是 .env
    "/proj/env",  // 本仓库自己的惯例：仓库根的 env 文件装真钥匙（README 第 1 步就是写它）
  ];
  for (const p of hits) assert.equal(isSensitivePath(p), true, "应该命中：" + p);
});

test("路径护栏：防误伤 —— 精确匹配，绝不做子串包含", () => {
  const clean = [
    "/proj/src/credentialsHelper.ts", // 不是 credentials
    "/proj/.envoy",                    // 不是 .env，也不以 .env. 开头
    "/proj/.envrc",                    // 同上
    "/proj/docs/notes.pem.md",         // .pem 不在结尾
    "/proj/src/monkey.pem.md",
    "/proj/readme.md",
    "/proj/src/keyboard.ts",           // 不以 .key 结尾
    "/proj/.config/nvim/init.lua",     // .config/gcloud 是**连续**两段，.config 单独不算
    "/proj/ssh-notes.md",
    // 模板/样板不是钥匙：拦下来只会让模型读不到「该配哪些变量」（见 sensitiveHitOf 的 ⓪）
    "/proj/.env.example",
    "/proj/.env.template",
    "/proj/secrets.sample",
    // 裸名规则只认「末尾一段全等」：env.ts 不是 env
    "/proj/src/env.ts",
  ];
  for (const p of clean) assert.equal(isSensitivePath(p), false, "不该命中：" + p);
});

test("路径护栏：错误文案要说清是哪条规则命中的，并点名不许绕", () => {
  const cases: [string, RegExp][] = [
    ["/proj/.ssh/config", /敏感目录「\.ssh」/],
    ["/proj/.env.local", /敏感文件名「\.env.local」/],
    ["/proj/certs/apikey.pem", /敏感文件后缀「\.pem」/],
    ["/proj/service-account-prod.json", /敏感文件名前缀「service-account-」/],
    ["/Users/u/.aws/credentials", /敏感文件名「credentials」/],
  ];
  for (const [p, re] of cases) {
    assert.throws(() => assertReadablePath(p), re, "错误文案里必须有命中的规则：" + p);
  }
  // 文案要让模型知道「换工具绕也没用」，否则它会立刻用 Grep/Glob 试一遍（实测模型就是这么干的）
  assert.throws(() => assertReadablePath("/proj/.env"), /Grep \/ Glob/);
});

test("路径护栏：工作目录本身在敏感目录里时，不把整棵树都拒了", () => {
  // 用户显式把工作区设在 ~/.ssh（或审计用的 .aws 目录）下：他知情，目录段规则豁免
  assert.equal(isSensitivePath("/Users/u/.ssh/config", "/Users/u/.ssh"), false);
  assert.doesNotThrow(() => assertReadablePath("/Users/u/.ssh/config", "/Users/u/.ssh"));
  // 豁免的边界很窄：文件名规则永远生效（id_rsa 是不是秘密跟它在哪个目录无关）
  assert.throws(() => assertReadablePath("/Users/u/.ssh/id_rsa", "/Users/u/.ssh"), /id_rsa/);
  // base 之下的敏感目录照拦
  assert.throws(() => assertReadablePath("/srv/work/.docker/config.json", "/srv/work"), /\.docker/);
  // 跨边界的多段规则不算豁免：base=~/.config 不等于「用户选过 gcloud」
  assert.throws(() => assertReadablePath("/Users/u/.config/gcloud/creds.json", "/Users/u/.config"), /\.config\/gcloud/);
  // base 自身不拦：否则 Read(".")（列当前工作目录）会直接死
  assert.doesNotThrow(() => assertReadablePath("/srv/work", "/srv/work"));
  assert.doesNotThrow(() => assertReadablePath("/Users/u/.ssh/.", "/Users/u/.ssh"));
});

test("路径护栏：过滤只回报数量，绝不回传被丢掉的路径", () => {
  const entries = ["a.ts", ".env", ".ssh/id_rsa", "src/b.ts"];
  const { kept, droppedCount } = filterSensitiveEntries(entries, (e) => "/proj/" + e, "/proj");
  assert.equal(droppedCount, 2);
  assert.deepEqual(kept, ["a.ts", "src/b.ts"]);
  // 报名字等于换个字段把情报交出去
  assert.equal(JSON.stringify({ kept, droppedCount }).includes("id_rsa"), false);
  assert.equal(JSON.stringify({ kept, droppedCount }).includes(".env"), false);
});

test("路径护栏：没有过滤就不出提示（每轮多一句废话会挤掉有用信息）", () => {
  assert.equal(sensitiveFilterNote(0), undefined);
  assert.match(String(sensitiveFilterNote(3)), /已过滤 3 条敏感路径/);
});

// ── 2. Read ─────────────────────────────────────────────────────────
test("Read：敏感路径返回 {error}，普通文件正常读到内容", async () => {
  const dir = tmpTree({
    "secret.txt": "hello dove\n",
    ".env": "OPENAI_API_KEY=" + MARKER + "\n",
    ".ssh/id_rsa": "-----BEGIN OPENSSH PRIVATE KEY-----\n" + MARKER + "\n",
  });
  try {
    const ctx = ctxWith(dir);

    const ok = await ReadTool.execute({ file_path: "secret.txt" }, ctx);
    assert.equal(String(ok.content).includes("hello dove"), true);
    assert.equal(ok.error, undefined);

    const env = await ReadTool.execute({ file_path: ".env" }, ctx);
    assert.equal(typeof env.error, "string");
    assert.match(String(env.error), /敏感文件名/);
    assert.equal("content" in env, false, "被拒时不许带出任何内容");

    const key = await ReadTool.execute({ file_path: ".ssh/id_rsa" }, ctx);
    assert.match(String(key.error), /id_rsa|\.ssh/);

    // 目录本身也拦：列 ~/.ssh 等于把密钥清单交出去
    const dirRead = await ReadTool.execute({ file_path: ".ssh" }, ctx);
    assert.match(String(dirRead.error), /敏感目录「\.ssh」/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Read：工作区语义没变 —— 工作区外的普通文件照样能读", async () => {
  const inside = tmpTree({ "a.txt": "inside\n" });
  const outside = tmpTree({ "b.txt": "outside\n" });
  try {
    const ctx = ctxWith(inside);
    const res = await ReadTool.execute({ file_path: join(outside, "b.txt") }, ctx);
    assert.equal(String(res.content).includes("outside"), true, "读侧只加秘密拦截，不锁工作区");
    const list = await ReadTool.execute({ file_path: "." }, ctx);
    assert.equal(list.type, "directory");
  } finally {
    rmSync(inside, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── 3. Glob ─────────────────────────────────────────────────────────
test("Glob：敏感路径不出现在结果里，有过滤就报数量", async () => {
  const dir = tmpTree({
    "a.ts": "a\n",
    "src/b.ts": "b\n",
    ".env": MARKER + "\n",
    ".ssh/id_rsa": MARKER + "\n",
    ".aws/credentials": MARKER + "\n",
  });
  try {
    const res = await GlobTool.execute({ pattern: "**/*" }, ctxWith(dir));
    const files = (res.files as string[]) ?? [];
    assert.deepEqual(files.filter((f) => f.endsWith(".ts")).sort(), ["a.ts", "src/b.ts"]);
    const dump = JSON.stringify(files);
    assert.equal(dump.includes(".ssh"), false, "敏感目录不许被枚举出来");
    assert.equal(dump.includes(".aws"), false);
    assert.equal(dump.includes(".env"), false);
    assert.match(String(res.note), /已过滤 1 条敏感路径/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Glob：把敏感目录当搜索根 → 直接拒；干净目录 → 一句提示都不加", async () => {
  const dir = tmpTree({ "a.ts": "a\n", ".ssh/id_rsa": MARKER + "\n" });
  try {
    const ctx = ctxWith(dir);
    const bad = await GlobTool.execute({ pattern: "**/*", path: ".ssh" }, ctx);
    assert.match(String(bad.error), /敏感目录「\.ssh」/);

    const clean = await GlobTool.execute({ pattern: "**/*.ts" }, ctx);
    assert.deepEqual(clean.files, ["a.ts"]);
    assert.equal(clean.note, undefined, "没过滤就不该多出这句话");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. Grep ─────────────────────────────────────────────────────────
test("Grep：敏感文件的内容不被搜出来，有过滤就报数量", async () => {
  const dir = tmpTree({
    "a.ts": "const x = '" + MARKER + "';\n",
    ".env": "KEY=" + MARKER + "\n",
    ".ssh/id_rsa": MARKER + "\n",
  });
  try {
    const res = await GrepTool.execute({ pattern: MARKER }, ctxWith(dir));
    const result = String(res.result);
    assert.equal(result.includes("a.ts:1:"), true, "正常文件该搜到");
    assert.equal(result.includes(".env"), false, "敏感文件不许出现在结果里");
    assert.equal(result.includes(".ssh"), false);
    assert.equal(res.files_searched, 1, "敏感文件连读都不该读");
    assert.match(String(res.note), /已过滤 1 条敏感路径/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Grep：敏感文件 / 目录当搜索目标 → 直接拒；干净目录 → 一句提示都不加", async () => {
  const dir = tmpTree({ "a.ts": "hello\n", ".env": MARKER + "\n" });
  const cleanDir = tmpTree({ "a.ts": "hello\n" });
  try {
    const ctx = ctxWith(dir);
    assert.match(String((await GrepTool.execute({ pattern: "x", path: ".env" }, ctx)).error), /敏感文件名/);
    assert.match(String((await GrepTool.execute({ pattern: "x", path: ".ssh" }, ctx)).error), /敏感目录/);

    const clean = await GrepTool.execute({ pattern: "hello" }, ctxWith(cleanDir));
    assert.equal(String(clean.result).includes("a.ts:1:hello"), true);
    assert.equal(clean.note, undefined, "没过滤就不该多出这句话");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cleanDir, { recursive: true, force: true });
  }
});
