# Dove Harness 交付报告

> 日期：2026-10-05　|　状态：**M0–M7 + 安全底线 + 视频/MCP 全部完成**
> 依据：[harness-implementation-plan.md](../../docs/harness-implementation-plan.md)

---

## 0. 一句话结论

**一个新的、能干活、有记忆、前端可用的 Dove Agent 已经在 `harness/` 里跑起来了。**
3 个真实任务全部通过，其中任务 1 和任务 3 的表现超出计划预期（自查比设计要求的更严）。

```
128 个 TS 文件 · 16,613 行 · 4 个 Swift helper · 27 个工具
35/35 单测 · 2/2 lint · 单文件 ≤400 行（CI 强制）
自测 377 项全绿：
  上下文 49 · 记忆 44 · 主动性 83 · 感知 58
  · 视频 ✓ · 文档 18 · 输入监听 20 · MCP 70
```

---

## 1. 验收测试结果

### 任务 1 · 配色改造 ✅ 超出预期

**输入**：「把网站的配色改一下。现在的墨绿色太冷了，我更喜欢暖一点的，像老纸张那种感觉。改完帮我确认一下没问题。」

**Dove 做了什么**（83 秒 / 32 步 / 缓存命中 93%）：

| 动作 | 说明 |
|---|---|
| 读了 `MEMORY.md` | 从中拿到「讨厌高饱和、偏爱暖色」的偏好 |
| 改 `styles/main.css` 主题变量 | 墨绿 `#2F5D50` → 赭石棕 `#8A5A3B`，底 `#FAF7F2` → 老纸 `#F7F1E6` |
| **自己发现了两张写死色值的封面 SVG** | 这个陷阱我都没设计 —— 它扫出来的 |
| 跑 `npm run build` | 通过 |
| **写无头 Chrome 脚本逐像素扫描 4 个页面** | 确认「旧墨绿 0 px，新赭石正常出现」 |
| **算了对比度** | 主色上的白字 5.8:1，过 WCAG AA |
| 生成对比页 | `outputs/配色对比/index.html` 左右并排改色前后 |
| 更新记忆 | 把「不喜欢冷色做主色」写进 MEMORY.md + 日记 |

**产物**：`styles/main.css` 已改、构建通过、`outputs/` 下有对比页和两张预览图。

### 任务 2 · 新增页面 + 大文件读取 ✅ 通过

**输入**：「我想加一个「服务」页面…要接到导航里去，另外顺便看看我那个归档数据里到底有多少条记录。」

- 新建 `services.html`（4,451 字节），**5 个页面的导航全部同步**
- 归档数据答对：**1200 条** ✓
- **`.spill/` 里出现了 11KB 的存档文件** —— 证明输出预算在真实调用中触发了截断并落盘
- 顺手指出「这个文件现在没有任何页面引用它」
- 主动说明报价数字是占位、等用户给真实数字（**没有编造**）

### 任务 3 · 修复构建错误 ✅ 通过（而且很干净）

**输入**：「构建好像挂了…顺便把联系表单那个发不出去的问题也看一下。」

| 考点 | 结果 |
|---|---|
| 修好 CSS 花括号缺失 | ✓ 41 vs 41 配平 |
| 修好 `cover11.svg` 无效引用 | ✓ 已移除 |
| **没有靠改 `tools/build.mjs` 关掉检查蒙混过关** | ✓ 逐字节 diff 确认 build.mjs 未改 |
| 区分两个问题（构建错 vs 运行时 404） | ✓ 分开处理 |
| 表单问题诚实处理 | ✓ 改走 FormSubmit，并明确说明「需要你点激活信，在此之前表单会显示成功但收不到」 |

### 附加验证

| 项 | 结果 |
|---|---|
| **HTTP + SSE 真实契约**（浏览器走的那条路） | ✓ 7/7 断言通过 |
| SSE `id:` 断点续传 | ✓ 修复后通过 |
| 前端面板真机 | ✓ 无头 Chrome 打开真实内核托管的面板，React 正常挂载渲染 |
| 前缀缓存 | ✓ cache 224,768 / input 256,188 ≈ **88% 命中** |
| 工具结果落库为 parts | ✓ 22 个 part |
| 记忆写入 | ✓ Remember 工具落了 `decision / project:studio` |
| 崩溃修复逻辑 | ✓ 单测覆盖（未配对 tool_call 不重放） |

