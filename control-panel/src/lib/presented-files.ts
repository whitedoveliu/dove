/**
 * 交付物（Present 工具）解析 —— 纯函数，不依赖 React / DOM，方便单独验证。
 *
 * 数据来源只有消息里**已有**的 tool 事件（tool_start / tool_info / tool_params /
 * tool_result），不新增任何 SSE 事件类型 —— 这样实时流和刷新后的历史回放
 * 走的是同一条解析路径。
 *
 * 兼容层（harness/packages/server/src/legacy/sse-compat.ts）实时流每个工具发：
 *     tool_start{tool} → tool_info{info} → tool_params{tool, params} → tool_result{tool, result}
 * 历史回放（routes-project-parts.ts）只发 tool_info{tool, info}，
 * 所以 params 之外还留了 result / info 两条兜底。
 */

/** 一个交付物：路径 + 可选说明 */
export interface PresentedFile {
  path: string;
  description?: string;
}

/** 解析只需要这几个字段 —— 结构化声明，便于单测直接喂假事件 */
export interface PresentedFileEventLike {
  type?: string;
  tool?: string;
  info?: string;
  params?: Record<string, unknown>;
  result?: string;
}

/** 工具名归一化：小写 + 去掉空格 / 下划线 / 连字符（`Present` / `present` 都认） */
export function normalizeToolName(tool?: string | null): string {
  return String(tool ?? "").toLowerCase().replace(/[\s_-]/g, "");
}

/** 是不是 Present（交付物声明）工具 */
export function isPresentTool(tool?: string | null): boolean {
  return normalizeToolName(tool) === "present";
}

/**
 * 路径归一化：去首尾空白与成对引号 / 反引号、反斜杠转正斜杠、去掉 "./" 前缀。
 * 只做字符串层面的整理，不做路径解析（前端拿不到项目根）。
 */
