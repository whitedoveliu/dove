/**
 * 权限路由（从 routes-project.ts 抽出来，那边超 400 行了）
 *
 * 权限模型 = 两轴（sandbox × approval），定义与预设表都在 core 的 tools/permission.ts ——
 * 这里只做 HTTP 适配，**预设表不再复制一份**（原来 server 与面板各存一份，加一档要改两处）。
 *
 * 存储在线程 metadata（不是全局设置）—— 权限是"这次对话能干多少"，换个任务可能就想放宽或收紧。
 * **双读双写**：新字段 `permission`（profile）优先，旧字段 `permissionMode` / `readOnly` 仍然兼容，
 * 老面板只认 `mode` 时由 profile 反推一个最接近的档位（见 legacyModeOf）。
 */
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "../bootstrap.ts";
import { json, readBody, findProjectByKey } from "./server.ts";
import {
  PERMISSION_PRESETS, normalizeProfile, legacyModeOf, normalizePermissionMode,
  DEFAULT_PERMISSION_MODE, type PermissionProfile,
} from "../../../core/src/tools/permission.ts";

/** 可写目录的入参校验：只收绝对路径（`~/` 展开）；相对路径直接丢掉 —— 它相对哪个 cwd 都是歧义 */
function cleanRoots(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const s = r.trim();
    if (!s) continue;
    if (s === "~" || s.startsWith("~/")) out.push(path.join(os.homedir(), s.slice(s === "~" ? 1 : 2)));
    else if (path.isAbsolute(s)) out.push(s);
  }
  return [...new Set(out)];
}

export async function handlePermissionRoutes(
  path: string, _url: URL, req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  // ── GET /api/permission-presets（B4）───────────────
  if (path === "/api/permission-presets" && req.method === "GET") {
    json(res, 200, { success: true, default: DEFAULT_PERMISSION_MODE, presets: PERMISSION_PRESETS });
    return true;
  }

  const m = /^\/api\/projects\/([^/]+)\/permission$/.exec(path);
  if (!m || (req.method !== "GET" && req.method !== "POST")) return false;

  // 三键查找（端口 → 项目 id → 目录名），顺序和删除路由**完全一致**。
  // ⚠️ 只认端口不够：前端拿到的可能是 project.id，Number("pmuxxx") = NaN → 404 → 静默失败，
  //    表现出来就是「选了权限但没生效」。查找逻辑已抽到 server.ts 的 findProjectByKey ——
  //    权限 / 目标 / 插话三条路由共用同一份，避免哪天改一处漏一处。
  const key = decodeURIComponent(m[1]!);
  const proj = findProjectByKey(svc, key);
  if (!proj) { json(res, 404, { success: false, message: "项目不存在（" + key + "）" }); return true; }
  const thread = svc.store.listThreads("project").find((t) => t.projectId === proj.id);
  if (!thread) { json(res, 404, { success: false, message: "项目线程不存在" }); return true; }

  if (req.method === "POST") {
    const b = await readBody(req);
    const cur = normalizeProfile(thread.metadata);
    const next: PermissionProfile = { sandbox: cur.sandbox, approval: cur.approval, writableRoots: [...cur.writableRoots] };
    let touched = false;

    // ① 旧前端：整个档位（mode）—— 按预设绑定一次把两根轴都设好
    if (b.mode !== undefined) {
      const mode = normalizePermissionMode(b.mode);            // 旧别名 full / workspace / readonly 也认
      const preset = PERMISSION_PRESETS.find((p) => p.value === mode) ?? PERMISSION_PRESETS[1]!;
      next.sandbox = preset.profile.sandbox;
      next.approval = preset.profile.approval;
      touched = true;
    }
    // ② 新前端：按轴改（profile.sandbox / profile.approval 任给其一）
    if (b.profile !== undefined && b.profile !== null && typeof b.profile === "object") {
      const raw = b.profile as Record<string, unknown>;
      const merged = normalizeProfile({ permission: { sandbox: next.sandbox, approval: next.approval, writableRoots: next.writableRoots, ...raw } });
      next.sandbox = merged.sandbox;
      next.approval = merged.approval;
      touched = true;
    }
    // ③ 额外可写目录（绝对路径；相对路径一律丢弃，见 cleanRoots）
    if (b.writableRoots !== undefined) {
      next.writableRoots = cleanRoots(b.writableRoots);
      touched = true;
    }

    const patch: Record<string, unknown> = {};
    if (touched) {
      patch.permission = next;
      // readOnly 是更老的布尔字段：**继续一起写**（老内核/老读者还在读它），新读者读 permission
      patch.readOnly = next.sandbox === "read-only";
    }
    // ── 计划模式（B5）────────────────────────────────
    // 人类在输入框打 /plan → 面板调这里。它**不改权限档**，只让运行时
    // 把写类工具从工具表里裁掉（照 Dove 的原则：计划模式是硬只读，不是软提示）。
    if (typeof b.planMode === "boolean") patch.planMode = b.planMode;
    if (!touched && patch.planMode === undefined) {
      json(res, 400, { success: false, message: "至少给 mode / profile / writableRoots / planMode 之一" });
      return true;
    }
    svc.store.updateThread(thread.id, { metadata: { ...thread.metadata, ...patch } });
  }

  const meta = svc.store.getThread(thread.id)?.metadata ?? {};
  const profile = normalizeProfile(meta);
  json(res, 200, {
    success: true,
    mode: legacyModeOf(profile),      // 旧前端只认 mode —— 由 profile 反推一个最接近的档位
    planMode: meta.planMode === true,
    profile,                          // 新前端读这个（sandbox / approval / writableRoots）
  });
  return true;
}
