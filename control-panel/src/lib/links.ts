/**
 * 打开外链 —— 正文（markdown-content）与破图降级链（markdown-code）共用一份。
 *
 * 单独成模块的原因：markdown-code 的降级链接也要走这条兜底，而它不能反过来
 * import markdown-content（会成环）。
 *
 * 面板跑在 Tauri 的 WKWebView 里，宿主**没有**注册「新窗口」回调
 * （`apps/desktop/src-tauri/src/lib.rs` 里只有 dialog 插件，没有 navigation /
 * new-window 处理），所以 `target="_blank"` 的请求在宿主里会被直接丢掉。
 * 这里显式 `preventDefault` 后自己调 `window.open` —— 在浏览器里必开，
 * 在宿主里至少是一次**有意识的尝试**，而不是把行为寄托在宿主配置上。
 *
 * 为什么不看 `window.open` 的返回值：带 `noopener` 时规范规定它**恒返回 null**
 * （https://html.spec.whatwg.org/multipage/window-object.html#dom-open），
 * 拿它判成功只会每次都打一行假的「开不出来」。真开不出来在宿主里的表现就是
 * 「点了没反应」，要修得在 Rust 侧加新窗口回调（不在面板的范围内）。
 */
export function openExternal(event: { preventDefault: () => void }, url: string): void {
  event.preventDefault();
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch (error) {
    // 唯一能确认的失败：调用本身抛错（窗口被策略挡掉时 Firefox 会抛）。说清楚，别静默。
    console.warn("[dove] window.open 被拒绝：", url, error);
  }
}
