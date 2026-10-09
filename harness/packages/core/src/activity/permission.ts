/**
 * 屏幕录制权限的**申请**与查询。
 *
 * 踩过的坑：只做「探测截图」判断权限是不够的 ——
 * /usr/sbin/screencapture 在没权限时静默失败，**系统不会因此把 app 加进
 * 「屏幕录制」列表**，用户去设置里翻半天找不到 Dove，只能看到一个
 * 早就作废的旧条目。必须调 CGRequestScreenCaptureAccess() 才会弹窗并登记。
 *
 * 另一个坑：adhoc 签名的 app，TCC 记录绑的是 cdhash ——
 * **每次重新编译再拷贝，之前授的权限就作废**。所以 app 一旦装好、
 * 用户授过权，就不要随便覆盖二进制。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSwiftHelper, run as runCmd } from "../docs/swift.ts";
import { isScreenRecordingAllowed } from "./capture.ts";

const SOURCE = join(import.meta.dirname, "screen-permission.swift");
const PREFIX = "screen-permission";

export interface PermissionResult { ok: boolean; granted?: boolean; error?: string }

async function helper(): Promise<{ ok: boolean; bin?: string; error?: string }> {
  return ensureSwiftHelper({ source: SOURCE, prefix: PREFIX, frameworks: ["CoreGraphics"] });
}

/** 只查询，不弹窗 */
export async function checkScreenPermission(): Promise<PermissionResult> {
  const h = await helper();
  if (!h.ok || !h.bin) return { ok: false, error: h.error ?? "helper 不可用" };
  const r = await runCmd(h.bin, ["check"], { timeoutMs: 15_000 });
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.error || "").slice(0, 200) };
  try { return { ok: true, granted: Boolean((JSON.parse(r.stdout) as { granted?: boolean }).granted) }; }
  catch { return { ok: false, error: "helper 输出无法解析" }; }
}

/**
 * 记住「已经问过权限了」的标记文件。
 *
 * 为什么需要：CGRequestScreenCaptureAccess() 在权限「未决定」时会**每次调用都弹窗**。
 * 原来我写成每次启动都申请 —— 用户只要没点「允许」，就会**每次开 App 都被弹一次**，
 * 非常烦。权限申请本来就该是**一次性**的：问过一次就记住，
 * 之后只在日志里给引导，等用户主动去系统设置开。
 */
function askedMarker(configDir: string): string {
  return join(configDir, "activity", ".screen-permission-asked");
}

function hasAsked(configDir: string): boolean {
  try { return existsSync(askedMarker(configDir)); } catch { return false; }
}

function markAsked(configDir: string): void {
  try {
    const p = askedMarker(configDir);
    mkdirSync(join(configDir, "activity"), { recursive: true });
    writeFileSync(p, JSON.stringify({ askedAt: new Date().toISOString() }) + "\n");
  } catch { /* 写不进去也不能挡住启动 */ }
}

/** 用户想重新申请时清掉标记（面板按钮 / CLI 用） */
export function resetAskedMarker(configDir: string): void {
  try { if (existsSync(askedMarker(configDir))) rmSync(askedMarker(configDir)); } catch { /* ignore */ }
}

/**
 * 启动时的权限流程。
 *
 * **只在第一次问**：探测有权限就直接过；没权限且**从没问过**才弹窗；
 * 问过之后就只返回状态，让上层写日志引导。
 *
 * @returns granted    是否拿到权限
 *          asked      本次是否弹了申请
 *          everAsked  历史上问过没有（用于决定提示语气）
 */
export async function ensureScreenPermission(
  configDir: string,
): Promise<{ granted: boolean; asked: boolean; everAsked: boolean; error?: string }> {
  try {
    if (await isScreenRecordingAllowed()) return { granted: true, asked: false, everAsked: hasAsked(configDir) };
  } catch { /* 探测失败继续 */ }

  if (hasAsked(configDir)) {
    // 问过了还没权限 —— 说明用户拒了或还没去系统设置开。**不要再弹**。
    return { granted: false, asked: false, everAsked: true };
  }

  const r = await requestScreenPermission();
  markAsked(configDir);
  if (r.ok && r.granted) return { granted: true, asked: true, everAsked: true };
  return { granted: false, asked: Boolean(r.ok), everAsked: true, ...(r.error ? { error: r.error } : {}) };
}

/**
 * 把权限结果拼成给用户看的一句话。
 * 区分两种情况：**刚弹过窗**（叫他去点）vs **早就问过还没开**（只提醒，不再打扰）。
 */
export function screenPermissionNote(
  prev: string | undefined, perm: { granted: boolean; asked: boolean; everAsked?: boolean }, hint: string,
): string {
  let note = prev;
  if (!perm.granted && perm.asked) {
    note = `${note ? note + "；" : ""}已弹出权限申请，同意后需重启 Dove`;
  } else if (!perm.granted && perm.everAsked) {
    note = `${note ? note + "；" : ""}（之前已申请过，不再重复弹窗；需要时去系统设置里手动打开）`;
  }
  if (!perm.granted) note = `${note ? note + "；" : ""}${hint}`;
  return note ?? "";
}

/**
 * 申请权限 —— **会弹系统提示**。
 * 已经决定过（同意或拒绝）时不会再弹，直接返回当前状态；
 * 此时只能引导用户去系统设置里手动改。
 */
export async function requestScreenPermission(): Promise<PermissionResult> {
  const h = await helper();
  if (!h.ok || !h.bin) return { ok: false, error: h.error ?? "helper 不可用" };
  const r = await runCmd(h.bin, ["request"], { timeoutMs: 60_000 });
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.error || "").slice(0, 200) };
  try { return { ok: true, granted: Boolean((JSON.parse(r.stdout) as { granted?: boolean }).granted) }; }
  catch { return { ok: false, error: "helper 输出无法解析" }; }
}
