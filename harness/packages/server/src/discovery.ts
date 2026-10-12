/**
 * 对外「发现」信息：端口文件 + 极简 API 规格
 *
 * 为什么要有：内核是常驻服务，而 CLI / 外部 agent 是**事后**才来的调用方，
 * 它们得先知道去哪儿说话。Alma 用 ~/.config/alma/api-spec.md 干这件事
 * （逆向报告 §7.6 那张文件表里明写着「外部 CLI/agent 用来发现端口」），
 * 这里照同一个形状来：端口写成一个纯数字文件，规格写成一份人/机器都能读的 md。
 *
 * 为什么在 bootstrap() 里写：只有它同时知道 cfg（端口、模型、目录）。
 * main.ts 在调用它之前已经做过端口预检，所以这里写下的就是**将要监听**的那个端口；
 * 万一 main 后续 listen 失败也没关系 —— 读端口的一方（CLI）会先探一次 /api/health，
 * 探不通就当这个文件不存在。所以这里**不许**写任何「已经就绪」的断言。
 *
 * 全部写失败都不抛：发现信息是便利设施，不能因为它拖垮内核启动。
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./bootstrap-types.ts";

/** 原子替换：CLI 可能正好在这几毫秒里读，先写临时文件再 rename 就不会读到半截数字 */
function writeAtomic(file: string, text: string): void {
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

export function apiSpecText(cfg: Config, toolCount: number, pid: number): string {
  const base = `http://127.0.0.1:${cfg.port}`;
  return `# Dove 内核 API（自动生成，别手改）

- 端口：${cfg.port}（文件名就是它：${join(cfg.configDir, "port")}）
- 进程：pid ${pid} · 启动于 ${new Date().toISOString()}
- 模型：${cfg.model}（工具模型 ${cfg.toolModel}）· 工具 ${toolCount} 个
- 工作区：${cfg.workspaceRoot}
- 配置目录：${cfg.configDir}
- 只监听 127.0.0.1，没有鉴权（本机进程都能调）

## 常用端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/health | 端口/模型/工具数/线程数/项目数 |
| GET | /api/config | 模型、工作区、配置目录 |
| GET | /api/threads | 线程列表（顺带创建 home 线程） |
| POST | /api/threads | 建线程 {kind:"home"\\|"project", title} |
| GET | /api/threads/{id}/messages?limit=N | 线程消息 |
| DELETE | /api/threads/{id} | 删线程（消息一起删） |
| POST | /api/chat | 跑一轮，返回 SSE（事件流见下） |
| POST | /api/stop | 停线程 {threadId} |
| POST | /api/steer | 插话 {threadId, message}（下一个 step 生效） |
| GET | /api/pending | 待审批的工具调用 |
| POST | /api/approve | 表态 {toolCallId, approved, reason?} |
| POST | /api/answer | 回答提问 {questionId, answer} |
| GET | /api/logs/runtime?limit=N | 内核 console 日志 |
| GET | /api/projects · /api/projects/{id}/goal | 项目与项目级目标 |

## 事件（POST /api/chat 的 SSE data 行，一行一个 JSON）

text · reasoning · tool_start · tool_result · tool_approval · tool:ask_user ·
interrupted · stats · error · done

## curl 示例

\`\`\`sh
curl -s ${base}/api/health
# 跑一轮（SSE，逐行输出）：先拿线程 id
TID=$(curl -s ${base}/api/threads | python3 -c 'import json,sys;print([t["id"] for t in json.load(sys.stdin) if t["kind"]=="home"][0])')
curl -sN -X POST ${base}/api/chat -H 'Content-Type: application/json' \\
  -d "{\\"threadId\\":\\"$TID\\",\\"message\\":\\"你好\\"}"
# 审批与提问
curl -s ${base}/api/pending
curl -s -X POST ${base}/api/approve -H 'Content-Type: application/json' -d '{"toolCallId":"...","approved":true}'
\`\`\`

## 用 CLI（推荐，省得自己拼 JSON）

\`\`\`sh
dove health            # 这个端口在不在
dove run "你好"         # 流式跑一轮（--json 时每行一个事件）
dove approve           # 待审批列表 + 终端里允许/拒绝
dove logs --tail 50    # 内核日志
\`\`\`
`;
}

/**
 * 把发现信息写到 configDir（正常就是 ~/.dove）。**只碰这两个文件**，
 * 不碰库、记忆、技能、cron —— 那些是用户在用的数据。
 */
export function publishDiscovery(cfg: Config, toolCount: number): void {
  try {
    mkdirSync(cfg.configDir, { recursive: true });
    writeAtomic(join(cfg.configDir, "port"), String(cfg.port) + "\n");
    writeAtomic(join(cfg.configDir, "api-spec.md"), apiSpecText(cfg, toolCount, process.pid));
  } catch { /* 发现信息写不出来不影响内核干活 */ }
}
