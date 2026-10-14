# 老契约（legacy contract）

兼容层（8008 端口）服务的 `control-panel` 吃的是**旧 Python 版**的接口形状。
Python 代码已从仓库移除，这份文档是**目前唯一**的契约记录 —— 改兼容层前先看这里。

> 权威来源：本目录 —— 路由见 `routes-*.ts`，SSE 事件见 `sse-compat.ts`；字段名以 `control-panel` 实际在读的为准。
> 抽取时间：2026-10-08。

---

## SSE 事件类型（`/api/chat` 流）

```
text                 正文增量
thinking             思考增量
log                  日志行
error                错误
stats                一轮结束的用量统计
tool_start           工具开始（tool + toolCallId）
tool_info            工具的参数摘要
tool_params          完整参数
tool_result          工具结果
tool_use             （Anthropic 风格的工具使用）
todo_update          待办清单更新
ask_user             向用户提问（**工具审批也复用这个形状** —— 带 `approval:true` 与
                     `remember_rule` 两个可选字段，见下面「同意并记住」）
turn_diff            本轮净 diff（files: [{path,added,removed,created,deleted}]、truncated、diff）
                     内核只在这轮**真有 Write/Edit 自报改动**时发；空 diff 不映射（面板不渲染空块）
                     兼容层收到后按 assistant 消息 id **落盘**一份，/api/history 回放时回填
                     （见下面「文件模块」—— 这是刷新后「每轮文件卡片」还在的唯一依据）
subagent             子代理/后台任务状态（done 时带 usage: {inputTokens,outputTokens}；没报则缺省）。
                     action: start|text|reasoning|tool|done|injected。
                     ⚠️ **只有调用、没有结果**（`tool` 那一支只带 tool + info）——
                     结果落盘在子代理的过程条目里，见下面「后台 Agent」一节
build_start          构建开始
build_error          构建错误
commit               提交
enabled              启用状态
ephemeral            临时消息
preview_ready        预览就绪
server_tool_use      服务端工具（旧）
web_search_result       \ 搜索类工具结果
web_search_tool_result  |
web_search_tool_result_error
text_editor_code_execution_tool_result
```

**兼容层的映射在 `sse-compat.ts`。** 新内核发的事件名与这里不同，
两边对不上的地方是历史 bug 高发区（字段名靠猜 → 界面空白）。

---

## HTTP 路由

### GET
```
/api/health
/api/history
/api/open-in-app/apps
/api/open-in-app/icon
/api/project-info
/api/project-status
/api/projects
/api/projects/{port}/exists
/api/projects/{port}/file
/api/projects/{port}/files
/api/projects/{port}/plan
/api/projects/{port}/session-log
/api/projects/{port}/session-log/stream
/api/projects/{port}/sessions
/api/projects/{port}/stat
/api/projects/{port}/subagents            （?status=recent|running|done|failed|all，见「后台 Agent」一节）
/api/projects/{port}/subagents/{id}       （单个子代理的元信息 + 过程条目，同上）
/api/threads/{threadId}/messages
/api/tts/voices
/api/versions
/preview/{project_id}/{file_path}
```

### POST
```
/api/browser_result
/api/capture
/api/chat
/api/dialog/choose-folder
/api/import-project
/api/open-in-app
/api/open-path
/api/projects/attach
/api/projects/create
/api/projects/{port}/name
/api/projects/{port}/restart
/api/projects/{port}/start
/api/projects/{port}/stop
/api/reset-project
/api/retry
/api/set-preview-version
/api/settings/model
/api/settings/model/test
/api/stop
/api/switch-to-latest
/api/switch-version
/api/tts
/api/upload-file
/api/user-input
```

共 44 条（GET 21 + POST 24；本轮的「打开方式」三条 `/api/open-in-app{,/apps,/icon}` 见下面「文件模块」；
`/stat` 与 `/open-path` 是更早一轮新增的两条，也在那一节；
GET 里的 `/api/projects/{port}/subagents*` 与 `/api/threads/{id}/messages` 见「后台 Agent」一节）。
**兼容层不需要全实现** —— 只做 `control-panel` 实际在调的。
判断「实际在调哪些」用 `control-panel/src/lib/api.ts` 里的 fetch 调用为准。
（`/api/settings/model*` 是**新加的**三条之一，不在最初那份 36 条清单里 —— 见下面「模型设置」。）

