/**
 * 冒烟脚本的隔离护栏 —— **必须在 import bootstrap 之前 import 这个**。
 *
 * 为什么：loadConfig() 在没设 DOVE_DB 时会用默认路径（harness/.data/dove.db），
 * 那**就是生产库**。实测踩过：跑 smoke-cron-e2e 建了两个「每 2 秒报一次时」的
 * cron 任务，落进了生产库；后来又跑了几次，攒成 4 个副本。
 * App 一启动，这 4 个任务同时每 2 秒调一次模型 —— 25 分钟烧了 1000+ 轮。
 *
 * 所以：除非调用方**显式**指定了 DOVE_DB，否则一律指到临时目录。
 * 想对生产库跑就自己设 DOVE_DB=...，那是有意为之。
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DOVE_DB) {
  const root = mkdtempSync(join(tmpdir(), "dove-smoke-"));
  mkdirSync(join(root, "ws"), { recursive: true });
  mkdirSync(join(root, "cfg"), { recursive: true });
  process.env.DOVE_DB = join(root, "dove.db");
  process.env.DOVE_CONFIG = process.env.DOVE_CONFIG ?? join(root, "cfg");
  process.env.DOVE_WORKSPACE = process.env.DOVE_WORKSPACE ?? join(root, "ws");
  // 别让冒烟脚本起一堆后台服务互相打架
  process.env.DOVE_ACTIVITY = process.env.DOVE_ACTIVITY ?? "off";
  process.env.DOVE_LEGACY = process.env.DOVE_LEGACY ?? "off";
  if (process.env.DOVE_ISOLATE_QUIET !== "1") {
    console.log(`[isolate] 用临时库 ${process.env.DOVE_DB}（想用别的请显式设 DOVE_DB）`);
  }
} else if (process.env.DOVE_ISOLATE_QUIET !== "1") {
  console.log(`[isolate] 尊重调用方指定的 DOVE_DB=${process.env.DOVE_DB}`);
}

export const ISOLATED = !process.env.DOVE_FORCE_PROD;
