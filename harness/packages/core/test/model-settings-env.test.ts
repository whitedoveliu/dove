/**
 * 模型设置：**env 来源的字段永不落盘**，且运行期以 env 为准。
 *
 * 这是从一个真实泄漏堵回来的：面板 GET 到的生效值可能来自 env，用户点一下「保存」
 * 会把表单原样回传 —— 老版本于是把 env 的值写进 `<configDir>/model.json`，
 * 一个只该活在进程里的配置变成了磁盘上的永久文件（磁盘 = 备份 / 同步盘 / 换机都能读到）。
 *
 * 判据是**来源**（process.env 里同一个值 / 兜底值不是内置默认），不是「值长得像密钥」。
 * 本文件钉住三条纪律（分别对应用例）：
 *  ① 只来自 env → 文件里没有这个值。本文件选定的语义：**连文件都不创建**；
 *     万一有文件，整个 key 名都不出现（不是空串、不是 null —— 那会被当成「用户清空了」）。
 *  ② 面板显式改的值 → 正常落盘，重启（新 store）读得回来；
 *  ③ env 与文件都有 → 运行期以 env 为准，且 env 值不会在下次落盘时被抄进文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelSettingsStore } from "../../server/src/model-settings.ts";

const ENV_KEYS = ["DOVE_BASE_URL", "DOVE_MODEL", "DOVE_API_KEY", "ANTHROPIC_API_KEY"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

/** 每个用例都从「干净的 process.env」出发：判据就是它，不隔离用例会互相污染 */
function withEnv(vars: Partial<Record<EnvKey, string>>, fn: () => void): void {
  const saved = new Map<EnvKey, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of ENV_KEYS) { const v = vars[k]; if (v !== undefined) process.env[k] = v; }
  try {
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 与 bootstrap.ts 的 loadConfig 一致的内置默认（没有 env 时的兜底值） */
const DEFAULTS = { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", apiKey: "" };

/** 临时目录（落盘文件长这样：`<dir>/model.json`） */
function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "dove-model-settings-"));
}

// ── ① 只来自 env → 不落盘 ─────────────────────────────────────
test("只来自 env：面板原样保存也不落盘（连文件都不创建），但运行期照旧用 env 的值", () => {
  const env = { baseUrl: "https://env.example.com/v1", model: "env-model", apiKey: "sk-env-key-1234567890" };
  withEnv({ DOVE_BASE_URL: env.baseUrl, DOVE_MODEL: env.model, DOVE_API_KEY: env.apiKey }, () => {
    const dir = tmpDir();
    const file = join(dir, "model.json");
    const store = new ModelSettingsStore({ configDir: dir, file, fallback: { ...env } });
    // 这条就是泄漏路径本身：面板读到什么（env 的值），保存时就把什么原样传回来
    const r = store.save({ baseUrl: env.baseUrl, model: env.model, apiKey: env.apiKey });
    assert.equal(r.ok, true);
    assert.equal(existsSync(file), false, "env 来源的字段一个都不该落盘 —— 文件根本不该被创建");

    // 「不落盘」不等于「不生效」
    assert.equal(store.baseUrl, env.baseUrl);
    assert.equal(store.model, env.model);
    assert.equal(store.apiKey, env.apiKey);
    assert.equal(store.hasKey(), true);
    assert.deepEqual(store.summary().envFields, ["baseUrl", "model", "apiKey"]);
    assert.ok(!store.summary().keyMasked.includes("1234567890"), "掩码也不许把 key 说出去");
  });
});

test("只有部分字段来自 env：别的字段正常落盘，env 那个字段连 key 名都不出现", () => {
  const key = "sk-env-key-abcdefgh";
  withEnv({ DOVE_API_KEY: key }, () => {
    const dir = tmpDir();
    const file = join(dir, "model.json");
    const store = new ModelSettingsStore({ configDir: dir, file, fallback: { ...DEFAULTS, apiKey: key } });
    assert.equal(store.save({ model: "user-model", apiKey: key }).ok, true);

    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(raw.model, "user-model", "env 没接管的字段照常落盘");
    assert.equal("apiKey" in raw, false, "env 来源的 apiKey 整个 key 都不该出现在文件里（不是空串、不是 null）");
    assert.deepEqual(store.summary().envFields, ["apiKey"]);
  });
});