---

## 文件模块（面板右侧「文件」页与每轮文件卡片用）

**三条路径参数（`/files`、`/stat`、`/file` 的 `path=`）都按「项目根」判边界**，
走同一道硬闸（`path-guard.ts`：resolve → 存在性 → realpath）：

```
越界 / 软链指向项目外   403 {success:false, message:"拒绝：路径不在项目工作区内（…）"}
                        （或「拒绝：真实路径不在项目工作区内（…）」，realpath 之后的第二道）
不存在                 404（文案见各条）
```
`\` 会先归一化成 `/`（Windows 上它也是分隔符）。越界一律 403，**不是** 500，
也不告诉调用方目标存不存在 —— 以前只做 `join(proj.path, sub)`，`?path=../../../etc/hosts` 能读到整份文件。

### `GET /api/projects/{port}/files?path=`
列目录（懒加载目录树）。既有行为不变；软链判 `lstat`：指向项目外的**不列**，
单条 `stat` 失败（坏软链 / 竞态删除）降级成 `type:"file", size:0`，不让整层目录列表 500。

### `GET /api/projects/{port}/stat?path=`（新增）

只给元信息，**不读正文、不因大小被拒** —— 界面先知道多大，再决定要不要读、读多少。

```
200 {success:true, path, name, type:"file"|"dir", size, modified /* 秒，与 /files 同口径 */, language}
404 {success:false, message:"文件不存在: …"}
```

### `GET /api/projects/{port}/file?path=[&limit=N]`（新增可选参数）

```
不带 limit：老行为（>512KB → 413「文件超过 512KB，不预览」，content 为完整 UTF-8 文本）
带 limit ：只读前 N 字节（上限 8MiB），响应多一个 truncated:true，size 仍是**完整**大小
```
界面口径：>512KB 的文本只请求前 256KB，然后提示「只显示前 256KB / 共 X」——
一次性把超大文件塞进 DOM 会把面板拖死（这也是 `limit` 存在的唯一理由）。

### `POST /api/open-path`（新增）—— 「打开方式」菜单的后端

```
body: { path, action: "default" | "reveal", project_id? }
       · path 绝对路径或项目内相对路径；project_id 给了 → 它是边界，没给 → 工作区根是边界
       · project_id 认端口 / 项目 id / 目录名（三键查找）；字段名**只有**这一个
         （`port` 那个兜底没有消费者，已从实现里删掉 —— 见「不许建好没接」）
400 {ok:false, message:"缺少 path"}
400 {ok:false, message:"action 只认 default / reveal（收到 xxx）"}
200 {ok:true,  message:"已交给系统默认应用：/…"}
403 {ok:false, message:"拒绝：路径不在项目工作区内（/…）"}      ← 硬拒，不是提示词约束
403 {ok:false, message:"拒绝：真实路径不在项目工作区内（/…）"}    ← realpath 之后的第二道（防软链逃逸）
404 {ok:false, message:"文件不存在：/…"}
501 {ok:false, message:"当前平台（win32）不支持从面板打开系统应用"}
500 {ok:false, message:"打开失败（open）：…"}
```

**边界不只有一个根**：`DOVE_CONFIG`（默认 `~/.dove`）也在允许清单里 —— 设置里的
「打开记忆文件夹」开的就是它（SOUL / USER / MEMORY / HEARTBEAT / memory 日记都住在那里，
本来就在工作区之外）。实现是「先按 realpath 挑目标落在哪个允许根里（配置目录优先；
都不沾退回工作区根）」，挑中的根**照样过上面那三道闸** —— 挑根不是放宽边界，是换一个允许的边界。
挑中配置目录时文案换成 `拒绝：路径不在允许的目录（配置目录）内（/…）`（同上两处 403）。

- macOS：`open` / `open -R`（选中文件）；Linux：`xdg-open`（reveal 降级成「打开所在目录」）；
  其它平台**明确 501**，不猜命令。
- 一律 `execFile`（数组参数、不走 shell）+ 5s 超时：路径里带 `;` `$()` 只是普通字符。
- 实现：`routes-open-path.ts`；②③ 两道路径闸与 `/api/open-in-app` **共用同一份实现**
  （`path-guard.ts` 的 `guardOpenTarget`）——两条路由都会真的执行 `open`，判定不能有两份。

### `/api/open-in-app` ×3（新增）—— 右上角「打开方式」分体按钮的后端

```
GET  /api/open-in-app/apps       200 { apps: [{id, name, action: "open"|"reveal"}], platform }
GET  /api/open-in-app/icon?id=   200 image/png（Cache-Control: public, max-age=3600）
                                 404 {ok:false, message:"没有 <id> 的图标（App 不在清单/没装/抽图标失败）"}
