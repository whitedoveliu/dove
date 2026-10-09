# Dove

**一个有屏幕记忆的编码 agent。** 常驻 HTTP 内核 + 可换的界面 —— 工具、记忆、子代理、权限都在内核里。

```
改代码 → 构建自证 → 看效果 → 不满意就回滚
```

Dove 不是"聊天框包一层模型"。跑起来它是一个常驻进程：定时看屏幕，把看到的内容变成可检索的记忆；
能派子代理去并行干活；每轮改完文件自动打一个 git 快照。界面只是它的一张脸，换界面不用动内核。

## 特色

| 特色 | 一句话 |
|---|---|
| 🧠 **截图 OCR 记忆** | 截屏 → 三级判重 → 本地 OCR → 脱敏 → 落库建索引。「我上午在看什么」是真的能检索回来的 |
| 🤖 **子代理运行时** | 独立上下文 + 工具白名单 + 步数上限；过程落盘成一条**可点进去看**的子线程，不是黑盒 |
| 🧰 **双层工具表** | 16 个常驻 + 7 个按需（模型先检索再激活）；检索描述**从工具列表生成**，加删工具不会漏 |
| 🔐 **分级权限** | 只读 / 工作区内可写 / 完全放行，外加实验档 `auto`；审批看命令链的**每一段** |
| 🧩 **事件溯源** | 模型可见 ⟺ 已落盘；崩溃后未配对的 tool_call 写「结果未知」，不重放 |
| 🎛️ **内核 / 界面解耦** | 内核是常驻 HTTP 服务，界面只通过 HTTP + SSE 说话 |

## 一、截图 OCR 记忆：把「看到过」变成「想得起来」

```
screencapture ─► 三级判重 ─► 落盘 + activity_snapshots
                               │
                               └─► OCR（Swift/Vision，每 3 帧）─► 脱敏 ─► activity_ocr_frames
                                                                           │
                                                                 中文 2-gram 倒排索引
                                                                           │
当前回合的提问 ──────────────────────────► 检索（向量 0.40 / 词袋 0.25）──┘
                                              │
                                              └─► 注入尾部上下文（350ms 超时，不进系统提示词）
```

- **什么时候截**：心跳 120s、画面变化 12s、切应用 / 点击（事件驱动）、停手 1.2s；全局 4s debounce，
  空闲时指数降频（上限 5 分钟）。
- **三级判重**：FNV-1a 像素哈希（完全相同直接丢）→ 32 桶直方图（欧氏距离 < 0.05）→
  逐像素差分（差异 < 2%）。位图用 `sips` 转 BMP 自己解析；解码失败还有原始字节哈希兜底，
  判重不会因为解码问题而崩。
- **OCR 中文优先**：语言表是 `zh-Hans, zh-Hant, ja, en-US`，**顺序有语义** —— 反过来（en 优先）时
  Vision 对整屏中文只会回 `iX` 这类垃圾。
- **零安装**：Swift helper 用 `swiftc` 运行时编译，按源码 sha256 缓存到 `~/.dove/cache/ocr-<hash>`，
  首次几秒，之后直接复用。
- **中文 2-gram 倒排索引**：`node:sqlite` 的 FTS5 实测对中文无效（查「飞书」0 行），所以自己切词建索引。
- **检索两条腿**：装了 ONNX 模型走向量（阈值 0.40，用真实屏幕内容标定）；没装自动退化成词袋（0.25）。
- **存储自己轮转**：hot（1 天）→ warm（7 天，1280×720）→ cold（30 天，640×360）→ 删除，总量 10GB 上限。
- **日报 / 周报**：确定性骨架 + 模型叙事；骨架里没有的事实一律不许编。
- **没有屏幕录制权限时不静默失败**：明确告诉你，判重 / 脱敏 / 分析 / 报表照常可用。

