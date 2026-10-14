/**
 * App 图标：把 macOS 的 `.icns` 转成 64px PNG（`plutil` + `sips`，都是系统自带，**不引依赖**）。
 *
 * 为什么值得做：菜单里一排真图标比一排通用小方块好认得多；DSH 也是这么干的。
 * 失败一律 `null`（路由回 404）—— 面板退化成 lucide 通用图标，不占位、不报错、不崩。
 *
 * 缓存口径：按 bundle 路径缓存**结果**（含 null）。所以「本次运行没抽到图标」这件事也会被记住 ——
 * 与 DSH「可用性每页只读一次 / 装完新 App 要重启」同口径，别指望热更新。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 抽图标最多等多久（抽不到就是没图标，别把 HTTP 请求吊着） */
const ICON_TIMEOUT_MS = 5_000;

/** 可注入的 runner：默认真跑 plutil / sips，测试里换成假的（同 folder-picker.ts 的手法） */
export type IconRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

const defaultRunner: IconRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? "") });
    });
  });

/** bundle 路径 → PNG 字节（null = 抽不到）。见文件头的缓存口径。 */
const cache = new Map<string, Buffer | null>();

export interface IconDeps {
  run?: IconRunner;
  platform?: NodeJS.Platform;
}

/** 一个 bundle 的图标 PNG（64px）；抽不到返回 null。 */
export async function appIconPng(bundle: string, deps: IconDeps = {}): Promise<Buffer | null> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return null;
  const hit = cache.get(bundle);
  if (hit !== undefined) return hit;
  const png = await extractPng(bundle, deps.run ?? defaultRunner).catch(() => null);
  cache.set(bundle, png);
  return png;
}

/**
 * `.icns` 的挑选：先问 Info.plist 的 `CFBundleIconFile`（值可能不带扩展名），
 * 读不到 / 指向的文件不在，再退到 `Contents/Resources` 里第一个 `*.icns`。
 */
async function icnsPathOf(bundle: string, run: IconRunner): Promise<string | null> {
  const resources = join(bundle, "Contents", "Resources");
  const plist = join(bundle, "Contents", "Info.plist");
  const declared = await run("plutil", ["-convert", "json", "-o", "-", plist], ICON_TIMEOUT_MS);
  if (declared.code === 0) {
    try {
      const value = (JSON.parse(declared.stdout) as { CFBundleIconFile?: unknown }).CFBundleIconFile;
      if (typeof value === "string" && value !== "") {
        const file = join(resources, value.endsWith(".icns") ? value : `${value}.icns`);
        if (existsSync(file)) return file;
      }
    } catch { /* plutil 吐的不是 JSON：落到下面的目录扫描 */ }
  }
  try {
    const entry = readdirSync(resources).find((name) => name.endsWith(".icns"));
    return entry ? join(resources, entry) : null;
  } catch {
    return null;   // 没有 Resources 目录：这个 bundle 就是没图标
  }
}

async function extractPng(bundle: string, run: IconRunner): Promise<Buffer | null> {
  const icns = await icnsPathOf(bundle, run);
  if (!icns) return null;
  // sips 只能写文件（没有 stdout 模式），所以借一个临时目录，读完就删
  const dir = mkdtempSync(join(tmpdir(), "dove-app-icon-"));
  try {
    const out = join(dir, "icon.png");
    const r = await run("sips", ["-s", "format", "png", "-Z", "64", icns, "--out", out], ICON_TIMEOUT_MS);
    if (r.code !== 0) return null;
    return readFileSync(out);
  } catch {
    return null;   // sips 退出码 0 但没写文件（老 icns / 权限）也走这里
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响响应 */ }
  }
}
