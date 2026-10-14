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
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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

export type OpenTargetVerdict =
  | { ok: true; /** realpath 之后的路径 —— 交给 execFile 的就是它 */ abs: string; isDir: boolean }
  | { ok: false; status: 403 | 404; message: string };

/**
 * 从若干候选根里挑「目标落在哪个根里」，都不沾返回 null。
 *
 * 为什么需要（真需求）：设置里的「打开记忆文件夹」要开的是 `DOVE_CONFIG`（默认 `~/.dove`），
 * 它在工作区（`~/DoveProjects`）**之外** —— 只按工作区判会 403。
 * 挑根**不是放宽边界**：挑中的那个根照样要过下面那三道闸（字面 → 存在 → realpath）。
 * 判据用 realpath（拿不到真实路径就退回字面），否则「工作区里放个软链指向 ~/.dove」这种会挑错根。
 */
export function pickOpenRoot(roots: readonly string[], raw: string, base: string): string | null {
  const want = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  const real = realOrNull(want);
  for (const root of roots) {
    const realRoot = realOrNull(root) ?? root;
    if (inside(realRoot, real ?? want) || inside(root, want)) return root;
  }
  return null;
}

/**
 * 「把这个路径交给系统应用」那几条路由的准入判定（`/api/open-path` 与 `/api/open-in-app` **共用这一份**）。
 *
 * 与 guardInsideProject 的区别：这里的入参是**面板给的路径**（可能是项目内相对路径，也可能是绝对路径），
 * 所以先按根解析；边界还是那三道，顺序不能换：
 *   ① 字面路径 resolve 之后必须在根内 —— 越界连「存不存在」都不告诉调用方；
 *   ② 存在性；
 *   ③ 真实路径（realpath）也必须落在根内 —— 防「工作区里放个软链指向 ~/.ssh/id_rsa」。
 *
 * 为什么要抽出来：这两条路由都会**真的在本机执行 `open`**，边界判定写两份必然漂移，
 * 而漂移一次就是一条能打开任意文件的路由。
 */
export function guardOpenTarget(rootAbs: string, raw: string, label = "项目工作区"): OpenTargetVerdict {
  const target = isAbsolute(raw) ? resolve(raw) : resolve(rootAbs, raw);

  // ① 字面路径判定
  if (!inside(rootAbs, target)) {
    return { ok: false, status: 403, message: `拒绝：路径不在${label}内（${target}）` };
  }
  if (!existsSync(target)) {
    return { ok: false, status: 404, message: `文件不存在：${target}` };
  }

  // ③ 软链逃逸：真实路径必须也落在界内
  const rootReal = realOrNull(rootAbs) ?? rootAbs;
  const targetReal = realOrNull(target);
  if (!targetReal || !inside(rootReal, targetReal)) {
    return { ok: false, status: 403, message: `拒绝：真实路径不在${label}内（${targetReal ?? target}）` };
  }

  let isDir = false;
  try { isDir = statSync(targetReal).isDirectory(); } catch { /* 已经 existsSync 过，这里只是拿目录判定 */ }
  return { ok: true, abs: targetReal, isDir };
}
