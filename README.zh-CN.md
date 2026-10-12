<h1 align="center">
  <img src="control-panel/public/dove-icon-512.png" alt="Dove" width="72">
  <br>
  Dove
</h1>

<p align="center"><strong>一个有屏幕记忆的编码 agent。</strong><br>常驻 HTTP 内核 · CLI / 浏览器 / 桌面三个客户端 · 44 个内置工具</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

<p align="center">
  <a href="#-快速开始"><img src="https://img.shields.io/badge/Quick_Start-3_steps-blue?style=for-the-badge" alt="Quick Start"></a>
  <a href="#-能力"><img src="https://img.shields.io/badge/Tools-44-green?style=for-the-badge" alt="Tools"></a>
  <a href="#-验证"><img src="https://img.shields.io/badge/Tests-59_passing-brightgreen?style=for-the-badge" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/TypeScript-zero--build-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/macOS-Swift_helpers-000000?logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/UI-React_19_+_Tauri-61DAFB?logo=react&logoColor=white" alt="UI">
</p>

Dove 不是"聊天框包一层模型"。它跑起来是一个**常驻进程**：CLI、浏览器界面、桌面壳都是连同一个内核的
HTTP 客户端 —— 同一份记忆、同一份会话、同一套审批。

```
改代码  →  构建自证  →  看效果  →  不满意就回滚
```

## ✨ 能力

| | |
|---|---|
| 🧠 **屏幕记忆** | 截屏 → 三级判重 → 本地 OCR → 中文索引 → 检索进当前回合 |
| 🐍 **PTC（RunScript）** | 模型写一段 TS/JS 脚本去调其它工具；一次审批覆盖整段脚本，脚本里每次调用仍回内核 |
| ⌨️ **`dove` CLI** | 对着常驻内核的 17 个子命令（`run` · `chat` · `approve` · `steer` · `tools` …）；`--json` 出 NDJSON |
| 🤖 **子代理** | 独立上下文、10 个工具的白名单、100 步上限；过程落盘成**可点进去**的子线程 |
| 🖥️ **终端 · 后台任务** | 一个 shell 常驻，`cd` / `export` 跨命令保留；后台任务保留**尾部** 200,000 字符，90 秒无输出标 stalled，60 秒自动转后台 |
| 📋 **目标验收** | `criteria` 每轮由**独立评估器**打分；空证据 = 自动 FAIL，失败项反馈进下一轮 |
| 🛡️ **权限** | 只读是把写类工具**从工具表里删掉**；审批扫命令链的**每一段**，脚本调用也回同一条链 |
| 🧩 **事件溯源** | 模型可见 ⟺ 已落盘；未配对的工具调用记为「结果未知」；回合无产出会发 `interrupted` 事件而不是静默 |

## 🤔 不一样在哪

- **它记得你的屏幕，不只是文件。** OCR 帧进的是自建的中文 2-gram 倒排索引（FTS5 查中文 0 命中），
  检索有两条腿：本地 ONNX 向量阈值 0.40，或词袋 0.25。
- **权限是能力裁剪。** 只读不是提示词里"请别写" —— 写类工具在回合开始前就从工具表里消失了；
  审批会扫命令链的**每一段**。脚本调用绕不过去：`doveTool` 回到同一条审批链。
- **多步活写成代码，不是多轮对话。** 一段 4 步、读两个文件的脚本 5.5 秒跑完；
  同形状的活曾经让一个深度研究回合跑了 76 步 / 14 分钟 / 5.7M input tokens。
- **零依赖跑起来。** 内核是纯 Node 24 + `.ts`（无构建、无 `node_modules`）；持久终端用系统 `script` 拿 PTY，
  不引 `node-pty`。

## 🚀 快速开始

需要 **Node 24+**。屏幕 OCR、视频与 PDF 相关能力需要 macOS + Xcode Command Line Tools。

```bash
git clone https://github.com/whitedoveliu/dove.git && cd dove

# 1) 密钥：仓库根建一个名为 env 的文件（.gitignore 已挡住）
echo 'ANTHROPIC_API_KEY=你的key' > env     # 变量名是历史遗留，放 OpenAI 兼容接口的 key

# 2) 构建界面（内核会托管 control-panel/dist）
cd control-panel && pnpm install && pnpm build && cd ..

# 3) 起内核并打开浏览器
./Dove.command          # → http://127.0.0.1:8790/
```

不用启动器就手动起：`cd harness && npm start`。同一个内核也能从终端说话：

```bash
cd harness && npm link                      # 把 dove 装进 PATH（不装就 node bin/dove.mjs）
dove health                                 # 端口 · 模型 · 工具数 · 线程数
dove run "修一下挂掉的测试" --thread <id>   # 跑一轮，流式打到 stdout
dove approve --allow                        # 无人值守时批量表态待审批
```

可选的本地向量模型。不装的话，记忆退化成字面匹配，屏幕记忆的向量腿也会关掉（词法腿照常）。
**两步都要做**——只下模型是不够的：

```bash
# 1) 装唯一那个外部依赖（隔离在这个包里；真正加载 ONNX 运行时的是它）
cd harness/packages/embedding && npm install && cd -

# 2) 下模型（约 24MB）
node --no-warnings harness/packages/embedding/scripts/fetch-model.mjs
```

内核每次启动都会报当前用的是哪个后端（`向量后端: onnx:bge-small-zh-v1.5` 或 `hash-1024`）。

