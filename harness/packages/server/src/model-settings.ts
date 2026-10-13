/**
 * 模型设置 —— 面板「设置」对话框的落点（base URL / 模型 / API key）。
 *
 * 优先级：**env > 存盘文件 > 内置默认**。
 *   · 文件是 `<configDir>/model.json`，0600（只本机可读）；
 *   · env / 仓库 env 文件给过的字段是**托管层**：运行期以它为准（见 #value），面板改不动它，
 *     而且它**永远不落盘**（威胁模型与做法见 #write 上方）。这条堵的是一个真实泄漏：
 *     面板读回来的就是生效值（可能是 env 的），用户点一下「保存」把表单原样回传 ——
 *     老版本会把 env 的值写进文件，等于把一个只该活在进程里的配置抄成了永久文件。
 *   · env 没给的字段才轮到文件（面板显式改过的）与内置默认。
 *
 * 为什么不是 DB：这几项要在 bootstrap 建 provider **之前**读到，而 provider 是内核
 * 最早的那批依赖（记忆抽取 / 审批分类 / 压缩全吃它）。一个 JSON 文件比在这条路径上
 * 拉一整套 session/db 便宜，也不进事务。
 *
 * ⚠️ key 的纪律：**只进进程与文件（env 来源的连文件都不进），不出接口**。对外的形状只有
 *    hasKey / keyMasked（sk-…abcd），日志和错误文本里一个字都不许出现。
 *    改这里之前先看 routes-settings.ts 顶部的注释。
 *
 * 运行时生效方式：**provider 每次 stream 现取设置**（LiveModelProvider），不是重启重建 ——
 * 面板上点一下保存，下一轮就用新 baseUrl，不用重启内核。见 LiveModelProvider。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getProvider } from "../../core/src/providers/index.ts";
import type { Provider, StreamOptions, StreamResult } from "../../core/src/providers/types.ts";

/** 存盘文件的内容。**可以只存一部分**：没存的字段继续走 env / 默认。env 来源的字段绝不在这里出现 */
export interface ModelSettingsFile {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** 面板能改的三个字段（也是文件里允许出现的三个 key） */
export type ModelField = "baseUrl" | "model" | "apiKey";
const FIELDS: readonly ModelField[] = ["baseUrl", "model", "apiKey"];

/**
 * env 来源的判据 —— **只看来源，不看值长什么样**（绝不用「长得像密钥」猜）：
 *   ① 该字段的规范 env 名存在，且值与它**逐字相等**（值对不上说明那不是 env 给的那个值）；
 *   ② 兜底值非空且 ≠ 内置默认。loadConfig 的兜底层只有两个来源（env / 仓库 env 文件、内置默认），
 *      刨掉默认就只剩 env 了 —— 仓库 `env` 文件里的 `ANTHROPIC_API_KEY` **不会**注入 process.env
 *      （loadConfig 只把它解析成对象），光靠 ① 会漏掉它，所以 ② 必须有。
 */
const ENV_NAMES: Record<ModelField, readonly string[]> = {
  baseUrl: ["DOVE_BASE_URL"],
  model: ["DOVE_MODEL"],
  apiKey: ["DOVE_API_KEY", "ANTHROPIC_API_KEY"],
};
/** 与 bootstrap.ts 的 loadConfig 保持一致（那边改默认值，这里必须同步，否则判据会失真） */
const BUILTIN_DEFAULTS: Record<ModelField, string> = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-flash",
  apiKey: "",
};

function providedByEnv(field: ModelField, value: string): boolean {
  if (!value) return false;                                 // 空值 = 没人给，谈不上来源
  if (ENV_NAMES[field].some((name) => (process.env[name] ?? "") === value)) return true;
  return value !== BUILTIN_DEFAULTS[field];
}

/** GET /api/settings/model 的形状（**没有 key 本体**） */
export interface ModelSettingsSummary {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyMasked: string;
  /** 由 env 接管的字段：面板保存它们不生效，也永远不会落盘（面板可据此提示「这里被 env 锁了」） */
  envFields: ModelField[];
}

/**
 * key 的掩码：`sk-1234…abcd`。
 * 短 key（≤8）只留头两位 —— 掩码本身也不能把 key 说出去，短 key 露 4 位就等于露一半。
 */