---

## 2. 实现清单（对照计划）

| 期次 | 计划内容 | 状态 |
|---|---|---|
| **M0** | 事件日志 / SQLite / parts 状态机 / 崩溃修复 / SSE 契约 / 录制回放 | ✅ 完成 |
| **M1** | 双层循环 / 四道闸门 / 看门狗 / steering / 幂等回执 / 空流守卫 | ✅ 完成 |
| **M2** | 分段装配 / 静态动态纪律 / mt 尾部注入 / 记忆切片 / provider 拆分 / AutoCompact | ✅ 完成 |
| **M3** | 注册表 / 归一化 / 调用修复 / 输出预算 / 审批链 / 动态激活 / 24 个工具 | ✅ 完成 |
| **M4** | 文件层 / EmbeddingProvider / 向量层 / 检索 / 写入 / 睡眠合并 / scope | ✅ 完成 |
| **M5** | 常驻 Home + 项目线程 / 构建 / 预览 / 版本 / 面板 | ✅ 完成 |
| **M6** | 子代理运行时 / 后台任务 / Task / 强制作答 / cron / heartbeat / 情绪 / 疲劳 | ✅ 完成 |
| **M7** | 感知（截屏 / 判重 / OCR / 脱敏 / 存储轮转 / 会话分析 / 日报） | ✅ 完成 |

**25 项核心机制全部就位。**

---

## 3. 过程中发现并修掉的 6 个真 bug

这些都是跑起来才暴露的，值得单独记一笔：

| # | Bug | 后果 | 修法 |
|---|---|---|---|
| 1 | **崩溃修复顺序错**：先修正状态再检测，`input-available` 已被改成 `output-error`，检测不到 | 未配对的 tool_call 永远不被报告，重启后可能重复执行副作用 | 改成先检测再修正 |
| 2 | **wire 历史漏配对**：非 `output-available` 的 tool part 被跳过，`tool_calls` 没有配对的 tool 消息 | provider 直接拒绝请求 | 所有状态都补一条结果消息 |
| 3 | **`ls 2>/dev/null` 被判定要审批** | 只读命令也弹窗，用户会被烦死 | 先剥离 `/dev/null`、`2>&1` 这类无害重定向再判断 |
| 4 | **完成守卫把答案说了两遍** | 每次任务型回合，模型被提醒「你没声明完成」后**把刚才的回答重写一遍** | ① 只在 `hadToolCalls` 时触发（纯聊天不需要声明完成）② 提醒里明确写「绝对不要重复上一条回复」 |
| 5 | **`routes` 拿不到 `running` map** | `/api/chat` 直接 500，前端完全不能用 | `main.ts` 补传参数 |
| 6 | **面板路径算错**（`packages/panel/dist` 而非 `apps/panel/dist`） | 内核起来了但面板 404 | 修正路径 |

> 第 4 个最有代表性：它不是「写错了」，而是**机制之间的相互作用**。
> 单看每一道闸门都是对的，但闸门 + 模型的自然反应 = 用户看到答案说两遍。
> 这种 bug 只有真的把 agent 跑起来才会发现 —— 这正是计划里坚持「M0 不碰 LLM、M1 才接模型」的价值。

---

## 4. 怎么用

```bash
cd harness

# 起内核（含面板）
node --no-warnings packages/server/src/main.ts
# → http://127.0.0.1:8790

# 命令行跑任务
DOVE_APPROVE=auto node --no-warnings scripts/run-task.ts dove-studio "把配色改成暖色"

# 走真实 HTTP/SSE（浏览器那条路）
node scripts/drive-http.mjs --fixture dove-studio "任务文本"

# 全部验证
npm test && npm run lint
node scripts/smoke-context.ts   # 49 项
node scripts/smoke-memory.ts    # 44 项
```

详见 [README.md](README.md)。

---

## 4.6 界面：保留 control-panel，一行没改

**我一开始走错了路** —— 从零写了一个深色面板。你要的是**保留原来的 control-panel**（浅色、DSH 风格那个）。
已改回：产品界面 = `control-panel/`，**它的源码一个字都没动**。

做法不是改界面，而是**在新内核上重新实现它要的后端契约**：

```
control-panel (源文件零改动)
   ↓  http://<host>:8008     ← 它硬编码的后端地址
packages/server/src/legacy/   ← 兼容层（新增）
   ↓  直接用同一份 Services
TS 内核（和在 8790 上跑的是同一个实例）
```