// ── ② 面板显式改 → 正常落盘 ───────────────────────────────────
test("面板显式改的值正常落盘、重启读得回来；改成内置默认的值不留文件（默认层本来就给这个值）", () => {
  withEnv({}, () => {
    const dir = tmpDir();
    const file = join(dir, "model.json");
    const store = new ModelSettingsStore({ configDir: dir, file, fallback: { ...DEFAULTS } });
    assert.deepEqual(store.summary().envFields, [], "没有 env 时不该有托管字段");

    const r = store.save({ baseUrl: "https://gateway.example.com/v1", model: "my-model", apiKey: "sk-user-key-abcdefgh" });
    assert.equal(r.ok, true);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(raw.baseUrl, "https://gateway.example.com/v1");
    assert.equal(raw.model, "my-model");
    assert.equal(raw.apiKey, "sk-user-key-abcdefgh");

    // 重启 = 新 store 读同一个文件
    const again = new ModelSettingsStore({ configDir: dir, file, fallback: { ...DEFAULTS } });
    assert.equal(again.baseUrl, "https://gateway.example.com/v1");
    assert.equal(again.model, "my-model");
    assert.equal(again.apiKey, "sk-user-key-abcdefgh");

    assert.equal(again.save({ baseUrl: DEFAULTS.baseUrl }).ok, true);
    const raw2 = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal("baseUrl" in raw2, false, "与兜底层逐字相等的值不写文件（运行期本来就是它）");
    assert.equal(raw2.model, "my-model", "别的字段不受影响");
  });
});

// ── ③ env 与文件都有 → env 为准 ───────────────────────────────
test("env 与文件都有：运行期以 env 为准；下次落盘把 env 值从文件里清掉", () => {
  const key = "sk-env-key-9999";
  withEnv({ DOVE_MODEL: "env-model", DOVE_API_KEY: key }, () => {
    const dir = tmpDir();
    const file = join(dir, "model.json");
    // 老版本 / 手写文件里躺着 env 值的副本 —— 被泄漏之后的样子
    writeFileSync(file, JSON.stringify({ model: "env-model", apiKey: key, baseUrl: "https://file.example.com/v1" }));
    const store = new ModelSettingsStore({
      configDir: dir, file, fallback: { ...DEFAULTS, model: "env-model", apiKey: key },
    });

    assert.equal(store.model, "env-model", "env 给了 model → 以 env 为准（不是文件里的那份）");
    assert.equal(store.apiKey, key, "env 给了 key → 以 env 为准");
    assert.equal(store.baseUrl, "https://file.example.com/v1", "env 没给的字段，文件照常生效");

    // 保存一个 env 没接管的字段 → 重写文件时把 env 值一并清掉（不是留成空串）
    assert.equal(store.save({ baseUrl: "https://file2.example.com/v1" }).ok, true);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal("model" in raw, false);
    assert.equal("apiKey" in raw, false);
    assert.equal(raw.baseUrl, "https://file2.example.com/v1");
  });
});

test("文件里只剩 env 值的残留：保存后直接清掉文件，不留空壳", () => {
  const key = "sk-env-key-9999";
  withEnv({ DOVE_API_KEY: key }, () => {
    const dir = tmpDir();
    const file = join(dir, "model.json");
    writeFileSync(file, JSON.stringify({ apiKey: key }));
    const store = new ModelSettingsStore({ configDir: dir, file, fallback: { ...DEFAULTS, apiKey: key } });
    // 这次保存没有任何字段可写（baseUrl 与内置默认逐字相等，也会被摘掉）
    assert.equal(store.save({ baseUrl: DEFAULTS.baseUrl }).ok, true);
    assert.equal(existsSync(file), false, "摘完为空 → 不留 {} 空壳、也不留残值；下次启动照样从 env 拿 key");
    assert.equal(store.apiKey, key);
  });
});

// ── 判据②：仓库 `env` 文件（不经过 process.env）也算 env 来源 ──
test("兜底值 ≠ 内置默认 = env 来源：仓库 env 文件的 key 同样托管、同样不落盘", () => {
  withEnv({}, () => {   // 刻意**不设** process.env —— 走的是判据 ②
    const dir = tmpDir();
    const file = join(dir, "model.json");
    const store = new ModelSettingsStore({
      configDir: dir, file, fallback: { ...DEFAULTS, apiKey: "sk-file-env-key-1234" },
    });
    assert.deepEqual(store.summary().envFields, ["apiKey"], "非内置默认的兜底值来自 env 层（仓库 env 文件不注入 process.env）");
    assert.equal(store.save({ apiKey: "sk-file-env-key-1234" }).ok, true);
    assert.equal(existsSync(file), false, "它同样不许落盘");

    // 托管字段的完整语义：面板敲一把新 key 也不生效（要换 key 得改 env 本身），但绝不落盘
    assert.equal(store.save({ apiKey: "sk-user-typed-9999" }).ok, true);
    assert.equal(store.apiKey, "sk-file-env-key-1234", "env 托管时面板改不动它");
    assert.equal(existsSync(file), false);
  });
});
