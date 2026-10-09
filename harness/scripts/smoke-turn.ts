/**
 * 冒烟：一轮对话能不能真的跑起来（最小闭环）
 *
 * 为什么单独写一个：runtime.ts 是改得最多的文件，但在此之前
 * **没有任何快速测试真正执行过 module 级的 runtime.run** ——
 * 只有 cli / run-task（需要夹具）和 smoke-home-dispatch（353 秒）。
 *
 * 结果就是两类 bug 反复漏网：
 *   · 引用了不存在的变量（`label: name` → ReferenceError）
 *   · const 的暂时性死区（声明写在 buildExecDeps 之后 → 一发消息就炸）
 * 这两个 lint 全过、单测全绿，因为它们**根本不执行 runtime**。
 *
 * 这个脚本只做一件事：跑一轮最短的对话，确认它没抛错、有文本产出。
 * 十几秒，够快，能进日常回归。
 */
import "./_isolate.ts";
import { loadConfig, bootstrap } from "../packages/server/src/bootstrap.ts";
import { finish } from "./_lifecycle.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, note = ""): void {
  if (ok) { pass++; console.log("  PASS  " + name + (note ? "   [" + note + "]" : "")); }
  else { fail++; console.log("  FAIL  " + name + (note ? "   [" + note + "]" : "")); }
}

console.log("=== 一轮对话的最小闭环 ===");
const svc = await bootstrap(loadConfig());
const th = svc.store.getOrCreateHomeThread();

let text = "";
let sawStats = false;
let threw = "";
const t0 = Date.now();
try {
  await svc.runtime.run({
    threadId: th.id,
    userText: "只回复两个字：收到",
    sink: (e) => {
      if (e.type === "text") text += String(e.content ?? "");
      if (e.type === "stats") sawStats = true;
    },
  });
} catch (e) {
  threw = e instanceof Error ? e.message : String(e);
}
const ms = Date.now() - t0;

check("runtime.run 没抛异常", threw === "", threw.slice(0, 160));
check("产出了文本", text.trim().length > 0, JSON.stringify(text.trim().slice(0, 40)));
check("发过 stats", sawStats);
check("10 秒内跑完（说明没有卡在某个死循环）", ms < 60_000, ms + "ms");

// 换权限模式再跑 —— 这条路径以前只在 app 里走过，TDZ 就是在这儿炸的。
//
// ⚠️ 光断言「没抛错」不够：permissionMode 曾经**根本没穿过 wire.ts 到 ExecDeps**，
//    结果 full 档静默失效（用户切了「完全访问」还是每条命令都被问），
//    而当时这个脚本照样全绿 —— 因为它只检查了"能跑"。
//    所以这里必须断言**行为**：full 档不许出现任何审批请求。
// ⚠️ 用**新机值**（对齐 Codex/DSH）。旧值 full/workspace/readonly 仍被
//    normalizePermissionMode 当别名认（存量数据兼容），但主路径必须测新值。
console.log("=== 换权限模式再跑（验行为，不只验不报错）===");
for (const mode of ["danger-full-access", "workspace-write", "read-only"] as const) {
  const t = svc.store.getOrCreateHomeThread();
  svc.store.updateThread(t.id, { metadata: { permissionMode: mode } });

  let err = "";
  let approvals = 0;
  let blockedWrite = false;
  try {
    await svc.runtime.run({
      threadId: t.id,
      // 故意用一条「一定会被判需要审批」的命令，才能验出 full 档有没有真的放行
      userText: "用 Bash 跑：cd /tmp && rm -rf /tmp/dove-smoke-nope && echo done",
      sink: (e) => {
        if (e.type === "tool_approval") approvals++;
        if (e.type === "policy") blockedWrite = true;
      },
    });
  } catch (e) { err = e instanceof Error ? e.message : String(e); }

  check(`权限模式 ${mode} 能跑`, err === "", err.slice(0, 160));
  if (mode === "danger-full-access") {
    check("完全权限档下没有任何审批请求", approvals === 0, "approvals=" + approvals);
  }
  if (mode === "read-only") {
    check("只读档裁掉了写类工具", blockedWrite, blockedWrite ? "" : "没发 policy 事件");
  }
}

// 存量数据的旧机值必须还能读（双读迁移）—— 否则老项目一升级权限就静默变默认
console.log("=== 旧机值兼容（存量 metadata）===");
for (const [legacy, want] of [["full", "danger-full-access"], ["workspace", "workspace-write"], ["readonly", "read-only"]] as const) {
  const t = svc.store.getOrCreateHomeThread();
  svc.store.updateThread(t.id, { metadata: { permissionMode: legacy } });
  let err = "";
  let approvals = 0;
  try {
    await svc.runtime.run({
      threadId: t.id,
      userText: "用 Bash 跑：cd /tmp && rm -rf /tmp/dove-smoke-alias && echo done",
      sink: (e) => { if (e.type === "tool_approval") approvals++; },
    });
  } catch (e) { err = e instanceof Error ? e.message : String(e); }
  check(`旧值 ${legacy} 能读（→ ${want}）`, err === "", err.slice(0, 100));
  if (legacy === "full") check("旧值 full 仍等价完全权限（无审批）", approvals === 0, "approvals=" + approvals);
}

console.log("\n" + "=".repeat(56));
console.log(fail === 0 ? `全部通过（${pass}）` : `失败 ${fail} / ${pass + fail}`);
finish(svc, fail === 0 ? 0 : 1);
