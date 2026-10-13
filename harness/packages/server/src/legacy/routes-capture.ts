/**
 * 老契约：区域截屏（面板输入框「+」菜单里的「截屏」）
 *
 * 语义：**一次性、按需**。用户点一下 → macOS 自己画十字让他框选 → 一张 PNG 回给面板。
 * 这里没有任何定时 / 循环采样：截完就结束；临时文件在 finally 里删掉；
 * **不落库、不写配置目录、不进记忆**（这条是硬要求，别在别的路径上"顺手存一份"）。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "./server.ts";

/** 图片上限 6 MiB：超过这个大小的 PNG 已经不是「框一块屏」，多半是误截了整屏 / 多屏 */
export const CAPTURE_MAX_BYTES = 6 * 1024 * 1024;
/** 框选超时：用户迟迟不选就当他放弃了（进程被杀 → 按取消处理，见下） */
export const CAPTURE_TIMEOUT_MS = 120_000;

export interface CaptureDeps {
  /** 测试注入：非 darwin 走「不支持」分支，不用真截屏 */
  platform?: NodeJS.Platform;
  /** 测试注入：true = 拿到了图；false = 取消 / 非零退出 */
  run?: (file: string) => Promise<boolean>;
}

export type CaptureOutcome =
  | { ok: true; data: string; bytes: number }
  | { ok: false; cancelled: true }
  | { ok: false; status: 501 | 413; error: string };

/**
 * 真跑 screencapture。
 *
 * ⚠️ **非零退出（进程被超时杀掉、没有屏幕录制权限等）一律当「用户取消」**：
 *    对面板来说正确反应都是"什么都不做"，硬做成 error 只会在界面上多一条用户看不懂的红条。
 *    Esc 不止走这条路 —— 见 captureRegion 里对「退出码 0 + 空文件」的说明。
 */
function runScreencapture(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("screencapture", ["-i", "-x", file], { timeout: CAPTURE_TIMEOUT_MS }, (err) => resolve(!err));
  });
}

/** 截一次图：跑 screencapture → 读文件 → 判大小 → base64；任何路径都不留临时文件 */
export async function captureRegion(deps: CaptureDeps = {}): Promise<CaptureOutcome> {
  if ((deps.platform ?? process.platform) !== "darwin") {
    return { ok: false, status: 501, error: "只有 macOS 支持框选截屏" };
  }

  // 临时文件放系统临时目录：绝不落到用户的配置目录 / 项目目录里
  const dir = mkdtempSync(join(tmpdir(), "dove-capture-"));
  const file = join(dir, "screenshot.png");
  try {
    if (!(await (deps.run ?? runScreencapture)(file))) return { ok: false, cancelled: true };

    const bytes = existsSync(file) ? statSync(file).size : 0;
    // 拿不到图 = **取消**，不是错误。这里处理的是「退出码 0 但结果是空的」那一半：
    // 实测这台机器上，按 Esc 结束框选时 screencapture **退出码 0 + 一个 0 字节文件**。
    // 按 500 报的话，用户每按一次 Esc 面板就弹一条红条 —— 取消是正常操作，必须安静。
    //
    // ⚠️ 退出码分不出来的歧义：没有屏幕录制权限时也可能留下空结果（那种情况通常带
    //    非零退出码，但不保证）。也就是说「权限缺失」在少数情况下会表现为**静默无反应**，
    //    而不是一条错误 —— 这是为「取消必须安静」付的代价，暂时接受。
    //    要排查就去 系统设置 → 隐私与安全性 → 屏幕录制 看 Dove / 终端有没有被勾上。
    if (bytes === 0) return { ok: false, cancelled: true };
    if (bytes > CAPTURE_MAX_BYTES) return { ok: false, status: 413, error: "截屏太大（超过 6 MB）" };
    return { ok: true, data: readFileSync(file).toString("base64"), bytes };
  } finally {
    // 成功 / 取消 / 空结果 / 超大 / 中途抛错 —— 全部走这里，临时文件一个都不留
    rmSync(dir, { recursive: true, force: true });
  }
}

/** POST /api/capture：面板不发 body；deps 只给测试注入用（生产走真截图） */
export async function handleCaptureRoutes(
  path: string, req: IncomingMessage, res: ServerResponse, deps?: CaptureDeps,
): Promise<boolean> {
  if (path !== "/api/capture" || req.method !== "POST") return false;
  req.resume();   // 没有 body 也要排空：否则 keep-alive 连接上的下一条请求会被吊住

  const out = await captureRegion(deps);
  if (out.ok) { json(res, 200, { ok: true, name: "screenshot.png", mediaType: "image/png", data: out.data }); return true; }
  if ("cancelled" in out) { json(res, 200, { ok: false, cancelled: true }); return true; }
  json(res, out.status, { ok: false, error: out.error });
  return true;
}