export function maskKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.length <= 8) return k.slice(0, 2) + "…";
  const head = /^(sk-|[a-z]{2,5}-)/i.exec(k)?.[0] ?? k.slice(0, 3);
  return `${head}…${k.slice(-4)}`;
}

/** baseUrl 校验：必须是 http(s) 的绝对地址（`api.deepseek.com` 这种少了协议的要挡住） */
export function validateBaseUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "baseUrl 不能为空";
  let u: URL;
  try { u = new URL(v); } catch { return `baseUrl 不是合法地址（${v}）——要带 http:// 或 https://`; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `baseUrl 只支持 http / https（收到 ${u.protocol}）`;
  if (!u.hostname) return "baseUrl 缺少主机名";
  return null;
}

export interface ModelSettingsDeps {
  configDir: string;
  /** env / 仓库 env 文件给的值（老路径，永远兜底） */
  fallback: { baseUrl: string; model: string; apiKey: string };
  /** 覆盖存盘路径（测试用） */
  file?: string;
}

export class ModelSettingsStore {
  #file: string;
  #env: { baseUrl: string; model: string; apiKey: string };
  /** 哪些字段的值是 env 给的（构造时定一次，判据见 providedByEnv） */
  #fromEnv: Record<ModelField, boolean>;
  #stored: ModelSettingsFile = {};
  #listeners: Array<(v: { baseUrl: string; model: string; apiKey: string }) => void> = [];

