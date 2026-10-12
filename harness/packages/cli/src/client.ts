/**
 * 内核客户端：端口发现 + HTTP 调用
 *
 * 形状照 Alma 报告 §0.2 第 1 点：**运行时在主进程，CLI 只是它的调用方**。
 * 所以这里绝不 import bootstrap —— 自己起一份内核会和用户在跑的 App 抢同一个库、
 * 同一个端口、同一份记忆，最后两边都状态错乱。
 *
 * 端口发现的顺序是刻意的：显式参数 > 环境变量 > 端口文件 > 扫描 8790..8799。
 * 端口文件由内核启动时写入（packages/server/src/discovery.ts），是 App 那条路径
 * （用户点图标启动、CLI 事后才来）唯一能对上号的办法。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Target {
  port: number;
  base: string;
  /** 这个端口是怎么来的（报错时要能一眼看出找错了地方） */
  source: string;
}

export class ApiError extends Error {
  /** 0 = 网络层就没连上（内核没起 / 端口不对），其余是 HTTP 状态码 */
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** 找不到任何内核 —— 带上「下一步能做什么」，不要让用户猜 */
export class NoKernelError extends Error {
  readonly hints: string[];
  constructor(message: string, hints: string[]) {
    super(message);
    this.name = "NoKernelError";
    this.hints = hints;
  }
}

/** 内核的配置目录。和 loadConfig() 同一套规则：DOVE_CONFIG 优先，否则 ~/.dove */
export function configDir(): string {
  return process.env.DOVE_CONFIG ?? join(homedir(), ".dove");
}

function portFilePath(): string {
  return join(configDir(), "port");
}

const PORT_LO = 8790;
const PORT_HI = 8799;

/** 探一次 /api/health。只认新内核的 `ok: true`（老兼容层 8008 返回的是 `status: "ok"`，不是同一个契约） */
export async function probeHealth(port: number, timeoutMs = 600): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown>;
    return j && j.ok === true ? j : null;
  } catch {
    return null;
  }
}

function readPortFile(): number | null {
  const f = portFilePath();
  if (!existsSync(f)) return null;
  const n = Number(readFileSync(f, "utf8").trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * 定出这次要连哪个端口。
 * 显式给的和环境变量给的**必须真的能连上**才算数（那是用户明说的），
 * 端口文件和扫描结果是「猜的」，猜不中就继续往下找。
 */
export async function resolveTarget(explicitPort?: number): Promise<Target> {
  if (explicitPort !== undefined) {
    if (await probeHealth(explicitPort, 2_000)) return { port: explicitPort, base: base(explicitPort), source: "--port" };
    throw new NoKernelError(`端口 ${explicitPort} 上没有内核在响应 /api/health`, [
      `确认内核起在哪个端口：lsof -nP -iTCP:${explicitPort} -sTCP:LISTEN`,
      "在本仓库把内核起起来：dove up",
      "换一个端口试：dove health --port 8791",
    ]);
  }

  const envPort = Number(process.env.DOVE_PORT);
  if (Number.isInteger(envPort) && envPort > 0) {
    if (await probeHealth(envPort, 2_000)) return { port: envPort, base: base(envPort), source: "DOVE_PORT" };
    throw new NoKernelError(`DOVE_PORT=${envPort} 上没有内核在响应 /api/health`, [
      "环境变量可能指向了一个没起来的实例；清掉它再试：env -u DOVE_PORT dove health",
      "或者把内核起在这个端口：DOVE_PORT=" + envPort + " dove up",
    ]);
  }

  const fromFile = readPortFile();
  if (fromFile !== null && (await probeHealth(fromFile))) {
    return { port: fromFile, base: base(fromFile), source: `端口文件 ${portFilePath()}` };
  }

  // 并行扫一遍附近的端口：串行探测最坏要等 10 × 600ms，用户会以为命令卡死了
  const ports: number[] = [];
  for (let p = PORT_LO; p <= PORT_HI; p++) ports.push(p);
  const hits = await Promise.all(ports.map(async (p) => ((await probeHealth(p)) ? p : null)));
  const found = hits.find((p): p is number => p !== null);
  if (found !== undefined) return { port: found, base: base(found), source: `扫描 ${PORT_LO}..${PORT_HI}` };

  throw new NoKernelError(`没找到在跑的内核（试过 ${PORT_LO}..${PORT_HI} 与 ${portFilePath()}）`, [
    "把内核起起来：dove up（后台起，日志进 ~/.dove/logs/cli-kernel.log）",
    "或者：cd harness && npm start",
    "内核在别的端口：dove health --port <端口>",
  ]);
}

const base = (port: number): string => `http://127.0.0.1:${port}`;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** 控制面请求都要有超时，否则内核卡住时 CLI 会跟着一起挂 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 发一个 JSON 请求；非 2xx 一律抛 ApiError（调用方用 status 判断，比如 404 的优雅降级） */
export async function api<T = unknown>(t: Target, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(t, path, opts);
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* 不是 JSON 就原样带着 */ }
  if (!res.ok) throw new ApiError(res.status, body, `内核返回 ${res.status}：${path} ${errText(body)}`);
  return body as T;
}

/** 404 当「这个端点还没上线」处理，其余错误照抛 —— 老内核上跑新 CLI 时靠它优雅降级 */
export async function apiOrNull<T = unknown>(t: Target, path: string, opts: RequestOptions = {}): Promise<T | null> {
  try {
    return await api<T>(t, path, opts);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
    throw e;
  }
}

async function send(t: Target, path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const signal = opts.signal ?? (opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : AbortSignal.timeout(30_000));
  try {
    return await fetch(t.base + path, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;      // 调用方主动取消：原样抛，交给上层判断
    const why = e instanceof Error ? (e.name === "TimeoutError" ? "超时" : e.message) : String(e);
    throw new ApiError(0, null, `连不上内核 ${t.base}（${why}）`);
  }
}

/** SSE：POST 之后把响应流原样交出去（不在这里读，长连接不能有总超时） */
export async function openSse(t: Target, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const res = await fetch(t.base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON 就原样 */ }
    throw new ApiError(res.status, parsed, `内核拒绝了这个请求（HTTP ${res.status}）：${errText(parsed)}`);
  }
  return res;
}

function errText(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const k of ["error", "message", "note"]) if (typeof o[k] === "string") return String(o[k]);
  }
  try { return JSON.stringify(body)?.slice(0, 300) ?? ""; } catch { return ""; }
}

export { errText };
