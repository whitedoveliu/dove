/**
 * 「谁算面板自己人」—— 决定 `GET /api/local-token` 会不会回显 CORS
 * （跨源页面只有拿到这个头，浏览器才把响应体交给它）。
 *
 * 历史坑：这条以前对**任意 loopback 源**（任意端口）回显 Origin，理由是「开发模式要用」。
 * 于是本机**任何**页面（随便哪个端口的 dev server、任何一个本地服务）都能先读走令牌，
 * 再拿令牌去过 8008 的闸门 —— 而令牌到手 ≈ 内核到手（改模型 base URL / 开回合 / 批工具调用）。
 * 令牌的威胁模型就是「用户开着的任意网页」，那就不能发给任意本机页面。
 *
 * 现在只认两种自己人（其余一律不回 CORS 头）：
 *   ① 同源：Origin 与请求的 Host 逐字相同 —— 桌面壳 / 浏览器直接打开内核托管的界面；
 *   ② 白名单：只有下面这**一个**固定测试端口，或用 DOVE_PANEL_ORIGINS
 *      （逗号分隔，例如 "http://localhost:4100"）显式加进来的源。
 *
 * 为什么不放 `pnpm dev` 的 3006：开发态的面板取令牌走的是 **vite 自己的代理**
 * （control-panel/vite.config.ts 的 server.proxy），对浏览器是**同源**请求，不需要任何 CORS。
 * 而 3000–3099 是**项目 dev server** 的分配区间（core/src/projects/manager.ts 的 #allocPort）——
 * 把 3006 当自己人，就等于给「跑在 3006 的那个项目的页面」发令牌，而那是模型产出的网站。
 *
 * DNS rebinding 不在这条判据的射程里：它用的是外部主机名，Host 校验（routes.ts）先一步挡掉。
 * 这里挡的是「本机其它页面」——它们本来就是 loopback 源，Host 校验对它们无效。
 */
import type { IncomingMessage } from "node:http";

/** 面板自测脚本（scripts/test-control-panel.mjs）的静态服务端口：它拿真 Chrome 加载这个源，页面要跨源取令牌 */
const DEV_PANEL_PORTS = [3055];

/** 三种 host 写法都收：浏览器给 localhost 与 127.0.0.1 会发不同的 Origin */
const PANEL_ORIGINS = new Set<string>([
  ...DEV_PANEL_PORTS.flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`, `http://[::1]:${p}`]),
  ...String(process.env.DOVE_PANEL_ORIGINS ?? "")
    .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
]);

const stripSlash = (s: string): string => s.replace(/\/+$/, "");

/**
 * 是不是「面板自己的源」—— 是就返回该 Origin（调用方据此回显 CORS），否则 null。
 * `Origin: null`（沙箱 iframe、file:// 页面）解不出 host，一律不放行。
 */
export function panelOrigin(req: IncomingMessage): string | null {
  const raw = String(req.headers.origin ?? "").trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (PANEL_ORIGINS.has(stripSlash(raw))) return raw;
  try {
    // Host 的反 rebinding 校验在调用方之前跑（routes.ts），这里只比「是不是同一个源」
    return u.host === new URL("http://" + String(req.headers.host ?? "")).host ? raw : null;
  } catch { return null; }
}