> 长期记忆是同一套骨架的另一半：本地向量（bge-small-zh-v1.5）+ 词法 + 屏幕通道三路检索。
> 注入通道的阈值按后端分档（真向量 0.44 / 降级 0.12）—— **换模型必须重新标定**，
> 照抄别的项目的阈值（比如 0.75）会全部漏掉。

## 二、子代理：可导航的线程，不是黑盒

- **独立上下文**：主代理只看得到子代理的**最终答复**，所以子代理被要求写自包含结论
  （做了什么、发现什么、还差什么）。
- **工具白名单 + 步数上限**：默认 10 个工具（Bash / Read / Write / Edit / Glob / Grep /
  WebSearch / WebFetch / Skill / TodoWrite），上限 100 步；**最后一步强制作答**（`tool_choice=none`），
  不会无限跑下去。
- **过程落盘**：运行时写成一条 `kind='subagent'` 的子线程，界面复用主对话的历史回放路径 ——
  点进去能看到它的推理、每一次工具调用**和参数**。
- **前台 / 后台**：`Task run_in_background` 配合 `TaskOutput` 取结果；结果注回原线程用状态机防重复。
- **递归是故意挡住的**：子代理的工具白名单里没有 `Task`，现在是干净的**一层**。

## 三、还有这些

- **双层工具表**：工具描述每轮都要发给模型 —— 所以常驻 16 个，另外 7 个检索后才激活。
- **审批链**：本地规则先过，拿不准才交给模型；命令按 `&& || ; |` 切段，只读要求**每一段**都只读。
- **事件溯源**：模型可见 ⟺ 已落盘，同一份事件日志同时喂前端和模型。
- **前缀缓存友好**：静态段在前，易变内容（时间 / 情绪 / 记忆切片）走尾部注入 —— 实测命中 88–95%。
- **主动性**：cron（at / every / 5 段）+ heartbeat（30 分钟一次，`HEARTBEAT_OK` 抑制）。
- **生成与解析**：图片（fal.ai）、PPT、真 MP4（Swift + AVFoundation，**不需要 ffmpeg**）；
  文档走 PDFKit / `textutil`，PDF / docx / doc / rtf / odt / html 都能读。
- **MCP**：外部服务器的工具桥接后直接进工具表（`mcp__<server>__<tool>`），只追加在尾部。
- **版本**：每轮改过文件就自动 `git commit`；回滚入口在右侧「版本历史」，直接读 git 列表。

## 四、快速开始

需要 **Node 24+**（实测 25）。Swift 相关能力（屏幕 OCR / 视频 / PDF）需要 macOS + Xcode Command Line Tools。

```bash
git clone https://github.com/whitedoveliu/dove.git
cd dove

# 1) 密钥：在仓库根建一个 env（.gitignore 已挡住，不会提交）
#    变量名是历史遗留，实际放 OpenAI 兼容接口的 key
echo 'ANTHROPIC_API_KEY=你的key' > env

# 2) 构建界面（内核会托管 control-panel/dist）
cd control-panel && pnpm install && pnpm build && cd ..

# 3) 起内核并打开浏览器
./Dove.command          # → http://127.0.0.1:8790/
```

不想用启动器就手动起：

```bash
cd harness && npm start
```

**可选：向量模型**（不装的话记忆检索自动退化成字面匹配，阈值也换成降级档）

```bash
node --no-warnings harness/packages/embedding/scripts/fetch-model.mjs
```

## 五、架构

```
harness/                TS 内核（零构建：Node 原生跑 .ts，只做类型擦除）
  packages/core/          agent 循环 · 工具 · 记忆 · 子代理 · 权限 · 感知
  packages/server/        常驻 HTTP + SSE · 8008 老契约兼容层（control-panel 用）
  packages/prompts/       系统提示词的 11 个槽位（s01–s11，各自独立文件）
  packages/embedding/     本地向量检索（bge-small-zh-v1.5）
  scripts/                冒烟测试
control-panel/          界面（React 19 + Vite + Tailwind）
apps/desktop/           桌面壳（Tauri：内核作为 sidecar，窗口加载 8790）
```

