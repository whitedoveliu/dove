/**
 * 本地令牌 —— 8008 兼容层的准入证（本机页面的安全加固）
 *
 * 威胁：兼容层以前**没有鉴权**，而且对任何网页都回 `Access-Control-Allow-Origin: *` ——
 * 用户开着的任意一个网页都能 POST 到 http://127.0.0.1:8008/api/settings/model
 * 改掉模型 base URL / API key，也能直接开回合。
 *
 * 为什么不用 Origin 白名单：桌面壳里面板的 origin 是 null / file://，
 * 白名单会把 App 自己的保存一起挡掉。所以用**本机令牌**：只有拿得到
 * <DOVE_CONFIG>/api-token 的调用方（面板 / 本机脚本）能过闸。
 *
 * 纪律（改这个文件先读一遍）：
 *   ① 令牌本体只出现在三处：这个文件、`X-Dove-Token` 请求头（或 `?token=` 查询串）、
 *      8790 的 `GET /api/local-token` 响应。**日志里一个字都不许出现** ——
 *      启动日志只说「文件在哪、是不是新生成的」。
 *   ② 文件 0600：同机别的用户读不到。
 *   ③ 比对走 timingSafeEqual，不用 ===（逐字节比较会把前缀泄露出去）。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 32 字节 = 64 个十六进制字符。要求「≥32 个 hex」，这里给到 256 位熵 */
const TOKEN_BYTES = 32;
/** 合法形状：小写十六进制、至少 32 位（手写的老文件也认） */
const TOKEN_SHAPE = /^[0-9a-f]{32,}$/;

export const TOKEN_FILE_NAME = "api-token";

/** 令牌文件：<DOVE_CONFIG>/api-token */
export function tokenFilePath(configDir: string): string {
  return join(configDir, TOKEN_FILE_NAME);
}

/** 读已有的令牌；文件不在 / 读不动 / 内容不是合法形状 → null（调用方重新生成一个） */
export function readTokenFile(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const t = readFileSync(file, "utf8").trim();
    return TOKEN_SHAPE.test(t) ? t : null;
  } catch { return null; }
}

/**
 * 启动时叫它：有合法文件就复用，否则生成一个并落盘 0600。
 *
 * 复用是硬要求 —— 每次启动换令牌，正在开着的旧面板（手里还是上一把）会整块 401，
 * 用户看到的是「面板突然连不上后端」。
 */
export function loadOrMintToken(configDir: string): string {
  const file = tokenFilePath(configDir);
  const existing = readTokenFile(file);
  if (existing) return existing;
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  writeTokenFile(file, token);
  // 只报「生成了文件」，**不报令牌本体**
  console.log(`[dove] 本地 API 令牌已生成：${file}（0600。面板自己取用；本机脚本读这个文件即可）`);
  return token;
}

/** 原子替换 + 显式 chmod 0600（写方与读方可能撞车，半截文件等于没令牌）—— 与 model.json 同一套写法 */
function writeTokenFile(file: string, token: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, token + "\n", { encoding: "utf8", mode: 0o600 });
  // 文件已存在时 writeFileSync 的 mode 不生效（umask 也不一定）→ 显式来一次
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * 请求里带的令牌：优先 `X-Dove-Token` 头（面板的 fetch 走这条），
 * 退 `?token=` 查询串（EventSource 发不了自定义头 —— 会话日志那条 SSE 流就是这种消费者）。
 */
export function requestToken(req: IncomingMessage, url: URL): string {
  const h = req.headers["x-dove-token"];
  const header = Array.isArray(h) ? h[0] : h;
  if (header && header.trim()) return header.trim();
  return (url.searchParams.get("token") ?? "").trim();
}

/** 恒定时间比对；长度不齐直接判否（长度本身不是秘密） */
export function tokenMatches(expected: string, given: string): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
