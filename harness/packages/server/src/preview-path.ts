/**
 * 预览路由共用的路径规则 —— 「点段」（`.env`、`.git/config`、`.ssh/…`）一律不服务。
 *
 * 为什么单独一个文件：**两条预览路由是同一份契约的两半** ——
 *   · 8008 的 `/preview/{port}/{rel}`（legacy/server.ts，给「发不了自定义头的标签」用）
 *   · 8790 的 `/api/preview/file/*` 与 `/api/preview/project/*`（routes-preview.ts，面板同源）
 * 同一份规则写两遍必然漂移，而这里的漂移是「一条路由拒、另一条把 .env 发出去」。
 * 面板侧现在以 8790 那条为主（相对子资源必须同源），所以这两处必须逐字同口径。
 *
 * 判两遍（原样 + 解码后）：`%2e%2e` 这种编码写法不能靠「URL 解析器不认编码点」赌它无害，
 * 也不能因为解不开（坏编码）就放行 —— 解不开也拒，宁可 403 一个畸形 URL。
 */
export function hasDotSegment(rel: string): boolean {
  const segs = (s: string): string[] => s.split("/").filter(Boolean);
  if (segs(rel).some((s) => s.startsWith("."))) return true;
  let decoded = "";
  try { decoded = decodeURIComponent(rel); } catch { return true; }
  return decoded !== rel && segs(decoded).some((s) => s.startsWith("."));
}

/**
 * 预览文档的沙箱 —— 「能在浏览器里跑起来的文档」（html / svg / xml）一律加这个响应头。
 *
 * **这份是唯一的定义**（两条预览路由 + 外站代理都 import 它）。面板侧的 iframe `sandbox`
 * 属性是同一件事的复述，但**只有这个响应头能管住顶层文档**（「在新窗口打开」/ 直接粘 URL
 * 打开时没有 iframe 属性可依靠）；反过来，光有属性没有头也不行 —— 换个入口就绕开了。
 *
 * 为什么不带 `allow-same-origin`（这个仓库真栽过的坑）：预览的文档是**模型写出来的产物**，
 * 而项目 HTML 走的是**面板同源**的 `/api/preview/project/…`（相对子资源必须同源才解析得对）。
 * 带上 allow-same-origin，那份 HTML 就是面板的同源文档：`fetch('/api/local-token')`
 * 直接读走令牌（同源不受 CORS 约束）→ 改模型 base URL / 开回合 / 批工具调用全都做得到；
 * 外站代理更糟 —— 用户随手打开的任何公网页面都拿到这份权限。去掉它 = 文档落进 opaque origin：
 * 同源读取、`parent.document`、localStorage 全断，而 `<img>` / CSS / 经典 `<script src>`
 * （no-CORS 加载）照常工作。
 *
 * 代价（改之前先读一遍）：opaque origin 下的 **CORS 模式**加载会失败 —— 相对路径的
 * `fetch()` / `XMLHttpRequest`、`<script type="module">`、`@font-face` 的本地字体。
 * 预览里要完整跑这类页面，用「运行开发服务器」（那是项目自己的源，不受这里影响）。
 */
export const PREVIEW_DOC_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** 哪些 Content-Type 算「能在浏览器里跑起来的文档」（要加 PREVIEW_DOC_CSP 的那一批） */
export function isRunnableDoc(contentType: string): boolean {
  return /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)\b/i.test(contentType);
}
