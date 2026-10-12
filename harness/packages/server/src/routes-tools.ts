/**
 * 工具控制面（PTC 的回调口）：脚本里的 doveTool / listTools 打的就是这两个路由。
 *
 * 安全纪律（**这里必须比别处严**，因为内核没有鉴权中间件）：
 *  ① 只认回环地址 —— 内核本来就只 listen 127.0.0.1，这里再挡一层，
 *     免得将来有人把它挂到 0.0.0.0 上就变成「任何人可远程执行工具」；
 *  ② **invoke 必须**匹配一个活着的脚本会话（RunScript 打开、脚本退出即关）。
 *     **不匹配就拒绝** —— 绝不学 Alma 的「不带就退化成全部工具」：
 *     那等于给本机任何进程一个无审批的工具执行口，比 Bash 还松。
 *  ③ 这里只做校验与转发，真正的执行在 core（run-services 注入的 invoke → executeOne），
 *     所以审批 / 输出预算 / 事件上报一条都不会绕过。
 *
 * ⚠️ **list 与 invoke 不是一个信任级别**（这一条是踩出来的）：
 *   一开始 list 也要 session/token，结果是 `dove tools` 永远只能降级 —
 *   名字/描述是只读元数据（模型每轮的 system prompt 里本来就有），
 *   而执行才是能力。所以 list 在回环上**不带凭据也给**（与 /api/threads、/api/config 同档），
 *   invoke 仍然一个口都不松。带了凭据的 list 走脚本会话视图（不含 RunScript，不开递归）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Services } from "./bootstrap.ts";
import { toolLayer, allTools } from "../../core/src/tools/registry.ts";
import { ptcSessionTools, ptcSessionInvoke } from "../../core/src/tools/builtin/run-script.ts";

type Body = () => Promise<Record<string, unknown>>;
type Json = (res: ServerResponse, code: number, data: unknown) => void;

/** 只放回环：::1 / 127.0.0.1 / IPv4-mapped */
function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** 返回 true 表示这个请求已被处理 */
export async function handleToolRoutes(
  path: string, url: URL, req: IncomingMessage, res: ServerResponse,
  _svc: Services, json: Json, readBody: Body,
): Promise<boolean> {
  if (path !== "/api/tools/list" && path !== "/api/tools/invoke") return false;

  if (!isLoopback(req)) { json(res, 403, { error: "工具控制面只接受回环地址的请求" }); return true; }

  // ── 列工具：脚本里的 listTools() / CLI 的 `dove tools`（session/token 走 query，与 Alma 的形态一致） ──
  if (path === "/api/tools/list" && req.method === "GET") {
    const session = url.searchParams.get("session") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const describe = (t: { name: string; description: string; parameters?: unknown }) => ({
      name: t.name, description: t.description, inputSchema: t.parameters, layer: toolLayer(t.name),
    });
    // 不带凭据 = 外部 CLI 在问清单（只读）。带凭据 = 脚本会话视图（不含 RunScript，不开递归）。
    if (!session && !token) {
      json(res, 200, { tools: allTools().map(describe) });
      return true;
    }
    const r = ptcSessionTools(session, token);
    if (!r.ok) { json(res, 403, { error: r.error }); return true; }
    json(res, 200, { tools: r.tools.map(describe) });
    return true;
  }

  // ── 调工具：脚本里的 doveTool(name, args) ──
  if (path === "/api/tools/invoke" && req.method === "POST") {
    const b = await readBody(req);
    const session = String(b.session ?? "");
    const token = String(b.token ?? "");
    const name = String(b.name ?? "");
    if (!session || !token) {
      json(res, 403, { error: "缺少 session/token：工具控制面只在脚本会话里可用（不带凭据不给调用）" });
      return true;
    }
    if (!name) { json(res, 400, { error: "缺少工具名 name" }); return true; }
    const r = await ptcSessionInvoke(session, token, name, b.args);
    // 凭据不对 = 鉴权失败 → 403（和上面「不带凭据」一个口径）。
    // 未知工具 / 工具内部报错 → 200 + {error}：那是**调用语义**上的失败，脚本侧统一 throw。
    // 两者混用会让「拿假凭据探测」在日志里看起来像一次成功的调用。
    if (!r.ok && r.auth) { json(res, 403, { error: r.error }); return true; }
    json(res, 200, r.ok ? { result: r.result } : { error: r.error });
    return true;
  }

  return false;
}