  constructor(deps: ModelSettingsDeps) {
    this.#file = deps.file ?? join(deps.configDir, "model.json");
    this.#env = deps.fallback;
    this.#fromEnv = {
      baseUrl: providedByEnv("baseUrl", this.#env.baseUrl),
      model: providedByEnv("model", this.#env.model),
      apiKey: providedByEnv("apiKey", this.#env.apiKey),
    };
    this.#stored = this.#read();
  }

  /** 读盘。文件不存在 / JSON 坏掉 / 读失败一律当「没存过」—— 设置丢了不该拖垮启动 */
  #read(): ModelSettingsFile {
    try {
      if (!existsSync(this.#file)) return {};
      const raw = JSON.parse(readFileSync(this.#file, "utf8")) as ModelSettingsFile;
      if (!raw || typeof raw !== "object") return {};
      const out: ModelSettingsFile = {};
      if (typeof raw.baseUrl === "string" && raw.baseUrl.trim()) out.baseUrl = raw.baseUrl.trim();
      if (typeof raw.model === "string" && raw.model.trim()) out.model = raw.model.trim();
      if (typeof raw.apiKey === "string" && raw.apiKey.trim()) out.apiKey = raw.apiKey.trim();
      // 老版本 / 手写文件里可能残留 env 来源的值（这正是要根治的那次泄漏）→ 读进来就当没存过：
      // 运行期继续用 env 的值，下一次落盘也不会把它抄回去。
      for (const f of FIELDS) if (this.#isExternal(f, out[f])) delete out[f];
      return out;
    } catch { return {}; }
  }

  get filePath(): string { return this.#file; }

  /**
   * 这个字段的值是不是「外部层给的」—— ① env 托管；② 值与外部层（env / 仓库 env 文件 /
   * 内置默认）**逐字相等**。② 是安全网：值与外部层一样时落盘在运行期毫无区别，
   * 却把一个进程里的值固化到磁盘上。判据只看来源与相等性，不猜值的形状。
   */
  #isExternal(f: ModelField, value: string | undefined): boolean {
    if (value === undefined) return false;
    return this.#fromEnv[f] || value === this.#env[f];
  }

  /** 生效值：env 托管的字段 env 说了算（文件里就算有值也不参与，否则「保存了却不生效」会变成静默的坑） */
  #value(f: ModelField): string {
    if (this.#fromEnv[f]) return this.#env[f];
    return this.#stored[f] ?? this.#env[f];
  }

  get baseUrl(): string { return this.#value("baseUrl"); }
  get model(): string { return this.#value("model"); }
  get apiKey(): string { return this.#value("apiKey"); }
  /** env 提供了 key（面板改不动它，它也不会落盘） */
  get keyFromEnv(): boolean { return this.#fromEnv.apiKey; }
  hasKey(): boolean { return this.apiKey.length > 0; }
  keyMasked(): string { return maskKey(this.apiKey); }

  summary(): ModelSettingsSummary {
    return {
      baseUrl: this.baseUrl, model: this.model, hasKey: this.hasKey(), keyMasked: this.keyMasked(),
      envFields: FIELDS.filter((f) => this.#fromEnv[f]),
    };
  }

  /** 订阅「设置变了」——bootstrap 用它把 cfg 同步过去（/api/health · /api/config · discovery 读的是 cfg） */
  onChange(cb: (v: { baseUrl: string; model: string; apiKey: string }) => void): void {
    this.#listeners.push(cb);
  }

  /**
   * 合并一次修改 → 校验 → 落盘。
   * **只接受显式传的字段**：面板没动的项（比如原样保留的 key）不该被空值覆盖。
   * **env 托管的字段连校验都不做**：它们不会生效、也不会落盘（见 #write），
   * 为一个用户改不动的值报错只会把人引向错误的方向。
   */
  save(patch: { baseUrl?: unknown; model?: unknown; apiKey?: unknown }):
    { ok: true; summary: ModelSettingsSummary } | { ok: false; error: string } {
    const next: ModelSettingsFile = { ...this.#stored };

    if (!this.#fromEnv.baseUrl && patch.baseUrl !== undefined && patch.baseUrl !== null && String(patch.baseUrl).trim() !== "") {
      const v = String(patch.baseUrl).trim();
      const bad = validateBaseUrl(v);
      if (bad) return { ok: false, error: bad };
      next.baseUrl = v;
    }

    if (!this.#fromEnv.model && patch.model !== undefined && patch.model !== null && String(patch.model).trim() !== "") {
      next.model = String(patch.model).trim();
    }

    // apiKey 特殊：**空串 = 没动**（面板永远拿不到原 key，所以它回传的永远是空串或新 key）。
    // 「我想删掉 key」不是这里的场景 —— 那件事得改 env 文件，面板不做。
    if (!this.#fromEnv.apiKey && patch.apiKey !== undefined && patch.apiKey !== null && String(patch.apiKey).trim() !== "") {
      next.apiKey = String(patch.apiKey).trim();
    }

    // 落盘前摘掉「外部层给的值」（env 托管 / 与 env 或内置默认逐字相等）。
    // **是摘掉，不是写空串** —— 空串会被下一次读盘当成「用户手动清空了这个字段」，语义完全不同。
    for (const f of FIELDS) if (this.#isExternal(f, next[f])) delete next[f];

    const prev = this.#stored;
    this.#stored = next;
    try {
      this.#write();
    } catch (e) {
      this.#stored = prev;   // 落盘失败 → 内存也别改，免得「这轮生效、重启就没了」
      return { ok: false, error: `设置写盘失败：${e instanceof Error ? e.message : String(e)}` };
    }

    const v = { baseUrl: this.baseUrl, model: this.model, apiKey: this.apiKey };
    for (const l of this.#listeners) { try { l(v); } catch { /* 单个订阅者出错不影响其他人 */ } }
    return { ok: true, summary: this.summary() };
  }

  /**
   * 原子替换 + 显式 chmod：写入方和读方（下一轮建 provider）可能正好撞车，半截 JSON 等于设置丢了。
   *
   * ⚠️ 威胁模型（这条不许破例）：磁盘上的 `model.json` 是**永久**的 —— 备份、同步盘、换机、
   * 多用户机器上的另一个账号，任何拿到这台机器文件的人都能读到里面每一个字；而环境变量只活在
   * 这次运行的进程里，进程一退就没了。所以 **env 来源的字段一个字都不写**：save() 已经把这种
   * 字段摘掉（摘完可能只剩一部分、甚至空），这里再兜一道闸 —— 空就什么都不写，
   * 文件已存在（老版本写进去的 env 值）就顺手清掉，绝不留一个装着密钥的空壳在磁盘上。
   */
  #write(): void {
    if (Object.keys(this.#stored).length === 0) {
      if (existsSync(this.#file)) { try { unlinkSync(this.#file); } catch { /* 删不掉不是致命的：文件里本来就没有可用设置 */ } }
      return;
    }
    const dir = dirname(this.#file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#stored, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    // 文件已存在时 writeFileSync 的 mode 不生效（umask 也不一定）→ 显式来一次
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#file);
  }
}

/**
 * 「活」provider —— 每次 stream **现取**设置。
 *
 * 为什么不是「保存时重建一个 provider 换上去」：provider 实例是被**四处**捕获的
 * （AgentRuntime 每轮读、记忆抽取的 llm、审批分类器、压缩器各一份），挨个换要维护一张
 * 容易漏的清单（这个仓库里「建好没接」栽过好几次）。让它们共用同一个活壳子，
 * 只有一处真相，也不存在漏换。
 *
 * 便宜：核心的 getProvider 按 `baseUrl|apiKey` 缓存 —— 设置没变就是同一个实例，
 * 变了才重建（也就等于「保存时重建」）。
 */
export class LiveModelProvider implements Provider {
  id = "deepseek";
  #store: ModelSettingsStore;

  constructor(store: ModelSettingsStore) { this.#store = store; }

  stream(opts: StreamOptions): Promise<StreamResult> {
    return getProvider({ baseUrl: this.#store.baseUrl, apiKey: this.#store.apiKey }).stream(opts);
  }
}

export interface TestResultOk { ok: true; model: string; latencyMs: number }
export interface TestResultFail { ok: false; error: string }

/** HTTP 状态 → 人话。带上状态行和服务端给的原话（DeepSeek / OpenAI 兼容网关都是这一套） */
function describeHttpError(status: number, statusText: string, body: string): string {
  const hint =
    status === 401 ? "密钥无效" :
    status === 402 ? "余额不足" :
    status === 403 ? "没有权限" :
    status === 404 ? "端点或模型不存在（检查 baseUrl / model）" :
    status === 429 ? "被限流" :
    status >= 500 ? "服务端错误" : "请求被拒";
  const head = `${status}${statusText ? " " + statusText : ""}`;
  const msg = providerMessage(body);
  return msg ? `${head} · ${hint} · ${msg}` : `${head} · ${hint}`;
}

/**
 * 兜底擦除：有些网关会把**整把 key** 原样回在错误正文里。
 * 网关原话要报（用户得看得懂），但 key 一个字都不能出去 —— 出现就换成掩码。
 */
function scrubKey(text: string, key: string): string {
  if (!text || !key || key.length < 8) return text;
  return text.split(key).join(maskKey(key));
}

/** 从错误正文里挖出网关的原话；挖不出来就退回截断后的原文（不含任何请求头） */
function providerMessage(body: string): string {
  const text = (body ?? "").trim();
  if (!text) return "";
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const m = typeof j.error === "string" ? j.error : j.error?.message ?? j.message;
    if (m) return String(m).slice(0, 200);
  } catch { /* 不是 JSON，走截断 */ }
  return text.replace(/\s+/g, " ").slice(0, 200);
}

/**
 * 打一次**真的** completion（`max_tokens:1`，不流式）—— 设置对话框的「测试」按钮。
 *
 * 为什么不用 Provider.stream：那个把 HTTP 错误压成一句 `HTTP 401: ...`（见 openai-compat.ts），
 * 拿不到状态码本身；而这里恰恰要把「401 / 连不上 / 超时」分开说。
 * key 只进 Authorization 头，不进 URL、不进返回值、不进日志。
 */
export async function testModelEndpoint(opts: {
  baseUrl: string; model: string; apiKey: string; timeoutMs?: number;
}): Promise<TestResultOk | TestResultFail> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = describeHttpError(res.status, res.statusText, await res.text().catch(() => ""));
      return { ok: false, error: scrubKey(err, opts.apiKey) };
    }
    await res.text().catch(() => "");   // 把正文读干，别留下没关的连接
    return { ok: true, model: opts.model, latencyMs: Date.now() - started };
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, error: `超时（${Math.round(timeoutMs / 1000)}s 内没有响应）` };
    // fetch 的网络错误只说 "fetch failed"，原因在 cause 里（ECONNREFUSED / 证书 / DNS）
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    const why = cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
    return { ok: false, error: scrubKey(`连不上：${why}`, opts.apiKey) };
  } finally {
    clearTimeout(timer);
  }
}
