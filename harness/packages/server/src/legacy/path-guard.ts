/**
 * 路径边界判定 —— 兼容层里「能把本机任意文件读出来 / 交给系统打开」的那几条路由共用一份。
 *
 * 为什么单独一个文件：同一段「resolve 判前缀 + realpath 再判一次」写在多处必然漂移，
 * 而这里的漂移不是风格问题 —— 少一处就是一条能读 /etc/hosts 的路由。实测踩过：
 * `/api/projects/{port}/{files,stat,file}` 以前只做 `join(proj.path, sub)`，
 * `?path=../../../../../../etc/hosts` 直接 200 把整份文件吐了出来。
 *
 * 平台差异（实测）：macOS 的 APFS 默认大小写不敏感，而 `realpathSync("/TMP/x")` 会把调用方
 * 给的大小写**原样保留**（不会纠正成 /tmp）—— 纯字符串前缀比较于是把合法路径判成越界（403）。
 * 所以比较前两侧统一 toLowerCase（只在 darwin 上放宽大小写；边界本身不放宽，两侧都来自 realpath）。
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { Services } from "../bootstrap.ts";

/**
 * target 是否在 root 之内（含 root 自己）。
 * 用 relative 而不是字符串 startsWith：`/ws-evil` 以前缀匹配 `/ws` 会**假通过**。
 */
export function inside(root: string, target: string): boolean {
  const fold = (s: string): string => (process.platform === "darwin" ? s.toLowerCase() : s);
  const rel = relative(fold(root), fold(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** realpath；失败（不存在 / 坏软链）返回 null —— 判不了就按不可放行处理，不猜 */
export function realOrNull(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

/**
 * 请求里的相对路径归一化：Windows 上 `\` 也是分隔符，`..\..\x` 与 `../../x` 一样能穿越
 * （Unix 上它只是一个普通字符，归一化之后多出来的那一段会被 resolveInside 判为越界）。
 */
export function normalizeSubPath(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\\/g, "/");
}

export type ProjectPathFail =
  /** 403：越界 / 软链逃逸 —— 硬拒，且**不透露**目标存不存在 */
  | { ok: false; status: 403; message: string }
  /** 404：字面与真实路径都合法，只是不存在 —— 文案由调用方给（三条路由各有各的说法） */
  | { ok: false; status: 404 };
export type ProjectPathVerdict = { ok: true; abs: string } | ProjectPathFail;

/**
 * 项目内相对路径的准入判定（三条文件路由共用）。三道，顺序不能换：
 *   ① `resolve` 之后必须仍在项目根内（core 的 `projects.resolveInside`）—— 字面路径；
 *   ② 存在性：越界连「存不存在」都不告诉调用方，所以 ① 必须先判；
 *   ③ 存在的话再 `realpath` 一次 —— 防的是「项目里放一个软链指向 ~/.ssh/id_rsa」这种逃逸。
 *
 * 返回的 abs 是**没 realpath 过的字面路径**：调用方要拿它算 `relative(proj.path, abs)`（面板
 * 显示的相对路径），换成真实路径会在 macOS 的 `/tmp → /private/tmp` 上算出一串 `../..`。
 */
export function guardInsideProject(svc: Services, projectId: string, sub: string): ProjectPathVerdict {
  const abs = svc.projects.resolveInside(projectId, sub);
  const root = svc.projects.get(projectId)?.path;
  if (!abs || !root) return { ok: false, status: 403, message: `拒绝：路径不在项目工作区内（${sub}）` };
  if (!existsSync(abs)) return { ok: false, status: 404 };
  const realRoot = realOrNull(root) ?? root;
  const real = realOrNull(abs);
  if (!real || !inside(realRoot, real)) {
    return { ok: false, status: 403, message: `拒绝：真实路径不在项目工作区内（${sub}）` };
  }
  return { ok: true, abs };
}
