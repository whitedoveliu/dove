# Dove 面板（apps/panel）

Vite + React 19 + TypeScript + Tailwind v4 手写前端（零组件库）。构建产物在 `dist/`，由内核静态托管。

## 运行

```bash
npm install
npm run dev      # http://localhost:5273 ，/api 代理到 http://127.0.0.1:8790
npm run build    # tsc --noEmit && vite build → dist/
npm run preview  # 预览 dist/
```

生产形态：内核起在 8790，静态服务本目录 `dist/`（`base: "./"`，可挂在任意子路径）。

## 目录

- `src/lib/`：api 客户端、SSE 解析、事件→消息状态机（chat）、历史 parts 映射（history）、文件清单派生（tree）、格式化与轻量 Markdown
- `src/hooks/`：useHarness（健康/会话/项目/记忆）、useChat（流 + 停止/回答/审批）、useLogs（日志轮询）、useStatus（情绪 / 疲劳轮询）
- `src/components/`：Sidebar / ChatView / MessageList / ToolCallCard / Composer / Dialogs / WorkspacePanel + FilesTab（FileTree / 文件预览）/ PreviewPane / MemoryPanel / CronPanel / LogsPanel / StatusPills / ActivityBlock

## 与后端的约定（面板侧实现）

- `POST /api/chat` 请求体为 `{ threadId, message, content, projectId }` 超集（`message` 与 `content` 同值），内核取用其一即可。
- SSE：`id: <seq>` + `data: {...}`，事件块以空行分隔；未知 `type` 一律忽略，`done` 收尾。`tool_result.result` 为 `{ ok:false }` / `{ isError:true }` / `{ error:"..." }` 时卡片显示失败。
- `GET /api/threads/:id/messages` 走内核 parts 模型（`parts[]`：`text` / `reasoning` / `tool-<name>`）；也兼容 `{ role, content }` 简形。
- 右侧「文件」树优先走后端：`GET /api/files/:projectId`（等价于 `GET /api/projects/:id/tree`），点文件用 `GET /api/file?projectId=&path=` 取内容；没有 projectId 或接口不可用时，回退到从对话工具入参（`file_path` / `path` / …）派生，界面标注来源。
- 「记忆」tab：`GET /api/memory`（kind / scope / content / score，搜索为前端过滤）、`POST /api/memory/sleep`（睡眠合并统计）、`GET|POST /api/config/file`（SOUL.md / USER.md / MEMORY.md / HEARTBEAT.md 的读写）。
- 「任务」tab：`GET|POST /api/cron`、`DELETE /api/cron/:id`、`POST /api/cron/:id/run`、`GET /api/cron/history`、`POST /api/heartbeat`。内核没暴露 enable 路由，启用开关用「DELETE + 复用同一 jobId 重建」实现，历史不丢。
- 顶部状态条的情绪（`GET|POST /api/emotion`）与疲劳（`GET|POST /api/fatigue`）、侧栏「感知」区块（`GET /api/activity/status`、`POST /api/activity/capture`、`GET /api/activity/report?kind=daily|weekly`）：M6/M7 服务未接入时这些接口返回 `{ available:false }`，面板直接隐藏指示器（情绪 / 疲劳）或显示「未接入 / 未启用」说明（感知 / 任务），不报错、不白屏。屏幕录制权限缺失时按内核 `SCREEN_PERMISSION_HINT` 给出开启指引。
- 工作区 tab 支持 `#files` / `#preview` / `#memory` / `#tasks` / `#logs` 深链。
- `GET /api/preview/:id` 返回的 `url` 支持绝对地址与 `/` 开头的同源相对地址。
- 列表类接口兼容裸数组与 `{ items: [...] }`。
