<h1 align="center">
  <img src="control-panel/public/dove-icon-512.png" alt="Dove" width="76">
  <br>
  Dove
</h1>

<p align="center"><strong>A coding agent with screen memory</strong> — resident HTTP kernel, swappable UI.</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#-quick-start"><img src="https://img.shields.io/badge/Quick_Start-3_steps-blue?style=for-the-badge" alt="Quick Start"></a>
  <a href="#-tools-42"><img src="https://img.shields.io/badge/Tools-42-green?style=for-the-badge" alt="Tools"></a>
  <a href="#-verification"><img src="https://img.shields.io/badge/Tests-47_passing-brightgreen?style=for-the-badge" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/TypeScript-zero--build-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/macOS-Swift_helpers-000000?logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/UI-React_19_+_Tauri-61DAFB?logo=react&logoColor=white" alt="UI">
</p>

Dove is not a chat box wrapped around a model. It runs as a **resident process**: it watches your screen and turns
what it saw into searchable memory, delegates work to subagents, and snapshots every change into git.

```
change code  →  prove it builds  →  look at the result  →  roll back if you do not like it
```

## ✨ What makes it different

| | |
|---|---|
| 🧠 **Screen memory** | screenshot → 3-level dedupe → local OCR → redaction → inverted index → retrieval into the current turn |
| 🤖 **Subagents** | isolated context + tool whitelist + step cap; the run is persisted as a sub-thread you can click into |
| 📋 **Plan mode & goals** | `/plan` explores and proposes, and may only write after you approve; `/goal` keeps working across rounds |
| 🖥️ **Persistent terminal** | one shell stays alive, so `cd` / `export` survive; zero dependencies (no node-pty) |
| 🛡️ **Capability-based permissions** | read-only does not ask the model to behave — the write tools are removed from its tool table |
| 🧩 **Event-sourced** | what the model saw is what is on disk; unpaired tool calls become "unknown result", never replayed |

## 🔍 Screen memory

```
screencapture ─► dedupe (hash → histogram → pixel diff) ─► snapshots + SQLite
                          │
                          └─► OCR (Swift/Vision, every 3rd frame) ─► redact ─► ocr_frames
                                                                            │
                                                              CJK 2-gram inverted index
                                                                            │
current question ─────────────────────────► search (vector 0.40 / lexical 0.25) ─┘
                                                └─► injected into the tail context only (350ms budget)
```

- **Capture**: heartbeat 120s, visual change 12s, app focus / click, typing pause 1.2s; 4s global debounce, idle backoff up to 5 min.
- **OCR is Chinese-first** (`zh-Hans` before `en-US`). Reversed, Vision returns garbage such as `iX` for a screen full of Chinese.
- **FTS5 is useless for Chinese** (measured: 0 hits for 飞书), so the index is a self-built CJK 2-gram inverted index.
- **Retrieval has two legs**: local ONNX vectors (threshold 0.40) or bag-of-words (0.25). It never touches the system prompt.
- Snapshots rotate hot → warm → cold → deleted, capped at 10 GB.

## 🤖 Subagents

- The main agent only sees the **final answer**, so subagents must return self-contained conclusions.
- 10-tool whitelist, 100-step cap, and the last step is forced to answer (`tool_choice=none`).
- The run is persisted as a `kind='subagent'` thread: its reasoning and every tool call (with arguments) are replayable.
- `ListAgents` / `SendMessage` / `InterruptAgent`. Recursion is deliberately blocked — one clean level.

## 🏗️ Architecture

```
harness/                TS kernel (zero build: Node runs .ts natively, type-stripping only)
  packages/core/          agent loop · tools · memory · subagents · permissions · screen perception
  packages/server/        resident HTTP + SSE · legacy compat layer on 8008 (used by control-panel)
  packages/prompts/       11 system-prompt slots (s01–s11, one file each)
  packages/embedding/     local vector search (bge-small-zh-v1.5)
  scripts/                smoke tests (they really run things, not just pure functions)
control-panel/          UI (React 19 + Vite + Tailwind)
apps/desktop/           desktop shell (Tauri; resolves the kernel at runtime via DOVE_REPO → ~/.dove/repo → upward search)
```

