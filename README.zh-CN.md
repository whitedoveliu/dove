<h1 align="center">
  <img src="control-panel/public/dove-icon-512.png" alt="Dove" width="76">
  <br>
  Dove
</h1>

<p align="center"><strong>一个有屏幕记忆的编码 agent</strong> —— 常驻 HTTP 内核 + 可换界面</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md"><strong>简体中文</strong></a>
</p>

<p align="center">
  <a href="#-快速开始"><img src="https://img.shields.io/badge/Quick_Start-3_steps-blue?style=for-the-badge" alt="Quick Start"></a>
  <a href="#-工具42-个"><img src="https://img.shields.io/badge/Tools-42-green?style=for-the-badge" alt="Tools"></a>
  <a href="#-验证"><img src="https://img.shields.io/badge/Tests-47_passing-brightgreen?style=for-the-badge" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/TypeScript-zero--build-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/macOS-Swift_helpers-000000?logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/UI-React_19_+_Tauri-61DAFB?logo=react&logoColor=white" alt="UI">
</p>

Dove 不是"聊天框包一层模型"。它跑起来是一个**常驻进程**：定时看屏幕并把看到的内容变成可检索的记忆、
把活派给子代理、每轮改完文件自动打一个 git 快照。

```
改代码 → 构建自证 → 看效果 → 不满意就回滚
```

## ✨ 不一样在哪

| | |
|---|---|
| 🧠 **屏幕记忆** | 截屏 → 三级判重 → 本地 OCR → 脱敏 → 倒排索引 → 检索进当前回合 |
| 🤖 **子代理** | 独立上下文 + 工具白名单 + 步数上限；过程落盘成**可点进去**的子线程 |
| 📋 **计划模式 · 目标** | `/plan` 先给计划、批准了才动手；`/goal` 跨轮自动推进 |
| 🖥️ **持久终端** | 一个 shell 常驻，`cd` / `export` 跨命令保留；零依赖（不用 node-pty） |
| 🛡️ **能力裁剪式权限** | 只读不是"请模型别乱写" —— 写类工具直接从它的工具表里消失 |
| 🧩 **事件溯源** | 模型可见 ⟺ 已落盘；未配对的工具调用记为「结果未知」，绝不重放 |

## 🔍 屏幕记忆

```
screencapture ─► 三级判重（哈希 → 直方图 → 逐像素）─► 快照 + SQLite
                          │
                          └─► OCR（Swift/Vision，每 3 帧）─► 脱敏 ─► ocr_frames
                                                                            │
                                                              中文 2-gram 倒排索引
                                                                            │
当前提问 ────────────────────────────────► 检索（向量 0.40 / 词法 0.25）─────┘
                                                 └─► 只注入尾部上下文（350ms 预算）
```

- **什么时候截**：心跳 120s、画面变化 12s、切应用 / 点击、停手 1.2s；全局 4s debounce，空闲降频到 5 分钟。
- **OCR 中文优先**（`zh-Hans` 在 `en-US` 之前）。反过来，Vision 对整屏中文只会回 `iX` 这种垃圾。
- **FTS5 对中文无效**（实测查「飞书」0 行），所以索引是自己切的中文 2-gram 倒排表。
- **检索两条腿**：本地 ONNX 向量（阈值 0.40）或词袋（0.25）；永不动系统提示词，只进尾部上下文。
- 快照按 hot → warm → cold → 删除轮转，总量上限 10 GB。

## 🤖 子代理

- 主代理**只看得到最终答复**，所以子代理必须写自包含结论。
- 10 个工具的白名单、100 步上限；最后一步强制作答（`tool_choice=none`）。
- 过程落盘成 `kind='subagent'` 子线程：推理和每一次工具调用（含参数）都能回放。
- `ListAgents` / `SendMessage` / `InterruptAgent`；递归**故意挡住** —— 干净的一层。

## 🏗️ 架构

```
harness/                TS 内核（零构建：Node 原生跑 .ts，只做类型擦除）
  packages/core/          agent 循环 · 工具 · 记忆 · 子代理 · 权限 · 屏幕感知
  packages/server/        常驻 HTTP + SSE · 8008 老契约兼容层（control-panel 用）
  packages/prompts/       系统提示词的 11 个槽位（s01–s11，各自独立文件）
  packages/embedding/     本地向量检索（bge-small-zh-v1.5）
  scripts/                冒烟测试（真跑，不是纯函数）
control-panel/          界面（React 19 + Vite + Tailwind）
apps/desktop/           桌面壳（Tauri：启动时按 DOVE_REPO → ~/.dove/repo → 向上查找定位内核）
```

