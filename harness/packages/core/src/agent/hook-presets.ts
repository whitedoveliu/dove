/**
 * 内置 hook 预设
 *
 * 为什么要有这个文件：`loop/hooks.ts` 那个注册表如果一条监听者都没有，它就只是「以后能用」的空壳 ——
 * 而「声明了、实现了、就是没人接」正是这个仓库反复栽过的坑（classifier、captureDaily、
 * agentExtraDirs 都栽过，注释里都记着）。所以这里放**真的在干活**的那条。
 *
 * 目前只有一条：**秘密路径护栏的全域兜底**。
 */
import type { HookRegistry } from "../loop/hooks.ts";
import { sensitiveHitOf } from "../security/paths.ts";

/**
 * 已经有自己那套处理的工具，这里**跳过**（历史原因各不相同，别把它们一把抓）：
 * - `Read` / `Glob` / `Grep` / `ReadImage` / `Present`：工具内部已经调 `assertReadablePath`
 *   （Read 是**硬拒**，Grep/Glob 是**过滤结果**而不是报错）—— 在这里再 veto 一次只会把
 *   「过滤掉敏感命中、其余照常返回」变成「整次调用失败」，是**变差**不是变严。
 * - `Bash` / `TerminalSend` / `RunScript` / `Skill`：命令串里的路径由**审批**兜着（那是刻意的口径：
 *   Bash 归审批管，见 `tools/builtin/bash.ts`）。在这里 veto 等于把用户「我就是要看一眼」的路也堵死，
 *   那是产品决策不是护栏，不由这个 hook 替用户拍。
 *
 * 剩下被它覆盖的正是**真正没有护栏的那一类**：MCP 工具（第三方文件系统 server 完全可能读任意路径）、
 * 用户自定义工具、以及将来任何忘了接护栏的新内置工具。
 */
const SELF_GUARDED = new Set(["Read", "Glob", "Grep", "ReadImage", "Present", "Bash", "TerminalSend", "RunScript", "Skill"]);

/** 参数里像路径的字符串：递归找，但**深度与条数都设上限** —— 别让一个巨型参数把每步都拖慢 */
function pathishArgs(value: unknown, depth = 0, out: string[] = []): string[] {
  if (out.length >= 32 || depth > 4) return out;
  if (typeof value === "string") {
    // 只挑「路径/命令里可能含路径」的串：太短的、没有分隔符的（如 "1"、"true"）直接不看
    if (value.length >= 4 && (value.includes("/") || value.startsWith("~") || value.includes("\\"))) out.push(value);
    return out;
  }
  if (Array.isArray(value)) { for (const v of value) pathishArgs(v, depth + 1, out); return out; }
  if (value && typeof value === "object") { for (const v of Object.values(value as Record<string, unknown>)) pathishArgs(v, depth + 1, out); return out; }
  return out;
}

/**
 * 注册「秘密路径全域兜底」。
 *
 * 它是**第二道**护栏，不是第一道：正常路径上工具自己会拦。它的价值在于
 * ① 覆盖没有护栏的工具（MCP / 用户工具 / 未来的新工具）；
 * ② 万一某条路径忘了接护栏，这里还会出声（R 之前提醒过：exposure 那套只要有一半没接上
 *    就会变成静默 fail-open，所以多一道便宜的网值得）。
 */
export function registerSecretPathGuard(hooks: HookRegistry): void {
  hooks.register("beforeToolExecute", (p) => {
    if (SELF_GUARDED.has(p.toolName)) return undefined;
    for (const s of pathishArgs(p.args)) {
      const hit = sensitiveHitOf(s);
      if (hit) {
        return {
          kind: "veto",
          reason: `工具 ${p.toolName} 的参数里出现了${hit.label}（${hit.rule}）。这是本机凭据/私钥一类的东西，`
            + "系统在这一层直接拦下，不弹审批。如果你确实需要读它，请让用户在回复里明确说明并让用户自己去做。",
        };
      }
    }
    return undefined;
  }, { id: "secret-path-guard" });
}
