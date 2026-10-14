# Dove Harness

**常驻、有记忆、双层循环、事件溯源**的桌面创意 Agent 内核。

> Alma Harness 复刻规格书与答疑 P0–P2

---

## 快速开始

```bash
# 1) 起内核（默认 127.0.0.1:8790）
cd harness
node --no-warnings packages/server/src/main.ts

# 2) 命令行跑一个任务
DOVE_APPROVE=auto node --no-warnings scripts/run-task.ts dove-studio "把配色改成暖色"

# 3) 起前端面板（control-panel，开发模式 3006，后端走内核的 8008 兼容层）
cd ../control-panel && pnpm install && pnpm dev
# 或构建后由内核直接托管（产物挂在内核 8790 的根路径）
cd ../control-panel && pnpm build     # 产物在 control-panel/dist
```

**零构建步骤**：Node 24+ 原生跑 `.ts`（类型擦除），不需要 tsc 编译。
`tsc --noEmit` 只用于类型检查。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOVE_PORT` | 8790 | HTTP 端口 |
| `DOVE_WORKSPACE` | `~/DoveProjects` | 项目根目录 |
| `DOVE_CONFIG` | `~/.dove` | 持久化目录（SOUL/USER/MEMORY/日记/事件日志） |
| `DOVE_DB` | `harness/.data/dove.db` | SQLite 文件 |
| `DOVE_MODEL` | `deepseek-flash` | 主模型 |
| `DOVE_TOOL_MODEL` | `deepseek-flash` | 工具模型（审批分类 / 记忆抽取 / 查询改写 / 压缩摘要） |
| `DOVE_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `DOVE_API_KEY` | 回退读仓库根的 `env` 里的 `ANTHROPIC_API_KEY` | API key |
| `DOVE_APPROVE` | `ask` | 审批策略：`ask` 弹窗 / `auto` 自动放行（CLI、无人值守）/ `deny` 一律拒绝 |

---

## 架构

```
server  →  loop  →  { context, tools, memory, agents, projects }  →  session  →  providers
```

**依赖方向由 CI 强制**（`tools/lint-layering.mjs`），下层永远不 import 上层。
**单文件 ≤400 行**（`tools/lint-file-size.mjs`）。

```
packages/
  core/src/
    session/    事件日志 · SQLite · parts 状态机 · 崩溃修复
    providers/  OpenAI 兼容 provider（手写 SSE + tool_call 归并）
    loop/       step 循环 · turn 闸门 · 看门狗 · steering · 工具执行管线
    context/    分段装配 · mt 尾部注入 · 记忆切片 · token 估算 · AutoCompact
    tools/      注册表 · 输出预算 · 调用修复 · 审批链 · 44 个内置工具（分层见下）
    memory/     文件层 · 向量层 · 检索 · 写入 · 睡眠合并
    agents/     子代理运行时 · 后台任务注册表
    projects/   构建 · 预览 · 版本（git）
  prompts/      12 个提示词段（s01–s12；s12 = 项目 AGENTS.md）（纯文本，不进代码）
  server/       HTTP + SSE + 服务装配
../control-panel/  React 19 面板（产品界面）
fixtures/       回归夹具与场景卡
```

**工具分层**（共 44 个；CORE 只往尾部追加，顺序 = wire 顺序 = 前缀缓存）

| 层 | 数量 | 内容 |
|---|---|---|
| CORE | 17 | Read · Write · Edit · Glob · Grep · Bash · BashOutput · KillShell · Recall · Remember · Sleep · CurrentTime · ReadImage · GetContextRemaining · Present · RuntimeStatus · RunScript |
| SYSTEM | 10 | AttemptCompletion · AskUserQuestion · TodoWrite · ToolSearch · Skill · DispatchToProject · ExitPlanMode · CreateGoal · GetGoal · UpdateGoal |
| ON_DEMAND | 17 | WebSearch · WebFetch · Task · TaskOutput · ListAgents · SendMessage · InterruptAgent · ListMcpResources · ReadMcpResource · CronCreate · CronList · CronDelete · TerminalOpen · TerminalSend · TerminalRead · TerminalClose · TerminalList |

ON_DEMAND 的每个工具**必须写 `discoverable`**（`ToolSearch` 的描述由这张表生成，漏一个测试就红）。

---

## 核心机制（都带测试）

| 机制 | 在哪 | 怎么验证 |
|---|---|---|
| **事件溯源**：模型可见 ⟺ 已落盘 | `session/event-log.ts` | `npm test` 的「seq 单调，重启后继续」 |
| **崩溃修复**：未配对的 tool_call 写「结果未知」而非重放 | `session/repair.ts` | `npm test` 的「不重放」 |
| **四道闸门**：steering > 完成守卫 > 权限续跑 > 自动续跑，互斥 | `loop/gates.ts` | `npm test` 的 4 个闸门用例 |
| **工具输出预算**：三档 + 6000 字符 + spill + 截断三要素文案 | `tools/budget.ts` | `npm test` 的「大结果被截断」 |
| **调用修复**：名字模糊匹配 + 参数错名映射 | `tools/repair-call.ts` | `npm test` 的 3 个修复用例 |
| **审批链**：凭证必问 → 会话规则 → 已拒形状 → 写边界 → never 放行 → 分类器 → 启发式 | `loop/approval-chain.ts` | `npm test` 的审批用例 + `packages/core/test/write-scope.test.ts` |
| **两轴权限**：sandbox（能写哪）× approval（要不要问），档位只是命名绑定 | `tools/permission.ts` | `npm test` 的 `permission-profile / write-scope / permission-inherit` |
| **前缀缓存**：静态段在前，易变内容走 `mt` 进 messages | `context/assemble.ts` `tail-context.ts` | `npm test` 的「mt prepend 到最后一条 user」 |
| **AutoCompact**：阈值 80 / 保留 4 回合 / 去抖 | `context/compact.ts` | `scripts/smoke-context.ts` |

---

## 测试

```bash
npm test                      # 全量 glob：295 项（34 个文件，294 通过 / 1 跳过）
npm run lint                  # 文件大小 + 依赖方向
node scripts/smoke-context.ts # 上下文装配 49 项
node scripts/smoke-memory.ts  # 记忆系统 45 项
node scripts/smoke-bootstrap.ts
node scripts/run-task.ts <fixture> "<任务>"   # 端到端跑一个任务
node scripts/drive-http.mjs "<任务>"          # 走真实 HTTP/SSE（浏览器那条路）
```

回归夹具与 3 个验收任务见 [fixtures/TEST-TASKS.md](fixtures/TEST-TASKS.md)。

---

## 设计纪律（改代码前先读）

1. **工具是负债**。加能力优先做成「技能包 + 通用工具」，不要轻易加工具位。判断标准：这个动作模型每周会用 10 次以上吗？
2. **工具数组顺序 = 上 wire 顺序**。CORE 顺序固定，动态激活只追加到尾部。删除或重排 = 前缀缓存整段失效。
3. **每个工具的 execute 都必须被 `guarded()` 包住**，错误变结构化结果，绝不冒泡到主循环。
4. **易变内容不进系统提示词**。时间锚 / 情绪 / 任务 / 记忆切片一律走 `mt` prepend 到最后一条 user 消息。
5. **动态提示词段必须写 `reason`**，不写类型不过（照抄 CCB 的 `DANGEROUS_uncachedSystemPromptSection`）。
6. **一工具一文件**；加工具 = 加一个文件 + 在 `registry.ts` 加一行。
7. **模型可见的必须先落日志**。副作用动作必须有回执（内容 hash）。