POST /api/open-in-app            body: { appId, path, project_id? }
400 {ok:false, message:"缺少 path" | "缺少 appId"}
400 {ok:false, message:"清单里没有这个 App（或本机没装）：<appId>"}
403 / 404                        ← 与 /api/open-path 完全同一份路径守卫（上面三条）
404 {ok:false, message:"项目不存在（…）"}
501 {ok:false, message:"当前平台（linux）不支持用指定 App 打开（清单为空）"}
200 {ok:true,  message:"已用 Cursor 打开：/…"}
500 {ok:false, message:"打开失败（open）：…"}
```

- 清单是**数据表**（`open-in-app.ts` 的 `APP_TABLE`）：id / 名字 / bundle 候选 / 启动方式
  （`open -a <bundle>` 或 `open -R`）/ 目标（文件本身 or 所在目录）。macOS **只**在
  `/Applications` 与 `~/Applications` 里按 bundle 名找 —— 装在别处、改过名的探测不到（照实说）。
- **`appId` 是请求体里唯一能影响命令的东西**：bundle 路径一律来自探测结果，
  用户输入永远进不了 `open -a` 的参数位（否则这就是一条「让内核替我执行任意命令」的路）。
- 图标：`plutil` 读 `CFBundleIconFile` + `sips -Z 64` 转 PNG（系统自带，不引依赖）；
  结果按 bundle 缓存（含 null，与「装完新 App 要重启」同口径）。
- 平台：非 darwin 清单为空 + POST 501，面板据此退回原来的「打开方式」菜单（不变砖）。
- 实现：`routes-open-in-app.ts`（安全边界写在文件头）+ `open-in-app.ts`（表 / 探测 / 拼命令）
  + `open-in-app-icons.ts`（图标）。冒烟：`harness/scripts/smoke-legacy-open-in-app.ts`
  （launcher 是注入的，跑一遍**不会弹出任何窗口**）。

### 每轮文件改动（`turn_diff`）的落盘与回填

两个来源，回放时**前者优先**：

1. **内核自己**把这一轮的净 diff 快照写进 assistant 消息的 metadata
   （`Message.turnDiff = {files, truncated}`，见 core/src/session/types.ts）——
   这是权威来源，重启后还在（内核版本较新时才有）。
2. **兼容层**在收到 SSE 的 `turn_diff` 时按「这一轮那条 assistant 消息的 id」存进 SQLite 表
   `legacy_turn_files`（`turn-files-store.ts`；内核先落消息再发事件，所以事件到达时最新
   assistant 消息就是这一轮）。它多带一样内核不存的东西：**diff 正文**。

`GET /api/history` 的回放记录因此多三个可选字段：

```
turn_files: [{path, added, removed, created?, deleted?}]   // 这一轮改了哪些文件（展示用）
turn_diff: "…近似统一 diff 文本（≤20k 字符）…"              // 「展开 diff」用，刷新后不丢
turn_files_truncated: true                                  // 文件条目或正文被截断
```

一轮里有多条 assistant 消息时**合并**（同路径增删相加、diff 正文拼接）。
写入时顺带**老化**：每线程只保留最近 200 轮（`turn-files-store.ts` 的 MAX_TURNS_PER_THREAD ——
每行可带 20k diff 正文，不能只增不减）。
这张表在**三处**线程销毁点同步清理：`routes-project.ts` 的项目删除（:104）、项目重置（:324），
以及 `routes-threads.ts` 的 `DELETE /api/threads/{id}` —— 漏掉任何一处都会留下读不到的孤儿行。
面板侧读取顺序：**先持久化（`turn_files`），没有再用实时事件**（见 control-panel 的
`turn-files-card.tsx` 与 ChatPanel 的 `turn_files` 赋值）。

---

## 本地令牌（8008 的准入）

兼容层绑在 127.0.0.1 上，但「本机」不等于「自己人」：用户开着的任意网页都能往这里发请求。
所以除 `/api/health` 外，**所有 `/api/*` 都要带本地令牌**：

```
X-Dove-Token: <token>          // 首选（面板的 fetch 全走这条）
/api/xxx?token=<token>         // EventSource 这类发不了自定义头的消费者（session-log 的 SSE）
/preview/{port}/{path}?token=<token>   // <img>/<video>/<iframe> 只能走查询串（见下）
```

```
缺令牌 / 令牌不对  401 {"ok":false,"error":"unauthorized"}   // 这条**不带** CORS 头：跨源页面读不到响应体
/api/health       照常 200（不过闸：面板靠它判断内核在不在）
`/preview/*        要令牌（?token=）：它服务项目目录里的**任意文件**（含 .env），
                  点文件 / 点目录（路径任一段以 "." 开头）一律 403；
                  响应**不带任何 CORS 头**，跨源页面连读都读不到；
                  html / svg / xml 额外带 CSP 沙箱（与 8790 的预览路由、外站代理**同一份定义**，
                  见下面「新内核自己的 API」一节的说明）
Host 不是 loopback 字面量 → 403   // /api/* 与 /preview/* 都判（防 DNS rebinding，与 8790 同一套口径）
OPTIONS 预检      不过令牌闸门（浏览器发的预检不带自定义头，要了令牌面板自己都过不去）
```

> ⚠️ **面板侧的接线现状**（2026-10-13 改过一次，别再照着旧说法接线）：
> `/preview` 的 URL 必须带 `?token=`，而且它**没有** CORS 头 —— 跨源 `fetch` 读不到响应体。
> 面板现在的分工（实现在 `control-panel/src/lib/preview-url.ts` 的文件头 + `projectFileUrl`）：
>   · **HTML 文档**（相对子资源继承不到查询串）→ 走**面板同源**的
>     `/api/preview/project/{项目键}/<rel>`（8790，**不**走令牌，靠同源 + 项目键 + 点段 403 自守）；
>   · **图片 / 音视频 / PDF**（没有相对子资源）→ 走 8008 的 `/preview/{port}/<rel>?token=`（跨源更安全）；
>   · **下载 / 另存** → 走**面板同源、令牌走头**的 `/api/file/download?projectId=&path=`
>     （同源才读得到响应体；它在令牌闸门之内，所以点文件也照给）。
> 三条路由的详细理由见各自源码注释；改闸门时三条一起看。

令牌在内核启动时生成/复用：`<DOVE_CONFIG>/api-token`（0600，64 个 hex）。
面板不直接读文件 —— 它问内核的 **8790**：`GET /api/local-token → {"token":"…"}`。
那条路由只对**自己人**回 CORS 头：**同源**（Origin 与 Host 逐字相同）与**面板源白名单**
（只有自测静态服务 3055，或内核的 `DOVE_PANEL_ORIGINS`）——
本机别的端口（任意一个 loopback 页面）都读不到，否则令牌能被任一本地页面取走（令牌到手 ≈ 内核到手）。
开发态（vite 3006）**不在**白名单里：它取令牌走 vite 自己的代理（同源，不查 CORS），
而 3000–3099 是**项目 dev server** 的区间（那上面跑的是模型产出的网站）。
实现见 `packages/server/src/local-token.ts`（生成 / 校验）、`packages/server/src/panel-origin.ts`（谁算自己人）
与 `legacy/server.ts` 的「令牌闸门」。

---

## 模型设置（`/api/settings/model*`）

面板的「设置」对话框（左下角齿轮）与底部的模型 chip 共用这一套。落盘在
`<DOVE_CONFIG>/model.json`（0600），优先级是 **env > 文件 > 内置默认**：
env（`DOVE_BASE_URL` / `DOVE_MODEL` / `DOVE_API_KEY`，或仓库 env 文件里的 key）给过的字段
是**托管层** —— 运行期以它为准，面板改不动，而且**永远不会落盘**
（env 注入的密钥只活在进程里：磁盘是永久的，备份 / 同步盘 / 换机都能读到）。

```
GET  /api/settings/model
     200 {"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-flash",
          "hasKey":true,"keyMasked":"sk-…c32b","envFields":["apiKey"]}
     ⚠️ **永不返回 key 本体**。keyMasked 是给界面看的唯一形态。
     envFields = 被 env 接管的字段（面板可据此提示「这里被 env 锁了」）。

POST /api/settings/model            {"baseUrl"?, "model"?, "apiKey"?}
     200 {"ok":true,"baseUrl":"…","model":"…","hasKey":true,"keyMasked":"sk-…c32b","envFields":[]}
     400 {"ok":false,"error":"baseUrl 不是合法地址（api.deepseek.com）——要带 http:// 或 https://"}
     · baseUrl 必须是 http(s) 绝对地址；apiKey 传空串 = **没改**（面板拿不到原值，只能发空串）
     · env 托管的字段：保存被忽略（不校验、不落盘），运行期继续用 env 的值
     · 保存**立刻生效**：内核的 provider 每次 stream 现读设置（LiveModelProvider），
       不用重启；<configDir>/model.json 同时是下次启动的取值来源

POST /api/settings/model/test       {"baseUrl"?, "model"?, "apiKey"?}   // 都可选：测「还没保存的」值
     200 {"ok":true,"model":"deepseek-flash","latencyMs":401}
     200 {"ok":false,"error":"401 Unauthorized · 密钥无效 · Authentication Fails, …"}
     200 {"ok":false,"error":"连不上：ECONNREFUSED"}
     200 {"ok":false,"error":"超时（15s 内没有响应）"}
     400 {"ok":false,"error":"baseUrl 不是合法地址（nope）…"}
     · 真打一次 chat/completions（max_tokens:1、非流式），15s 超时
     · 失败**不当异常**：一律 200 + ok:false（面板直接把 error 显示在按钮旁边）
```

**纪律：key 只进文件、不进响应、不进日志。** 日志里只打掩码；`test` 的错误文本会把
网关原话擦一遍（有些网关会把整把 key 回在错误正文里）。

---

## 两个「请求级状态」的参数

### `POST /api/chat` 的 `body.mode`（可选）

面板的「+」菜单用它表达**这一轮的模式**，不再把模式文本塞进 `message`（用户原话必须保持原样）。

- 取值：`"plan" | "goal" | "swarm"`。**不传 = 今天的行为**（一个字节都不变）。
- 传了别的值 → `400 {"error":"mode 必须是 plan / goal / swarm"}`（静默忽略会让面板以为开关生效了）。
  空值（`undefined` / `null` / `""`）等同于不传 —— 前端「没选模式」序列化成空值是常态。
- `"swarm"`：这一轮在**用户消息之前**多落一条 `role:"user"` 的消息，内容是
  `<system-reminder>` + `packages/prompts/swarm-mode.md` 的正文 + `</system-reminder>`。
  它**不是**用户说的话：记录上带 `origin:"injection"` / `variant:"swarm-mode"`，
  `/api/history` 的条目也原样带这两个字段，面板按 `origin === "injection"` 过滤即可；
  模型侧照常可见（含这一线程之后的回放）。一轮只注入一次，与 step 数无关。
- `"plan"` / `"goal"`：只校验取值，不注入 —— 计划模式是线程 metadata，目标有自己的 store 与工具。

### `POST /api/capture`（无请求体）

面板「+」菜单的「截屏」：macOS 原生框选（`screencapture -i -x`），把一张 PNG 原样回给界面。

```
成功       200 {"ok":true,"name":"screenshot.png","mediaType":"image/png","data":"<base64 PNG>"}
用户取消   200 {"ok":false,"cancelled":true}     // Esc / 非零退出 / 超时被杀 / 空结果：都不是错误，面板保持安静
非 macOS   501 {"ok":false,"error":"只有 macOS 支持框选截屏"}
超过 6MiB  413 {"ok":false,"error":"截屏太大（超过 6 MB）"}
```

> ⚠️ macOS 上按 Esc 结束交互式截屏的形态是「退出码 0 + 0 字节文件」，所以**空结果 = 取消**（不是 500）。
> 一个无法从退出码区分的歧义：缺「屏幕录制」权限时同样会拿到空结果 → 那种情况下表现为静默无反应，
> 需要用户去 系统设置 → 隐私与安全性 → 屏幕录制 检查。这是有意接受的取舍。

纪律：**一次性、按需**。临时文件在 `finally` 里删掉；不落库、不写配置目录、不进记忆。
这里没有（也不要加）任何定时 / 循环采样。

---

## 「同意并记住」与子代理用量（本轮新增的三个字段）

### `POST /api/user-input` 的 `body.remember`（可选，布尔）

面板审批弹窗上勾了「同意并记住这个形状」再点「允许」时带上它：

```
{"session_id":"…","answer":"允许","remember":true}
```

- 只有**审批**那一支有意义：内核按这次调用的**形状**（工具自报的参数模式，如
  `Bash(rm -rf /tmp/x)`）写一条会话规则，之后同形状直接放行；不传 = **不记**。
- `ask_user` 的回答**不看这个字段**：回答提问时带上它不该有任何副作用。
- 形状串怎么来的：`sse-compat.ts` 在 `tool_start` 时按 toolCallId 记下 (工具, 入参)，
  审批时用工具的 `approvalRule` 算 —— 算不出来就**不给** `remember_rule`，面板也不画那个选项。

### SSE 的 `ask_user` 附加字段（审批类）

审批复用 ask_user 的界面，多两个可选字段：

```
approval: true          // 这是审批，不是普通提问
remember_rule: "Bash(rm -rf /tmp/x)"   // 勾「记住」将落下的规则形状（逐字 = 工具自报的参数）；缺省 = 不给该选项
```

### `GET /api/projects/{port}/subagents` 的 `usage`

每行的 `usage` 从任务表（`metadata.taskId` → `TaskRegistry`）反查：
`{inputTokens, outputTokens}` 或 `null`。**null = 没记录 / provider 没报**（界面显示「未上报」，
不许显示 0）。实时通道（SSE `subagent` done 事件）里也带同一份 usage（内核本来就在发）。

---

## 后台 Agent：列表与过程（A7）

面板输入框上方的「后台 Agent」按钮 → 右侧面板的「后台 Agent」页（状态页签 + 卡片），
点一张卡片 → 面板里开一个 tab，内容是它的**运行过程**。

两条接口都是**只读派生**（`threads` 里 `kind='subagent'` 的行 + `messages.parts`，
实现是 `core/src/agents/subagent-report.ts` 的纯函数）—— 所以刷新、重启之后照样在，
内存里那份（`SubagentRun`）只是运行时的加速，不是第二个真相源。

### `GET /api/projects/{port}/subagents[?status=…]`

```
status: recent | running | done | failed | all      缺省 / 认不出 = all（老面板不带它，行为不变）
  running  只留还在跑的
  done     只留跑完的
  failed   error **和 canceled** —— 对用户来说两者都是「没干成」，分两个页签只会让人找不着
  recent   按开始时间**倒序**取前 20 条（概览，不是全量）
  all      全部，按开始时间**升序**（= 老面板看到的顺序，不能改）

200 {success:true, filter:"all", subagents:[{
      id, label, status, background, taskId, parentId, projectId,
      model,          // metadata.model；**没记 = null**（界面显示「未记录」）
                      //   ⚠️ 不退回 threads.model —— 那一列有 NOT NULL DEFAULT 'deepseek-flash'，
                      //      记录模型之前的老线程全是那个默认值，拿它当事实就是编造
      roleId, startedAt, finishedAt,
      durationMs,     // finishedAt - startedAt；**还在跑 = null**（界面拿 startedAt 自己走表）
      parts,          // 落盘的过程条数
      endReason,
      usage,          // 同上面那节：null = 没报（不是 0）
      projectPath,    // 项目根（卡片上那行仓库路径，面板自己截断）
    }]}
404 {success:false, message:"项目不存在"}
```

`status` 逐行归一成 `running | done | error | canceled | stale | unknown`（认不出就是 unknown，不猜）。

**`stale` = 「记录说它在跑，但它已经不在跑了」**：写这条记录的进程不是当前进程
（内核重启 / 崩过，线程上的 `running` 没人来得及改）。判据是 `metadata.ownerPid`
（`SubagentTranscript` 写入 `process.pid`）—— **没记过 ownerPid 的老记录不动**
（证明不了的事不猜，维持 running）。没有这一条，面板会为一个早已不在跑的子代理一直转圈，
而且它会永远卡在「进行中」页签里。`stale` 不算 `running`，也不算 `failed` ——
它只在「全部 / 最近」里出现（界面显示「已中断」）。

### `GET /api/projects/{port}/subagents/{id}`

```
200 {success:true,
     subagent: { …同上那一行的全部字段… },
     entries: [ { kind:"reasoning"|"text"|"tool", … } ],   // 顺序 = 发生顺序
     running: false }
404 {success:false, message:"子代理不存在（sub_xxx）"}
     · 不属于**这个项目**的 id 一律 404（归属按「项目 / 父线程」判，与列表同口径）——
       猜到了 id 也读不到别人家子代理的过程
```

条目形状（`entries` 的元素）：

```
reasoning / text : { kind, text }
tool             : { kind:"tool", tool, info, args, result?, ok?, at? }
                   · info   = 参数摘要，**和实时流用同一个 toolInfoLine**（两条路长一样）
                   · result = 工具结果（截到 2000 字符）；对象会被序列化
                   · ok     = true / false / 缺省（只记了调用、没有结论）
                   · at     = 这次调用开始的时间（毫秒）
```

⚠️ **两条边界，别当成 bug**：

1. **结果只在它结束之后才看得到**。过程 parts 是在 `SubagentTranscript.finish()` 时一次性落盘的
   （`addMessage` 没有增量更新语义），所以运行中的那个子代理 `entries` 多半是空的 ——
   实时过程走 SSE 的 `subagent` 事件（`action: start|text|reasoning|tool|done`），面板自己拼。
   同理，**工具结果不推实时流**：`subagent_tool` 只发调用（结果可能很长）。
2. `entries` 只来自 `role='assistant'` 的过程消息，`step-start` / `injection` / 图片这些
   **不进过程**（界面要的是「它想了什么、调了什么、拿到了什么」）。

---

## 新内核自己的 API（8790）

和上面这套**不是一回事**，别混：

```
/api/stream /api/stop /api/steer /api/approve /api/answer
/api/pending /api/projects /api/file /api/memory /api/health
/api/permission-presets /api/threads/{id}/messages
/api/projects/{port}/subagents /api/projects/{port}/permission
/api/logs/* /api/debug/*
/api/preview/proxy?url=…                    外站同源代理（剥 X-Frame-Options + 注入 base）
/api/preview/file?path=&projectId=          项目内单文件（query 形，注入的 base 指到下面那条）
/api/preview/file/<rel>                     项目内单文件（路径形；没项目键，靠「工作区根 + 各项目根」找）
/api/preview/project/<项目键>/<rel>          **项目作用域**路径形 —— 面板的 HTML 预览走它，
                                            相对子资源（./style.css）顺着路径解析回同一个项目
/api/file/download?projectId=&path=          原始字节（下载 / 另存；**在令牌闸门之内**，点文件照给）
```

`/api/preview/*` **不在**令牌闸门里（浏览器标签发不了自定义头），所以它自己把点段一律拒了
（`.env` / `.git/…` → 403，判据与 8008 共用 `preview-path.ts`）。
`/api/file/download` 反过来在闸门之内 —— 这两条的分工与其理由见 `routes-preview.ts` 的文件头。

**预览文档的沙箱（`PREVIEW_DOC_CSP`，`preview-path.ts` 是唯一一份定义）**：能在浏览器里跑脚本的
文档（`text/html` / `image/svg+xml` / `*xml`）一律带
`Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads`
（**不带** `allow-same-origin`）。为什么：8790/8008 的预览文档都是**面板同源**（相对子资源要求同源），
带 `allow-same-origin` 就等于把面板的 DOM / localStorage / `fetch('/api/local-token')` 交给这些页面
（令牌到手 ≈ 内核到手）—— 外站代理 `?url=` 更极端：用户随手打开的任何公网页面都从这条过。
面板侧 iframe 的 `sandbox` 属性只是同一件事的复述（顶层文档「在新窗口打开」时它管不到）。
代价（明说）：opaque origin 下 CORS 模式的加载失败（相对路径 fetch / XHR、`<script type="module">`、
本地 `@font-face`）；`<img>` / CSS / 经典 `<script src>` 不受影响。断言在 `smoke-preview.ts` 第 1/7 节
与 `smoke-legacy-files.ts` 第 4 节。

设计纪律：新接口按资源命名，**不再沿用老契约的 `session_id` / 无参 `/api/stop` 那套**。
