/**
 * 「用哪个 App 打开」的 **清单表 + 探测 + 拼命令**（macOS）。
 *
 * 为什么要一张表（而不是一堆 if）：沿用 DSH（DeepSeek Harness）open-in-app 的做法 ——
 * 每个 App 一行声明，探测、菜单顺序、启动方式全从表里读。**新增一个 App = 加一行**，
 * 不碰路由、不碰面板（面板只渲染内核回的 `{id,name}` 列表）。
 *
 * 探测口径（DSH 同款）：macOS 只在**已知的 Applications 目录**里找 **bundle 名**，
 * 不做 Spotlight / LaunchServices 查询 —— 好处是快、无副作用、可断言；
 * 代价照实说：装在别处（或改过名的）bundle 探测不到（DSH 的 Known Limitations 里也这么写）。
 * `bundles` 里以 `/` 开头的是绝对路径（系统自带的 Finder / Terminal 就在系统目录里），
 * 其余的在每个 Applications 目录下逐个试。
 *
 * 这份表里**没有**任何来自请求的东西：`routes-open-in-app.ts` 只接受 `appId`，
 * 可执行文件 / bundle 路径全部由这里产出（安全边界见那个文件头）。
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** 启动方式：`open -a <bundle> <目标>`，或 `open -R <路径>`（在文件管理器里选中） */
export type AppLaunch = "app" | "reveal";

/** 交给这个 App 的目标：文件本身，还是它所在的目录（终端类开目录才有意义） */
export type AppTarget = "file" | "dir";

export interface AppRow {
  id: string;
  /** 菜单里显示的名字 */
  name: string;
  /** bundle 候选：`/…` 绝对路径直接用；否则在每个 Applications 目录下找这个名字 */
  bundles: string[];
  launch: AppLaunch;
  target: AppTarget;
}

/**
 * 清单（**菜单顺序 = 表顺序**，对齐 DSH 的分组：文件管理器 → 编辑器 → 终端）。
 *
 * 刻意不贪多：只列「能开文件 / 开目录」的文件管理器、编辑器、终端。JetBrains 全家桶、
 * Xcode、Git 客户端之类要加就自己加一行 —— 别为了菜单好看把探测面铺大。
 */
export const APP_TABLE: readonly AppRow[] = [
  // 文件管理器：固定路径，永远可用 —— 也是「默认 App」的兜底（见面板的 pickDefaultApp）
  { id: "finder", name: "访达", bundles: ["/System/Library/CoreServices/Finder.app"], launch: "reveal", target: "file" },
  { id: "cursor", name: "Cursor", bundles: ["Cursor.app"], launch: "app", target: "file" },
  { id: "vscode", name: "VS Code", bundles: ["Visual Studio Code.app"], launch: "app", target: "file" },
  { id: "windsurf", name: "Windsurf", bundles: ["Windsurf.app"], launch: "app", target: "file" },
  { id: "zed", name: "Zed", bundles: ["Zed.app", "Zed Preview.app"], launch: "app", target: "file" },
  { id: "sublime", name: "Sublime Text", bundles: ["Sublime Text.app"], launch: "app", target: "file" },
  // 终端类：给的是**文件所在目录**（`open -a Terminal <dir>` 就是「在新窗口里 cd 到那儿」）
  { id: "terminal", name: "终端", bundles: ["/System/Applications/Utilities/Terminal.app", "Utilities/Terminal.app"], launch: "app", target: "dir" },
  { id: "iterm", name: "iTerm", bundles: ["iTerm.app", "iTerm2.app"], launch: "app", target: "dir" },
  { id: "warp", name: "Warp", bundles: ["Warp.app"], launch: "app", target: "dir" },
];

/** 探测结果的一行：表里的声明 + 真实存在的 bundle 路径 */
export interface InstalledApp {
  id: string;
  name: string;
  bundle: string;
  launch: AppLaunch;
  target: AppTarget;
}

export interface ProbeDeps {
  /** 注入用：测试里指定平台，别跟着跑测试的机器漂 */
  platform?: NodeJS.Platform;
  /** 注入用：已知的 Applications 目录 */
  roots?: string[];
  /** 注入用：路径存在性判定（默认要求是**目录**，`Foo.app` 是 bundle 目录） */
  exists?: (path: string) => boolean;
}

/** 默认探测的 Applications 目录（DSH 的 `applicationRoots` 同款） */
export function defaultApplicationRoots(): string[] {
  return ["/Applications", join(homedir(), "Applications")];
}

/** bundle 必须是目录，不是一个同名的文件（`.app` 是目录） */
function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** 一行的 bundle 候选路径：绝对路径直接用，否则在每个 Applications 目录下找 */
export function bundleCandidates(row: AppRow, roots: string[]): string[] {
  const out: string[] = [];
  for (const candidate of row.bundles) {
    if (isAbsolute(candidate)) { out.push(candidate); continue; }
    for (const root of roots) out.push(join(root, candidate));
  }
  return out;
}

/**
 * 探测本机装了清单里的哪些 App（**同步、只 stat，不起子进程**）。
 *
 * 非 macOS 一律**空清单**：这套「Applications 目录 + bundle 名」的语义只有 macOS 有，
 * 别的平台既不猜路径也不假装探到 —— 面板拿到空清单会退回原来的「打开方式」菜单。
 */
export function probeInstalledApps(deps: ProbeDeps = {}): InstalledApp[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return [];
  const roots = deps.roots ?? defaultApplicationRoots();
  const exists = deps.exists ?? isDirectory;
  const installed: InstalledApp[] = [];
  for (const row of APP_TABLE) {
    const bundle = bundleCandidates(row, roots).find((path) => exists(path));
    if (!bundle) continue;
    installed.push({ id: row.id, name: row.name, bundle, launch: row.launch, target: row.target });
  }
  return installed;
}

export interface LaunchTarget {
  /** 要打开的目标（守卫给的 realpath） */
  path: string;
  /** 目标是目录还是文件（终端类据此换成所在目录） */
  isDir: boolean;
}

/**
 * 拼一条启动命令 —— **纯函数**：不碰文件系统、不执行、不看环境，测试可以直接断言 argv
 * （冒烟脚本就是这么钉的；真执行留给调用方注入的 launcher）。
 *
 * `bundle` 只允许来自探测结果（表里的候选 + 真实存在的路径）：**绝不可来自请求体**，
 * 否则 `open -a <用户输入>` 就是一条「让内核替我执行任意命令」的路。
 */
export function buildLaunchInvocation(
  app: Pick<InstalledApp, "launch" | "target">,
  bundle: string,
  target: LaunchTarget,
): { cmd: string; args: string[] } {
  // 文件管理器：`open -R` 在 Finder 里**选中**这个文件（这是 reveal 而不是「打开」）
  if (app.launch === "reveal") return { cmd: "open", args: ["-R", target.path] };
  const wanted = app.target === "dir" && !target.isDir ? dirname(target.path) : target.path;
  return { cmd: "open", args: ["-a", bundle, wanted] };
}

/** 按 id 取一行（路由用它把 `appId` 翻译成表里的 App —— 找不到就是 400，不猜） */
export function findInstalledApp(apps: InstalledApp[], id: string): InstalledApp | null {
  return apps.find((app) => app.id === id) ?? null;
}