依赖方向单向：`security → media → docs → embedding → providers → session → tools → memory →
context → activity → projects → loop → agent`，由 `harness/tools/lint-layering.mjs` 检查。

## 六、配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOVE_API_KEY` | 回退读仓库根 `env` 的 `ANTHROPIC_API_KEY` | 模型 key |
| `DOVE_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `DOVE_MODEL` / `DOVE_TOOL_MODEL` | `deepseek-flash` | 主模型 / 工具模型（审批分类、记忆抽取、查询改写、压缩摘要） |
| `DOVE_PORT` | `8790` | 内核端口 |
| `DOVE_WORKSPACE` | `~/DoveProjects` | 项目根目录 |
| `DOVE_CONFIG` | `~/.dove` | 记忆 / 会话 / 感知数据 / 缓存 |
| `DOVE_DB` | `harness/.data/dove.db` | SQLite |
| `DOVE_APPROVE` | `ask` | `ask` / `auto` / `deny`（CLI 与无人值守用 `auto`） |
| `DOVE_ACTIVITY` | 开 | 设 `off` 关掉屏幕感知 |
| `DOVE_OCR_EVERY` | `3` | 每 N 帧 OCR 一次（`1` 仅供联调，CPU 吃不消） |
| `TAVILY_API_KEY` | — | 配了 WebSearch 优先走它，没配退回抓 HTML |
| `FAL_KEY` | — | 配了才用 fal.ai 生图，否则出本地占位图并如实说明 |
| `DOVE_LEGACY_PORT` | `8008` | control-panel 写死的后端端口（兼容层） |

## 七、开发与验证

```bash
./verify.sh                # 全量：lint + 单测 + 冒烟 + 服务健康 + E2E
./verify.sh --quick        # 跳过 E2E

cd harness
npm run lint                                        # 文件大小 + 依赖方向
node --no-warnings --test packages/core/test/*.test.ts
node --no-warnings scripts/smoke-turn.ts            # 真调模型跑一轮对话
node --no-warnings scripts/smoke-screen-memory.ts   # OCR → SQLite → 索引 → 检索
node --no-warnings scripts/smoke-subagent.ts        # 子代理运行时
```

两个环境前提：`smoke-routes` 需要 **8790 空闲**，而 `verify.sh` 的健康检查和 E2E 需要内核**正在跑** ——
所以内核开着跑 `./verify.sh` 时，路由冒烟会以 `EADDRINUSE` 失败，那不是回归。

## 八、几个取舍

| 问题 | 选择 | 代价 / 放弃 |
|---|---|---|
| 工具描述每轮都要重发 | 常驻 16 + 按需 7，检索后才激活 | 模型天生不知道有什么可搜 —— `ToolSearch` 的描述必须**从工具列表生成**（手写过一版，漏了子代理，模型再没派过子代理） |
| 子代理跑很久又看不见 | 过程落盘成子线程，界面复用历史回放 | 多一层线程数据；过程不能塞进父消息的 parts，否则会被当成父代理自己的输出重新喂给模型 |
| 屏幕文本要能回忆 | 自建中文 2-gram 倒排索引 | FTS5 对中文实测无效，切词和折行合并都得自己处理 |
| 审批不能只看命令开头 | 按 `&& \|\| ; \|` 切段，逐段判定 | 只读白名单与危险黑名单两套规则都要维护，还得先剥离无害重定向 |
| 截屏很贵（CPU + 磁盘） | 三级判重 + hot/warm/cold 轮转 + 10GB 上限 | 判重要解位图（`sips` → BMP 自解析），好在失败还有字节哈希兜底 |
| 模型可见的必须可追溯 | 事件溯源：模型可见 ⟺ 已落盘 | 每轮多一次写库；崩溃修复要区分「结果未知」和「没执行」 |

## License

MIT