| 文件 | 作用 |
|---|---|
| `legacy/server.ts` | 8008 监听 + CORS + 端口↔项目映射 + `/preview/{port}/` 静态服务 |
| `legacy/sse-compat.ts` | 新内核事件 → 老词表（`reasoning`→`thinking`、`tool_start`→`tool_start`+`tool_info`+`tool_params`…） |
| `legacy/routes-chat.ts` | `/api/chat`(SSE) / `stop` / `user-input` / `browser_result` / `retry` |
| `legacy/routes-project.ts` | 项目 / 历史 / 版本 / 文件树 / 启停 / 上传 |

**契约里三处最容易写错、写错也不报错的地方**（都踩过）：

| # | 坑 | 后果 |
|---|---|---|
| 1 | `/api/history` 的 `is_modified` | 它是**前端版本号的唯一来源**。丢了 → 版本条、版本列表、切版本全废，但界面不报错 |
| 2 | `/api/history` 的 `commit_hash` | 没有它版本条是灰的、点不动 |
| 3 | 时间格式必须是 `"YYYY-MM-DD HH:MM:SS"` | 不是 ISO。前端 `new Date(str)` 直接吃 |

另外 `/api/stop` **无参数**，且页面关闭时走 `sendBeacon`（`text/plain`，不是 JSON）——
所以那条路由**绝不能强制解析 JSON body**，否则关页面时的停止会失败。

**验证**：真机 CDP 驱动，在界面里打字 → Enter → 看见回复渲染、带时间戳、无异常。`scripts/test-control-panel-ui.mjs` → **9/9 通过**。

> 我修的第一个版本测试是坏的：用「文本长度增长 30 字符」当判据，而「你好」只加 5 个字符 → 明明成功却报失败。
> 改成直接找 AI 回复正文。**测试写错比代码写错更危险 —— 它会让你以为东西是坏的。**

## 4.5 第三轮：把「完整」补到位

| 交付 | 说明 |
|---|---|
| **GenerateVideo（真 MP4）** | Swift + AVFoundation 直接编 H.264，**没有 ffmpeg 也不需要**。帧用 CGContext + CoreText 画（中文不乱码）；运行时 swiftc 编译缓存。实测 ftyp box 正确、`mdls` 读出 3s/1280×720、`qlmanage` 能出缩略图。首次全新编译 23.7s，热缓存 1.03s |
| **文档解析** | `textutil` 走 docx/doc/rtf/odt/html；Swift + PDFKit 走 PDF（逐页、支持页范围）。Read 工具接上后 PDF/docx 不再是「二进制文件」 |
| **全局输入监听（T7.4）** | Swift NSEvent 全局监听：**只记 keyCode + 修饰键，绝不记字符**。app 切换走 NSWorkspace（不需要辅助功能权限）。无权限时明确告知并继续跑；父进程 kill -9 后 helper 因 stdin EOF 自杀（实测无孤儿） |
| **MCP host（T3.12）** | JSON-RPC 2.0 over stdio；工具桥接成 `mcp__<server>__<tool>` **直接进工具表**（不是包一层 mcp_call）。只追加尾部保护前缀缓存；服务器崩溃自动摘工具且不影响其他 |
| **T8.1 回复层脱敏** | 脱敏规则上移到 `security/`；**流式脱敏器**保证密钥被切成多块也不漏；私钥块跨块整块扣住。命中记 `redacted` 事件 |
| **T8.2 只读权威** | 线程 metadata 一个开关 → 内核层裁掉 10 个工具（连 `DispatchToProject`/`Task` 都裁）。提示词明确：只读就是只读，报告/计划/副本/临时脚本都不许落盘 |

**第三轮又修了 3 个真 bug**：

| # | Bug | 后果 |
|---|---|---|
| 11 | **`ctx.services.project` 永远是 undefined** | ProjectBuild / ProjectPreview / VersionList / VersionRestore **全部失效**（返回 PROJECT_UNAVAILABLE）—— 这是接线时写的一句 `svc.projectOps ? undefined : undefined` |
| 12 | **预览端口不检查是否真的空闲** | 端口被别的进程占用时 EADDRINUSE，预览直接失败。改成用 `net.createServer` 真实探测，最多试 50 个端口 |
| 13 | **`stopAll` 漏掉静态服务**（第二轮修的） | 进程因句柄不释放挂住 |

