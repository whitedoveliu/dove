/**
 * 老契约：模型设置路由（面板「设置」对话框的唯一落点，8008）
 *
 * 三条：
 *   GET  /api/settings/model       读设置 —— **永不回 key**，只给 hasKey / keyMasked
 *   POST /api/settings/model       写设置 —— 校验 → 落盘 0600 → 内核**下一轮**就用新的
 *   POST /api/settings/model/test  真打一次最小 completion（15s 超时），只报通/不通
 *
 * 为什么不复用内核自己的 8790 路由：面板写死了 8008（见 lib/api.ts 的 API_BASE_URL），
 * 加在 8790 上面板根本看不见。
 *
 * ⚠️ key 的三条纪律（改这个文件先读一遍）：
 *   ① 出参只有 hasKey / keyMasked —— 任何时候都不把 key 本体写进响应；
 *   ② 日志只打掩码；错误文本里也不许出现（testModelEndpoint 只带状态码和网关原话）；
 *   ③ env / 仓库 env 文件给了的字段是**托管层**：运行期以 env 为准，面板改不动它们，
 *     而且**永远不会落盘**（见 ModelSettingsStore.save，威胁模型见 #write 上方）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "../bootstrap.ts";
import { json, readBody } from "./server.ts";
import { testModelEndpoint, validateBaseUrl } from "../model-settings.ts";

/** 面板「测试」传上来的临时值：允许只测没保存的 key / baseUrl（用户刚敲进去就想试） */
function pickOverrides(b: Record<string, unknown>): { baseUrl?: string; model?: string; apiKey?: string } {
  const out: { baseUrl?: string; model?: string; apiKey?: string } = {};
  if (b.baseUrl !== undefined && b.baseUrl !== null && String(b.baseUrl).trim()) out.baseUrl = String(b.baseUrl).trim();
  if (b.model !== undefined && b.model !== null && String(b.model).trim()) out.model = String(b.model).trim();
  // 空串 = 面板没改 key（它拿不到原值，只能发空串）→ 用存着的那把
  if (b.apiKey !== undefined && b.apiKey !== null && String(b.apiKey).trim()) out.apiKey = String(b.apiKey).trim();
  return out;
}

export async function handleSettingsRoutes(
  path: string, req: IncomingMessage, res: ServerResponse, svc: Services,
): Promise<boolean> {
  if (path !== "/api/settings/model" && path !== "/api/settings/model/test") return false;

  // ── GET /api/settings/model ─────────────────────────
  if (path === "/api/settings/model" && req.method === "GET") {
    json(res, 200, svc.modelSettings.summary());
    return true;
  }

  // ── POST /api/settings/model（保存并立即生效）─────────
  if (path === "/api/settings/model" && req.method === "POST") {
    const b = await readBody(req);
    const r = svc.modelSettings.save({ baseUrl: b.baseUrl, model: b.model, apiKey: b.apiKey });
    if (!r.ok) {
      json(res, 400, { ok: false, error: r.error });
      return true;
    }
    // 只打掩码。baseUrl / model 不是秘密，打出来排查最省事。
    // env 托管的字段顺手标出来：「保存了却没变」的现场全在这一行里。
    const s = r.summary;
    const envNote = s.envFields.length ? `（env 托管、不落盘：${s.envFields.join(" / ")}）` : "";
    console.log(`[dove] 模型设置已更新：baseUrl=${s.baseUrl} model=${s.model} key=${s.keyMasked || "(未设置)"}${envNote}`);
    json(res, 200, { ok: true, ...s });
    return true;
  }

  // ── POST /api/settings/model/test ───────────────────
  if (path === "/api/settings/model/test" && req.method === "POST") {
    const b = await readBody(req);
    const ov = pickOverrides(b);
    const baseUrl = ov.baseUrl ?? svc.modelSettings.baseUrl;
    const model = ov.model ?? svc.modelSettings.model;
    const apiKey = ov.apiKey ?? svc.modelSettings.apiKey;

    // 临时值也要校验：一个手滑打错的 baseUrl 不该被当成「连不上」（那是误导）
    if (ov.baseUrl) {
      const bad = validateBaseUrl(ov.baseUrl);
      if (bad) { json(res, 400, { ok: false, error: bad }); return true; }
    }
    if (!apiKey) { json(res, 200, { ok: false, error: "还没有 API key —— 先填一个再测" }); return true; }

    console.log(`[dove] 测试模型端点：baseUrl=${baseUrl} model=${model}`);   // 不打 key
    json(res, 200, await testModelEndpoint({ baseUrl, model, apiKey }));
    return true;
  }

  json(res, 405, { ok: false, error: `${req.method} 不支持（这条路径只认 GET / POST）` });
  return true;
}