One-way dependencies, enforced by `harness/tools/lint-layering.mjs`; files stay ≤ 400 lines (`lint-file-size.mjs`).

## 🚀 Quick start

Requires **Node 24+**. The Swift-backed abilities (screen OCR, video, PDF) need macOS + Xcode Command Line Tools.

```bash
git clone https://github.com/whitedoveliu/dove.git && cd dove

# 1) API key — create a file named env at the repo root (.gitignore already blocks it)
echo 'ANTHROPIC_API_KEY=your-key' > env    # the var name is legacy; the value is an OpenAI-compatible key

# 2) build the UI (the kernel serves control-panel/dist)
cd control-panel && pnpm install && pnpm build && cd ..

# 3) start the kernel and open the browser
./Dove.command          # → http://127.0.0.1:8790/
```

Prefer manual start: `cd harness && npm start`. Optional local embedding model:

```bash
node --no-warnings harness/packages/embedding/scripts/fetch-model.mjs
```

## ⚙️ Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DOVE_API_KEY` | falls back to `ANTHROPIC_API_KEY` in `env` | model key |
| `DOVE_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI-compatible endpoint |
| `DOVE_MODEL` / `DOVE_TOOL_MODEL` | `deepseek-flash` | main model / tool model (classifier, memory, compaction) |
| `DOVE_PORT` | `8790` | kernel port |
| `DOVE_WORKSPACE` | `~/DoveProjects` | projects root |
| `DOVE_CONFIG` | `~/.dove` | memory, sessions, screen data, cache |
| `DOVE_DB` | `harness/.data/dove.db` | SQLite file |
| `DOVE_APPROVE` | `ask` | `ask` / `auto` / `deny` |
| `DOVE_ACTIVITY` | on | set `off` to disable screen perception |
| `DOVE_OCR_EVERY` | `3` | OCR one frame out of N |
| `DOVE_REPO` | — | kernel repo for the desktop shell (or write one line to `~/.dove/repo`) |
| `TAVILY_API_KEY` | — | preferred WebSearch backend |

## 🧰 Tools (42)

| Layer | Count | Contents |
|---|---|---|
| CORE (always) | 15 | Read · Write · Edit · Glob · Grep · Bash · BashOutput · KillShell · Recall · Remember · Sleep · CurrentTime · ReadImage · GetContextRemaining · Present |
| SYSTEM (meta) | 10 | AttemptCompletion · AskUserQuestion · TodoWrite · ToolSearch · Skill · DispatchToProject · ExitPlanMode · CreateGoal · GetGoal · UpdateGoal |
| ON_DEMAND (retrieved) | 17 | WebSearch · WebFetch · Task · TaskOutput · ListAgents · SendMessage · InterruptAgent · ListMcpResources · ReadMcpResource · CronCreate · CronList · CronDelete · TerminalOpen · TerminalSend · TerminalRead · TerminalClose · TerminalList |

Every on-demand tool must declare a `discoverable` line — the `ToolSearch` description is **generated from that table**, and a test fails if one is missing.

## ✅ Verification

```bash
./verify.sh              # 15 checks: lint + 3 test suites + 7 smoke scripts + health + E2E
cd harness && npm test   # 47 tests: 38 core + 1 goal + 8 P0/wiring
```

Two environment prerequisites, not regressions: E2E needs an existing project; `smoke-routes` needs the kernel running on 8790.

## 🆚 Dove vs other agents

| Capability | Claude Code | Codex | DeepSeek Harness | Dove |
|---|---|---|---|---|
| Plan mode | Enter/ExitPlanMode | update_plan | plan mode | ✅ hard read-only: write tools are cut |
| Subagents | Agent + TaskStop | 9 control tools | subagent + fork | ✅ navigable sub-thread + control plane |
| Persistent terminal | TerminalCapture | write_stdin | terminal_* (node-pty) | ✅ zero-dependency PTY |
| Image input | ✅ multimodal Read | view_image | read_image | ✅ ReadImage (attached into the conversation) |
| Long-term memory | LocalMemoryRecall | — | — | ✅ local vectors + **screen memory** |
| Screen perception | — | — | — | ✅ unique to Dove |

## 📄 License

MIT
