# 老契约（legacy contract）

兼容层（8008 端口）服务的 `control-panel` 吃的是**旧 Python 版**的接口形状。
Python 代码已从仓库移除，这份文档是**目前唯一**的契约记录 —— 改兼容层前先看这里。

> 来源：`python/api_server.py`（路由）与 `python/agent_core.py`（SSE 事件）。
> 抽取时间：2026-10-08。原文可按这两个路径从 git 历史找回。

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
ask_user             向用户提问
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
/api/tts/voices
/api/versions
/preview/{project_id}/{file_path}
```

### POST
```
/api/browser_result
/api/chat
/api/clear-dove-cloud
/api/dialog/choose-folder
/api/import-project
/api/projects/attach
/api/projects/create
/api/projects/{port}/name
/api/projects/{port}/restart
/api/projects/{port}/start
/api/projects/{port}/stop
/api/reset-project
/api/retry
/api/set-preview-version
/api/stop
/api/switch-to-latest
/api/switch-version
/api/tts
/api/upload-file
/api/user-input
```

共 35 条。**兼容层不需要全实现** —— 只做 `control-panel` 实际在调的。
判断「实际在调哪些」用 `control-panel/src/lib/api.ts` 里的 fetch 调用为准。

---

## 新内核自己的 API（8790）

和上面这套**不是一回事**，别混：

```
/api/stream /api/stop /api/steer /api/approve /api/answer
/api/pending /api/projects /api/file /api/build /api/memory /api/health
/api/permission-presets /api/threads/{id}/messages
/api/projects/{port}/subagents /api/projects/{port}/permission
/api/logs/* /api/debug/*
```

设计纪律：新接口按资源命名，**不再沿用老契约的 `session_id` / 无参 `/api/stop` 那套**。
