/**
 * 原生「选择文件夹」对话框 —— 给没有 Tauri 原生能力的运行形态用（浏览器 / 脚本）。
 *
 * 背景（这个仓库真栽过的坑）：面板里「选择项目…」在桌面壳里本来走 Tauri 的 dialog 插件，
 * 但面板是**内核用 HTTP 托管的**（http://127.0.0.1:8790）——对 Tauri 来说是**远程源**，
 * 而 `capabilities/default.json` 里没有 `remote.urls` 时，任何 Tauri 命令都会被 ACL 拒绝。
 * 被拒之后面板会退到这条路由，而这条路由当时是个**桩**（永远返回「没有原生选择器」），
 * 再被面板的 `if (!picked.success) return` 吞掉 —— 用户看到的就是「点了没反应」。
 *
 * 现在真做：macOS 上让 osascript 弹系统标准的 choose folder（Standard Additions 自带，
 * 不需要任何隐私权限；对话框归 osascript 这个子进程）。取消 / 超时 / 非 darwin
 * 都返回**可读的原因**，由面板显示出来 —— 不许静默。
 *
 * 单飞：同一时刻只允许一个选择框（连点两次不再叠两个对话框）。
 */
import { execFile } from "node:child_process";

export interface PickResult {
  success: boolean;
  path?: string;
  cancelled?: boolean;
  message?: string;
}

/** 对话框最多开着等多久（超时杀掉，别留僵尸 osascript）—— 用户可能想很久，默认给 10 分钟 */
const PICK_TIMEOUT_MS = Number(process.env.DOVE_PICK_FOLDER_TIMEOUT_MS ?? 10 * 60_000);

/** 可注入的 runner：默认真跑 osascript，测试里换成假的（同 core/src/media/frames.ts 的手法） */
export type PickRunner = (script: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const SCRIPT = 'POSIX path of (choose folder with prompt "选择项目文件夹（Dove）")';

const defaultRunner: PickRunner = (script) =>
  new Promise((resolve) => {
    execFile(
      "osascript", ["-e", script],
      { timeout: PICK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        const out = String(stdout ?? "");
        // stderr 空的时候把 err.message（spawn ENOENT 之类）带上，否则面板只会看到「退出码 1」
        const errText = String(stderr ?? "").trim() || (e ? e.message : "");
        const code = e ? (typeof e.code === "number" ? e.code : (e.killed ? -2 : 1)) : 0;
        resolve({ code, stdout: out, stderr: errText });
      },
    );
  });

let inFlight: Promise<PickResult> | null = null;

/** 弹一次系统「选择文件夹」。**同一个进程内单飞**：第二次调用直接返回「已经有一个在等你」。 */
export function pickFolder(
  runner: PickRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<PickResult> {
  if (platform !== "darwin") {
    return Promise.resolve({
      success: false,
      message: `这个平台（${platform}）没接原生文件夹选择器 —— 手动把路径粘进「选择项目」旁边的输入，或直接说「用 /path/to/dir 当项目」。`,
    });
  }
  if (inFlight) {
    return Promise.resolve({ success: false, message: "已经有一个选择框在等你（先处理它，或等它超时）" });
  }
  inFlight = runOnce(runner).finally(() => { inFlight = null; });
  return inFlight;
}

async function runOnce(runner: PickRunner): Promise<PickResult> {
  const r = await runner(SCRIPT);
  if (r.code === 0) {
    const path = r.stdout.trim();
    return path
      ? { success: true, path }
      : { success: false, message: "选择框没有返回路径（空结果）—— 再试一次，或手动粘路径" };
  }
  // AppleScript 的「用户取消」= error -128（各语言都带这个码，所以只认它 + 常见英文文案）
  if (/-128\b|User canceled|User cancelled/i.test(r.stderr)) {
    return { success: false, cancelled: true, message: "已取消选择" };
  }
  if (r.code === -2) {
    return { success: false, message: "选择框超时（一直没人操作）—— 再点一次即可" };
  }
  const last = r.stderr.split("\n").map((s) => s.trim()).filter(Boolean).pop();
  return { success: false, message: "打不开系统选择框：" + (last ?? `osascript 退出码 ${r.code}`) };
}