> 第 11 个特别值得记：它**不报错、不崩**，只是安静地让四个工具全部退化。
> 如果没跑真实任务（"起预览给我看看效果"），根本发现不了。

## 5. 第二轮补上的（原「还没做」清单）

| 事项 | 结果 |
|---|---|
| **cron + heartbeat** | ✅ CronScheduler（at/every/5 段 cron、收据、单飞）+ Heartbeat（30min、8–23 点、`HEARTBEAT_OK` 抑制、in-flight 单飞） |
| **情绪 + 疲劳块** | ✅ base 6h / context 2h 衰减到基线 6，`0.3×base+0.7×context` 融合；纯时间驱动的疲劳；都渲染进 `mt` |
| **活动记录器（M7）** | ✅ 截屏 + 三级判重 + OCR（Swift/Vision 运行时编译）+ 脱敏 + 存储轮转 + 会话分析 + 日报 |
| **Home 只读硬实现** | ✅ 内核层工具裁剪（Home 拿不到 8 个写类工具），新增 `DispatchToProject` |
| **子代理后台模式** | ✅ `Task run_in_background` + `TaskOutput`；结果注回用原子 claim 防重复 |
| **图片真发进模型** | ✅ `context/images.ts` 按需重水化为 data URL，失败降级为文字提示 |
| **面板文件树接后端** | ✅ 面板侧已改（优先 `/api/files/:projectId`） |
| **文档解析工具** | ⬜ 仍未做（file/PDF part 降级为文本指引） |
| **T7.4 键鼠全局监听** | ⬜ 未做（`TriggerEngine.notify` 入口已留） |
| **桌面端权限 UI** | ⬜ 未做（内核侧已有 `openPermissionSettings()`） |

## 5.1 第二轮修掉的 4 个真 bug

| # | Bug | 后果 | 修法 |
|---|---|---|---|
| 7 | **情绪块的「为什么」把文件自己的注释当成了原因** | 用户看到「为什么：> 手改这个文件就能调我的心情…」 | 提取正文首行时跳过 `>` / `#` / 注释行 |
| 8 | **`PreviewManager.stopAll` 漏掉静态回退服务** | Node 进程因为 server 句柄不释放而挂住 | 一并遍历 `#static` |
| 9 | **没有 dev 脚本的项目预览直接失败** | 纯静态站点/产物目录看不了 | 新增 `projects/static-server.ts` 回退，无 dev 脚本时直接静态服务 |
| 10 | **Home 的写能力只靠提示词约束** | 迟早会写 | 改成内核层工具裁剪（`tool-policy.ts`），Home 根本没有写类工具 |

## 5.2 第二轮新增的验证

| 项 | 结果 |
|---|---|
| **cron 端到端**（每 2 秒的任务跑 7 秒） | ✓ 触发 3 次、真实 LLM 产出、一次性任务触发后 `enabled=false` 且有收据 |
| **Home 只读 + 调度**（D8 产品形态） | ✓ 只读问题零写入；派发时写操作全部发生在项目线程 |
| **真实截屏** | ✓ 屏幕录制权限已获得，实测截到 2560×1662 / 385KB，判重生效 |
| **日报生成** | ✓ 骨架 + 叙述，且对「尚未分析」的时段如实说明而不是编造 |
| **静态预览回退** | ✓ 5 个路径全部 200（html/css/svg/目录列表） |

---

## 6. 需要你知道的两个判断

**① 完成守卫每轮多花一次模型调用。**
任务型回合结束后，Dove 会收到一句「你没声明完成」，然后调 `AttemptCompletion`。
代价是每轮多一次往返（约 10–20 秒、约 10k token），收益是外层循环能拿到干净的完成信号。
嫌慢就把 `constants.ts` 的 `COMPLETION_GUARD_RETRIES` 改成 0。

**② 夹具项目里的 `MEMORY.md` 是「项目内容」，不是 Dove 的记忆。**
跑任务 1 时发现：Dove 是从项目里的 `MEMORY.md` 读到偏好的（用 Read 工具），
而它自己的记忆在 `DOVE_CONFIG` 目录（`~/.dove`）。两者容易混。
已改提示词（`s07-global-config.md`）明确告诉它「项目目录是你的作品，不是你的脑子」，
但长期看应该在面板上把两者分开展示。