export function normalizeProjectPath(path: string): string {
  let out = String(path ?? "").trim();
  out = out.replace(/^[`'"]+/, "").replace(/[`'"]+$/, "").trim();
  out = out.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/**
 * 从各种形状的 files 值里抽出交付物：数组 / JSON 字符串 / 字符串数组 / {path,description}。
 * 返回 null 表示「压根不是一个 files 数组」——调用方靠它区分「解析失败」和「确实是空的」。
 */
function readFilesValue(raw: unknown): PresentedFile[] | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  const out: PresentedFile[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const path = normalizeProjectPath(item);
      if (path) out.push({ path });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? normalizeProjectPath(record.path) : "";
    if (!path) continue;
    const description =
      typeof record.description === "string" && record.description.trim()
        ? record.description.trim()
        : undefined;
    out.push(description ? { path, description } : { path });
  }
  return out;
}

/** params.files（Present 的入参）；不是数组就当没有 */
function readFilesFromParams(params: unknown): PresentedFile[] {
  if (!params || typeof params !== "object") return [];
  try {
    return readFilesValue((params as Record<string, unknown>).files) ?? [];
  } catch {
    return [];
  }
}

/**
 * tool_result：内核 Present 的返回值是 { presented, files:[{path,description,bytes}], ... }，
 * 而这里的 path 是**工作目录相对路径**（参数里可能是绝对路径），所以只要解析得出来就以它为准。
 * 返回 null = 解析不出来（比如兼容层把结果截断到 500 字符），此时保留参数里的那份。
 */
function readFilesFromResult(result: unknown): PresentedFile[] | null {
  if (typeof result !== "string" || !result.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    if (!parsed || typeof parsed !== "object") return null;
    return readFilesValue((parsed as Record<string, unknown>).files);
  } catch {
    return null;
  }
}

/**
 * 一行文本是不是「像路径」——只用于历史回放的 tool_info 兜底。
 * 规则：没有 URL scheme、不含换行、带 "/" 或有扩展名。
 */
function looksLikeFilePath(line: string): boolean {
  const text = line.trim();
  if (!text || text.length > 400) return false;
  if (/[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return false;   // http:// 之类
  if (!/^[^\s\/]+(?:[\/][^\s\/]+)*$/.test(text)) return false;  // 只允许 段/段/段
  return text.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(text);
}

/**
 * 去重 + 合并：
 *   ① 路径完全相同的合成一个（后出现的非空 description 补上前面的空说明）
 *   ② 一个是另一个的后缀时也合并 —— 内核 Present 的**参数**可能是绝对路径
 *      （/Users/.../proj/report.md），而**返回值**里是工作目录相对路径
 *      （report.md），不合并就会为同一个文件渲染两张卡片。
 *      保留短的那个：预览接口只吃项目内相对路径。
 */
function dedupe(files: PresentedFile[]): PresentedFile[] {
  const exact: PresentedFile[] = [];
  const seen = new Map<string, number>();
  for (const file of files) {
    const at = seen.get(file.path);
    if (at === undefined) {
      seen.set(file.path, exact.length);
      exact.push(file);
      continue;
    }
    const prev = exact[at]!;
    if (!prev.description && file.description) exact[at] = { path: prev.path, description: file.description };
  }

  const out: PresentedFile[] = [];
  for (const file of exact) {
    const at = out.findIndex(
      (prev) => prev.path === file.path || prev.path.endsWith("/" + file.path) || file.path.endsWith("/" + prev.path)
    );
    if (at === -1) {
      out.push(file);
      continue;
    }
    const prev = out[at]!;
    const keep = file.path.length < prev.path.length ? file : prev;
    const other = keep === file ? prev : file;
    const description = keep.description || other.description;
    out[at] = description ? { path: keep.path, description } : { path: keep.path };
  }
  return out;
}

/**
 * 从一条消息的 events 里抽出所有 Present 交付物。
 *
 * 认得的形状（按优先级）：
 *   1. tool_params{tool:"Present", params:{files:[{path, description?}]}}   ← 主路径（实时流）
 *   2. tool_start{tool:"Present", params/input 上带 files}                  ← 某些路径把参数塞在 start 上
 *   3. tool_result{tool:"Present", result:"{...files...}"}                  ← params 缺失时兜底
 *   4. tool_info{tool:"Present", info:"a.md\nb.md"}                        ← 历史回放兜底（兼容层只发 info）
 *
 * 任何一步都不抛错：不认识 / 解析失败 = 跳过。
 *
 * 「一次 Present 调用」的边界：tool_start 起、tool_result 止（没有 result 就以
 * 下一个 tool_start 或事件流结束为止）。result 能解析时**以 result 为准** ——
 * 里面的路径是相对工作目录的、而且是内核校验过确实存在的。
 */
export function extractPresentedFiles(
  events: readonly PresentedFileEventLike[] | null | undefined
): PresentedFile[] {
  if (!events || typeof events.length !== "number" || events.length === 0) return [];
  const found: PresentedFile[] = [];
  /** 当前这次 Present 调用收集到的文件（参数侧，等 result 来覆盖） */
  let pending: PresentedFile[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    found.push(...pending);
    pending = [];
  };
  /** 供不带 tool 字段的 tool_info 归属（实时流的 tool_info 就没有 tool） */
  let currentTool: string | undefined;

  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as PresentedFileEventLike & { input?: Record<string, unknown> };
    const type = String(event.type ?? "");
    if (type === "tool_start" || type === "tool_info") {
      if (event.tool) currentTool = event.tool;
    }
    const tool = event.tool || currentTool;
    if (!isPresentTool(tool)) {
      // 别的工具开始了 → 上一次 Present 调用（没有 result）就此结束
      if (type === "tool_start") flush();
      continue;
    }

    try {
      if (type === "tool_params") {
        pending.push(...readFilesFromParams(event.params));
      } else if (type === "tool_start") {
        flush();
        pending.push(...readFilesFromParams(event.params ?? event.input));
      } else if (type === "tool_info") {
        for (const line of String(event.info ?? "").split("\n")) {
          if (!looksLikeFilePath(line)) continue;
          const path = normalizeProjectPath(line);
          if (path) pending.push({ path });
        }
      } else if (type === "tool_result") {
        // 解析得出来就以返回值（相对路径、已校验存在）为准；哪怕是空数组 = 什么都没声明。
        // 说明文字如果返回值里没有（比如被截断），从参数里按路径补回来。
        const fromResult = readFilesFromResult(event.result);
        if (fromResult) {
          pending = fromResult.map((file) => {
            const param = pending.find(
              (p) => p.path === file.path || p.path.endsWith("/" + file.path) || file.path.endsWith("/" + p.path)
            );
            const description = file.description || param?.description;
            return description ? { path: file.path, description } : { path: file.path };
          });
        }
        flush();
      }
    } catch {
      /* 单个事件解析失败不影响其它交付物 */
    }
  }
  flush();
  return dedupe(found);
}

/** 路径最后一段（卡片标题） */
export function basenameOf(path: string): string {
  const normalized = normalizeProjectPath(path);
  const at = normalized.lastIndexOf("/");
  return at >= 0 ? normalized.slice(at + 1) || normalized : normalized;
}

/** 扩展名（小写、不带点）；没有则为空串 */
export function extensionOf(path: string): string {
  const name = basenameOf(path);
  const at = name.lastIndexOf(".");
  return at > 0 && at < name.length - 1 ? name.slice(at + 1).toLowerCase() : "";
}

/** 没有 description 时的说明文字：扩展名大写，再不行「文件」 */
export function fileDescription(file: PresentedFile): string {
  const described = (file.description ?? "").trim();
  if (described) return described;
  const ext = extensionOf(file.path);
  return ext ? ext.toUpperCase() : "文件";
}

/**
 * 正文里的 inline-code 路径是否命中某个交付物。
 * 先比归一化后的全等，再比「后缀相等」——交付物可能给的是绝对路径，
 * 而正文里写的是项目内相对路径（反之亦然）。
 */
export function matchPresentedPath(
  text: string,
  files: readonly PresentedFile[]
): PresentedFile | null {
  const target = normalizeProjectPath(text);
  if (!target || !files || !files.length) return null;
  for (const file of files) {
    if (file.path === target) return file;
  }
  const suffix = "/" + target;
  for (const file of files) {
    if (file.path.endsWith(suffix)) return file;
  }
  return null;
}