依赖方向单向（`harness/tools/lint-layering.mjs`），单文件 ≤ 400 行（`lint-file-size.mjs`）。

## 🚀 快速开始

需要 **Node 24+**。Swift 相关能力（屏幕 OCR / 视频 / PDF）需要 macOS + Xcode Command Line Tools。

```bash
git clone https://github.com/whitedoveliu/dove.git && cd dove

# 1) 密钥：仓库根建一个 env（.gitignore 已挡住）
echo 'ANTHROPIC_API_KEY=你的key' > env    # 变量名是历史遗留，值是 OpenAI 兼容接口的 key

# 2) 构建界面（内核会托管 control-panel/dist）
cd control-panel && pnpm install && pnpm build && cd ..

# 3) 起内核并打开浏览器
./Dove.command          # → http://127.0.0.1:8790/
```

手动起也行：`cd harness && npm start`。可选的本地向量模型：

```bash
node --no-warnings harness/packages/embedding/scripts/fetch-model.mjs
```

## ⚙️ 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOVE_API_KEY` | 回退读 `env` 里的 `ANTHROPIC_API_KEY` | 模型 key |
| `DOVE_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `DOVE_MODEL` / `DOVE_TOOL_MODEL` | `deepseek-flash` | 主模型 / 工具模型（审批分类、记忆、压缩） |
| `DOVE_PORT` | `8790` | 内核端口 |
| `DOVE_WORKSPACE` | `~/DoveProjects` | 项目根目录 |
| `DOVE_CONFIG` | `~/.dove` | 记忆 / 会话 / 感知数据 / 缓存 |
| `DOVE_DB` | `harness/.data/dove.db` | SQLite |
| `DOVE_APPROVE` | `ask` | `ask` / `auto` / `deny` |
| `DOVE_ACTIVITY` | 开 | 设 `off` 关掉屏幕感知 |
| `DOVE_OCR_EVERY` | `3` | 每 N 帧 OCR 一次 |
| `DOVE_REPO` | — | 桌面端定位内核仓库（也可写一行到 `~/.dove/repo`） |
| `TAVILY_API_KEY` | — | 配了 WebSearch 优先走它 |

## 🧰 工具（42 个）

| 层 | 数量 | 内容 |
|---|---|---|
| CORE（常驻） | 15 | Read · Write · Edit · Glob · Grep · Bash · BashOutput · KillShell · Recall · Remember · Sleep · CurrentTime · ReadImage · GetContextRemaining · Present |
| SYSTEM（元工具） | 10 | AttemptCompletion · AskUserQuestion · TodoWrite · ToolSearch · Skill · DispatchToProject · ExitPlanMode · CreateGoal · GetGoal · UpdateGoal |
| ON_DEMAND（检索激活） | 17 | WebSearch · WebFetch · Task · TaskOutput · ListAgents · SendMessage · InterruptAgent · ListMcpResources · ReadMcpResource · CronCreate · CronList · CronDelete · TerminalOpen · TerminalSend · TerminalRead · TerminalClose · TerminalList |

按需工具必须写 `discoverable` —— `ToolSearch` 的描述**从这张表生成**，漏一个测试就红。

## ✅ 验证

```bash
./verify.sh              # 15 项：lint + 3 组单测 + 7 个冒烟 + 服务健康 + E2E
cd harness && npm test   # 47 项：核心 38 + 目标 1 + P0/接线 8
```

两个环境前提（不是回归）：E2E 需要一个已存在的项目；`smoke-routes` 需要内核正在运行（8790）。

## 🆚 和别的 agent 比

| 能力 | Claude Code | Codex | DeepSeek Harness | Dove |
|---|---|---|---|---|
| 计划模式 | Enter/ExitPlanMode | update_plan | plan mode | ✅ 硬只读：写类工具直接裁掉 |
| 子代理 | Agent + TaskStop | 9 个控制工具 | subagent + fork | ✅ 可导航子线程 + 控制面 |
| 持久终端 | TerminalCapture | write_stdin | terminal_*（node-pty） | ✅ 零依赖 PTY |
| 看图 | ✅ 多模态 Read | view_image | read_image | ✅ ReadImage（挂进对话） |
| 长期记忆 | LocalMemoryRecall | — | — | ✅ 本地向量 + **屏幕记忆** |
| 屏幕感知 | — | — | — | ✅ Dove 独有 |

## 📄 License

MIT
