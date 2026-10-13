/**
 * 「打开方式」的六个动作（纯前端 + 一次服务端调用）—— 卡片、tab、查看器共用一份。
 *
 * 统一在这里的原因：菜单有三个入口（每轮文件卡片的行尾菜单、文件 tab 的右键/菜单、
 * 查看器工具栏），动作实现分散三处必然会漂移（比如只有一处能复制绝对路径）。
 *
 * 每个动作都返回 `{ ok, message }`，**不抛** —— 调用方直接把 message 显示给用户
 * （弹 toast）。失败也会说清为什么，不做静默降级。
 *
 * 三条「读文件字节」的路各自不同，别互相替代（都踩过）：
 *   · 内嵌渲染（img/音视频/PDF）→ 8008 的 `/preview/{port}/…?token=`（跨源，见 preview-url.ts）
 *   · HTML 文档 → 面板同源的 `/api/preview/project/{port}/…`（相对子资源必须同源）
 *   · 下载 / 另存 → 面板同源的 `/api/file/download`（**令牌走头**，点文件也照给）
 */
import { apiFetch, formatBytes, getLocalTokenCached, getPanelOrigin, getProjectInfo, openProjectPath, statProjectFile } from "@/lib/api";
import { projectAssetUrl, projectFileUrl, isHtmlPath } from "@/lib/preview-url";
import { copyText } from "@/lib/clipboard";

export interface ActionResult { ok: boolean; message: string }

/**
 * 单个文件的下载上限（256MB）。
 *
 * 为什么要有：下载这条路是「fetch → res.blob() → objectURL」，**整个文件进面板进程的内存**。
 * 而 `/preview/*` 对任意大小都返回 200（它就是给 iframe 直接加载用的），
 * 于是对着一个 1–2GB 的文件点「下载 / 另存」= 面板 OOM 崩掉。
 * 超过上限的出口写在下一条：用系统默认应用打开 / 在文件管理器里显示。
 */
const DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;

/** 项目根路径缓存（复制绝对路径用）—— 一个端口问一次就够 */
const rootCache = new Map<string, string | null>();

async function projectRoot(port: string): Promise<string | null> {
  if (rootCache.has(port)) return rootCache.get(port) ?? null;
  try {
    const info = await getProjectInfo(port);
    const root = String(info.react_app_path ?? "").replace(/\/+$/, "");
    const value = root || null;
    rootCache.set(port, value);
    return value;
  } catch {
    rootCache.set(port, null);
    return null;
  }
}

/** ① 用系统默认应用打开（走后端 execFile，工作区外一律 403） */
export function openWithSystemApp(port: string | null, path: string): Promise<ActionResult> {
  return openProjectPath({ projectId: port, path, action: "default" });
}

/** ② 在文件管理器里显示（macOS：Finder 里选中该文件） */
export function revealInFileManager(port: string | null, path: string): Promise<ActionResult> {
  return openProjectPath({ projectId: port, path, action: "reveal" });
}

/**
 * ③ 复制路径 —— 优先复制**绝对路径**（粘到终端 / Finder 直接能用），拿不到项目根就复制相对路径。
 *
 * 复制本身走 `lib/clipboard.ts`：`navigator.clipboard` 在**非安全上下文**（面板被
 * 局域网 IP 访问时是 `http://<ip>:8790`）直接是 undefined，以前这里必定失败、
 * 只留一条选不中文字的 toast；现在先走同步的 `execCommand("copy")` 兜底。
 */
export async function copyFilePath(port: string | null, path: string): Promise<ActionResult> {
  const root = port ? await projectRoot(port) : null;
  const text = root ? `${root}/${path.replace(/^\/+/, "")}` : path;
  if (await copyText(text)) return { ok: true, message: `已复制：${text}` };
  // 两条路都失败（无痕 / 未聚焦 / 剪贴板被策略挡掉）时也不能静默：把路径原样显示出来
  return { ok: false, message: `复制失败（剪贴板不可用），路径：${text}` };
}

