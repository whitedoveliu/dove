import "./_isolate.ts";   // ⚠️ 必须最先 import：把库指到临时目录，别碰生产库
import { loadConfig, bootstrap } from "../packages/server/src/bootstrap.ts";

const cfg = loadConfig();
const svc = await bootstrap(cfg);
console.log("✓ bootstrap OK");
console.log("  工具:", svc.tools.size);
console.log("  记忆:", svc.memory ? "已启用" : "未启用");
const home = svc.store.getOrCreateHomeThread();
console.log("  Home 线程:", home.id, home.title);
console.log("  项目数:", svc.projects.list().length);

const p = svc.projects.create({ id: "studio", name: "林知夏作品集" });
console.log("  创建项目:", p.id, p.path);

// 上下文装配（走适配器）
const { assembleSystemPrompt } = await import("../packages/core/src/context/assemble.ts");
const r = await assembleSystemPrompt({ thread: home, projectContext: { workdir: p.path, outputsDir: p.path + "/outputs" } });
console.log("  system prompt 长度:", r.block1.length, "+ block2", r.block2?.length ?? 0);

const { renderTailContext } = await import("../packages/core/src/context/tail-context.ts");
const mt = renderTailContext({});
console.log("  mt 长度:", mt.length, "含时间锚:", mt.includes("Authoritative") || mt.includes("时间") || mt.length > 0);

svc.shutdown();
console.log("✓ 全部通过");