## ⌨️ CLI

CLI 是客户端：它绝不另起内核，而是找到在跑的那个，走 HTTP。

| | |
|---|---|
| 子命令 | `health` `status` `version` `up` `logs` `threads` `run` `chat` `stop` `steer` `approve` `pending` `answer` `tools` `skills` `goals` `goal` |
| 端口发现 | `--port` > `DOVE_PORT` > `~/.dove/port` > 扫 8790–8799 |
| 输出 | `--json` 是 NDJSON 且不上色；提示走 stderr，所以 `dove run --quiet "…" > answer.txt` 拿到的是干净答案 |
| 退出码 | `0` 成功 · `1` 失败 · `2` 用法错 · `3` 连不上内核 · `4` 内核报错 · `130` 被中断 |
| 发现文件 | 内核启动时写 `~/.dove/port` 和 `~/.dove/api-spec.md`，给外部程序发现端口 |
| 审批 | TTY 里就地问 `y/N`；也能在别的终端 `dove approve --allow`；非 TTY 只打印提示 |

## 🏗️ 架构

```
harness/          内核（Node 原生跑 .ts，无构建步骤）
  bin/dove.mjs      CLI 入口（package.json 的 bin）
  packages/cli/     CLI：端口发现 · HTTP + SSE 客户端 · 17 个子命令
  packages/core/    循环 · 工具 · 记忆 · 子代理 · 权限 · 屏幕感知
  packages/server/  HTTP + SSE · 工具控制面 · 界面在用的旧契约兼容层
  packages/prompts/ 11 个提示词槽位（s01–s11）
  scripts/          冒烟测试（跑的是真实路径）
control-panel/    界面（React 19 + Vite）
apps/desktop/     桌面壳（启动时解析内核位置：DOVE_REPO → ~/.dove/repo → 向上查找）
```

依赖方向单向（`security → … → agent`），由 `harness/tools/lint-layering.mjs` 强制；单文件 ≤ 400 行（`lint-file-size.mjs`）。

## ⚙️ 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOVE_API_KEY` | 回退读 `env` 里的 `ANTHROPIC_API_KEY` | 模型 key |
| `DOVE_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `DOVE_MODEL` / `DOVE_TOOL_MODEL` | `deepseek-flash` | 主模型 / 工具模型 |
| `DOVE_PORT` | `8790` | 内核端口 |
| `DOVE_WORKSPACE` | `~/DoveProjects` | 项目根目录 |
| `DOVE_CONFIG` | `~/.dove` | 记忆、会话、屏幕数据、缓存 |
| `DOVE_DB` | `harness/.data/dove.db` | SQLite |
| `DOVE_APPROVE` | `ask` | `ask` / `auto` / `deny` |
| `DOVE_ACTIVITY` | 开 | 设 `off` 关掉屏幕感知 |
| `DOVE_AUTO_BACKGROUND_MS` | `60000` | 前台 Bash 未显式给 timeout 时，跑满这个时长自动转后台 |
| `DOVE_JOB_STALL_MS` | `90000` | 后台任务多久没有新输出就标 `stalled` |
| `DOVE_REPO` | — | 桌面壳用来定位内核仓库 |
| `TAVILY_API_KEY` | — | 配了 WebSearch 优先走它 |

## 🧰 工具（44 个）

| 层 | 数量 | 覆盖 |
|---|---|---|
| CORE | 17 | 文件、检索、shell、后台任务、记忆、看图、上下文自省、交付物、PTC |
| SYSTEM | 10 | 完成、提问、待办、工具检索、技能、派活到项目、计划模式、目标 |
| ON_DEMAND | 17 | 联网、子代理、MCP 资源、定时任务、持久终端 |

按需工具由 `ToolSearch` 激活，而它的描述**从工具表生成** —— 新加的按需工具忘了写 `discoverable` 会有测试报红。
工具控制面是 `GET /api/tools/list`（回环只读，`dove tools` 读的就是它）和 `POST /api/tools/invoke`
（**必须**带活着的脚本会话 + token，不带一律 `403`）。
读 `SKILL.md` 时会预检正文声明的 `requires.bins` / `requires.env`，缺了就在正文开头警告。

## ✅ 验证

```bash
./verify.sh              # 21 项：lint、3 组单测、13 个冒烟、2 项服务健康、2 项 E2E
cd harness && npm test   # 59 项：核心 38、修复 12、目标 1、P0 5、接线 3
```

这一轮新增 6 条冒烟：`smoke-cli` · `smoke-ptc` · `smoke-jobs` · `smoke-loop-audit` · `smoke-goal-eval` · `smoke-goal-events`。
属于环境问题、不是回归的失败：两项服务健康检查和 `smoke-routes` 需要内核正在 8790 上跑；
E2E 需要有已存在的项目。

## 🆚 对照

| | Claude Code | Codex | DeepSeek Harness | Dove |
|---|---|---|---|---|
| 计划模式 | Enter / ExitPlanMode | update_plan | plan mode | ✅ 写类工具被移除（硬只读） |
| 子代理 | Agent + TaskStop | 9 个控制工具 | subagent + fork | ✅ 可导航子线程 + 控制面 |
| 持久终端 | TerminalCapture | write_stdin | terminal_*（node-pty） | ✅ 零依赖 PTY |
| 屏幕感知 | — | — | — | ✅ 截图记忆 |

## 📄 License

MIT