/**
 * ④ 下载 / 另存。
 *
 * 走**面板同源 + 令牌走头**的 `/api/file/download`，而不是 `<a download href>`：
 *   · 8008 的 `/preview/...?token=` 不行 —— 那条路由**去掉了 CORS**（正是不想让任意网页
 *     读到项目文件），8790 → 8008 的 `fetch` 于是连 `res.blob()` 都拿不到，带令牌也白带；
 *   · `/api/preview/file`（面板同源的预览路由）也不行 —— 它**不过令牌闸门**，所以把点段
 *     一律拒了（`.env` 不许出门），而「用户点下载 `.env`」是已鉴权的合法读取。
 * `/api/file/download` 在令牌闸门之内：同源（响应体读得到）+ 点文件照给。
 *
 * 为什么用 fetch + Blob + objectURL 而不是 `<a download href>`：`download` 属性对**跨源** URL
 * 无效，对同源 URL 虽有效，但拿不到响应头、没法在写入磁盘前做大小闸门。
 *
 * ⚠️ 桌面版的 WKWebView 不一定会弹保存框（<a download> 走的是下载代理，
 * 宿主没接就只是静默无反应）—— 那种情况下用「在文件管理器里显示」自己拖走。
 */
export async function downloadProjectFile(port: string, path: string): Promise<ActionResult> {
  // 先问大小：超上限的直接劝退，连 fetch 都不发（否则就是往内存里灌一个 GB 级 body）
  try {
    const info = await statProjectFile(port, path);
    if (info.size > DOWNLOAD_MAX_BYTES) return { ok: false, message: tooBigMessage(info.size) };
  } catch {
    // stat 拿不到（老内核 / 权限）不挡下载：这一层只是内存闸门，
    // 真下载失败下面还有 HTTP 状态与异常在说，不会静默
  }

  const url = `${getPanelOrigin()}/api/file/download?projectId=${encodeURIComponent(port)}&path=${encodeURIComponent(path)}`;
  try {
    const res = await apiFetch(url, { cache: "no-store" });
    if (!res.ok) return { ok: false, message: `下载失败：HTTP ${res.status}` };
    // 第二道闸：stat 到 fetch 之间文件可能长大了。同源响应**没有** CORS 那套
    // 「安全列表」限制，Content-Length 一定读得到（服务端显式写的那个头）。
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > DOWNLOAD_MAX_BYTES) {
      await res.body?.cancel();   // 别再往内存里灌
      return { ok: false, message: tooBigMessage(declared) };
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = path.split("/").pop() || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    return { ok: true, message: `已开始下载：${a.download}` };
  } catch (e) {
    return { ok: false, message: `下载失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 超上限时的统一说法（给一条能走通的路，而不是只说「失败」） */
function tooBigMessage(size: number): string {
  return `文件太大（${formatBytes(size)}，超过 ${formatBytes(DOWNLOAD_MAX_BYTES)}），请改用「用系统默认应用打开」或「在文件管理器里显示」`;
}

/**
 * ⑤ 新窗口打开（只对能独立渲染的类型有意义，调用方负责判断）。
 *
 * 两种目标 URL，按内容形态分（不是按喜好）：
 *   · HTML → 面板同源的 `/api/preview/project/{port}/…`：它自己的 `./style.css` 是相对 URL，
 *     只有文档与子资源同源才带得动（8008 那条的令牌在查询串里，子资源继承不到 → 整页裸奔）；
 *   · 图片 / PDF / 音视频 → 8008 的 `/preview/{port}/…?token=`：没有相对子资源，
 *     留在跨源那边（新窗口里拿不到面板的 DOM / 免令牌 API）。
 *
 * **不看 `window.open` 的返回值**：带 `noopener` 时规范规定它恒返回 null
 * （见 lib/links.ts 的说明），拿它判成功会让每一次点击都弹一句
 * 「浏览器拦截了新窗口」—— 一句**假的失败**。只有调用本身抛错才算失败。
 */
export function openInNewWindow(port: string, path: string): ActionResult {
  // 令牌只能同步取（见 getLocalTokenCached）：window.open 必须在用户点击的同一个任务里，
  // await 一下就丢了弹窗许可。没取到令牌时不带查询串 —— 那条 401 会显示在窗口里，
  // 而面板顶上的提示条已经在说「没取到令牌」+「重试」。
  const url = isHtmlPath(path) ? projectFileUrl(port, path) : projectAssetUrl(port, path, getLocalTokenCached());
  try {
    window.open(url, "_blank", "noopener,noreferrer");
    return { ok: true, message: "已在新窗口打开" };
  } catch {
    return { ok: false, message: "浏览器拒绝打开新窗口（桌面版可能不支持多窗口）——改用「用系统默认应用打开」" };
  }
}
