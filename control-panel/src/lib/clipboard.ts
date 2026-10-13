/**
 * 复制文本 —— 「代码块复制按钮」与「打开方式 → 复制路径」共用一份。
 *
 * 顺序**刻意是「先同步、后异步」**：
 *
 * `document.execCommand("copy")` 已废弃，但它同步、不要求文档焦点、不需要权限，
 * 是 WebKit（Tauri 的 WKWebView、Safari）里最靠得住的一条路；
 * 仓库里 `composer-input.tsx` 处理粘贴时是同样的取舍。
 *
 * `navigator.clipboard` 放后面兜底，因为它在 WebView 里有三个坑：
 *   · 非安全上下文（面板被局域网 IP 访问时是 `http://<ip>:8790`）**直接是 undefined** ——
 *     这就是「复制路径」以前必定失败的原因；
 *   · 文档没焦点时直接 reject；
 *   · 权限策略不满足时**promise 可能一直不 settle** —— 调用方会永远停在「复制中」。
 *     所以这里给一个超时兜底（默认 1.5s），宁可报失败也不要卡住。
 */

/** 同步路径：隐藏 textarea + select + execCommand。成功返回 true */
export function copyViaExecCommand(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 复制文本；两条路都失败返回 false（调用方负责把原因说出来，不许静默） */
export async function copyText(text: string, timeoutMs = 1500): Promise<boolean> {
  if (copyViaExecCommand(text)) return true;
  try {
    const viaApi = navigator.clipboard?.writeText(text);
    if (!viaApi || typeof viaApi.then !== "function") return false;
    return await Promise.race([
      viaApi.then(() => true).catch(() => false),
      new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), timeoutMs)),
    ]);
  } catch {
    return false;
  }
}
