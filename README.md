<h1 align="center">
  <img src="control-panel/public/dove-icon-512.png" alt="Dove" width="72">
  <br>
  Dove
</h1>

<p align="center"><strong>A coding agent with screen memory.</strong><br>Resident HTTP kernel · swappable UI · 42 built-in tools</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="#-quick-start"><img src="https://img.shields.io/badge/Quick_Start-3_steps-blue?style=for-the-badge" alt="Quick Start"></a>
  <a href="#-features"><img src="https://img.shields.io/badge/Tools-42-green?style=for-the-badge" alt="Tools"></a>
  <a href="#-verification"><img src="https://img.shields.io/badge/Tests-47_passing-brightgreen?style=for-the-badge" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/TypeScript-zero--build-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/macOS-Swift_helpers-000000?logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/UI-React_19_+_Tauri-61DAFB?logo=react&logoColor=white" alt="UI">
</p>

Dove is not a chat box around a model. It runs as a **resident process**: it captures your screen and turns what it
saw into searchable memory, delegates work to subagents, and commits every turn that changed a file.

```
change code  →  build to prove it  →  look at the result  →  roll back if you do not like it
```

## ✨ Features

| | |
|---|---|
| 🧠 **Screen memory** | screenshots → 3-level dedupe → local OCR → CJK index → retrieved into the current turn |
| 🤖 **Subagents** | isolated context, 10-tool whitelist, 100-step cap; the run is a sub-thread you can click into |
| 📋 **Plan mode & goals** | `/plan` may only write after you approve; `/goal` keeps working across rounds |
| 🖥️ **Persistent terminal** | one shell stays alive, so `cd` / `export` survive; no native dependencies |
| 🛡️ **Permissions** | read-only removes the write tools from the tool table instead of asking the model to behave |
| 🧩 **Event-sourced** | what the model saw is what is on disk; unpaired tool calls become "unknown result", never replayed |

## 🤔 Why it is different

- **It remembers your screen, not just your files.** OCR frames are indexed with a self-built CJK 2-gram inverted
  index (FTS5 returns 0 hits for Chinese) and retrieved with two legs: local ONNX vectors at 0.40, or bag-of-words at 0.25.
- **Its permissions are capability cuts.** Read-only does not instruct the model to avoid writing — the write tools are
  removed from its tool table before the turn starts, and approvals scan **every segment** of a command chain.
- **It runs with zero dependencies.** The kernel is plain Node 24 + `.ts` (no build step, no `node_modules`), and the
  persistent terminal gets a PTY from the system `script` binary instead of `node-pty`.

## 🚀 Quick start

Requires **Node 24+**. Screen OCR, video and PDF helpers need macOS with Xcode Command Line Tools.

```bash
git clone https://github.com/whitedoveliu/dove.git && cd dove

# 1) API key — a file named env at the repo root (.gitignore blocks it)
echo 'ANTHROPIC_API_KEY=your-key' > env     # legacy name; put an OpenAI-compatible key here

# 2) build the UI (the kernel serves control-panel/dist)
cd control-panel && pnpm install && pnpm build && cd ..

# 3) start the kernel and open the browser
./Dove.command          # → http://127.0.0.1:8790/
```

Plain kernel instead of the launcher: `cd harness && npm start`.
Optional local embedding model (without it, memory falls back to literal matching):

```bash
node --no-warnings harness/packages/embedding/scripts/fetch-model.mjs
```

## 🏗️ Architecture

```
harness/          kernel (Node runs .ts natively — no build step)
  packages/core/    loop · tools · memory · subagents · permissions · screen perception
  packages/server/  HTTP + SSE, plus the legacy API the UI talks to
  packages/prompts/ 11 prompt slots (s01–s11)
  scripts/          smoke tests (they execute the real paths)
control-panel/    UI (React 19 + Vite)
apps/desktop/     Tauri shell (resolves the kernel at runtime: DOVE_REPO → ~/.dove/repo → upward search)
```

Dependencies point one way (`security → … → agent`), enforced by `harness/tools/lint-layering.mjs`;
every file stays ≤ 400 lines (`lint-file-size.mjs`).

## ⚙️ Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DOVE_API_KEY` | `ANTHROPIC_API_KEY` from `env` | model key |
| `DOVE_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI-compatible endpoint |
| `DOVE_MODEL` / `DOVE_TOOL_MODEL` | `deepseek-flash` | main model / tool model |
| `DOVE_PORT` | `8790` | kernel port |
| `DOVE_WORKSPACE` | `~/DoveProjects` | projects root |
| `DOVE_CONFIG` | `~/.dove` | memory, sessions, screen data, cache |
| `DOVE_DB` | `harness/.data/dove.db` | SQLite file |
| `DOVE_APPROVE` | `ask` | `ask` / `auto` / `deny` |
| `DOVE_ACTIVITY` | on | set `off` to disable screen perception |
| `DOVE_REPO` | — | kernel repo for the desktop shell |
| `TAVILY_API_KEY` | — | preferred WebSearch backend |

## 🧰 Tools (42)

| Layer | Count | Covers |
|---|---|---|
| CORE | 15 | files, search, shell, background jobs, memory, image input, context introspection, deliverables |
| SYSTEM | 10 | completion, questions, todos, tool search, skills, project dispatch, plan mode, goals |
| ON_DEMAND | 17 | web, subagents, MCP resources, scheduling, persistent terminals |

On-demand tools are activated by `ToolSearch`, whose description is **generated from the tool table** — a test fails
if a new on-demand tool forgets its one-line `discoverable` text.

## ✅ Verification

```bash
./verify.sh              # 15 checks: lint, 3 test suites, 7 smoke scripts, health, E2E
cd harness && npm test   # 47 tests: 38 core, 1 goal, 8 P0/wiring
```

Two failures are environmental, not regressions: E2E needs an existing project, and `smoke-routes` needs the kernel running on 8790.

## 🆚 Compared with

| | Claude Code | Codex | DeepSeek Harness | Dove |
|---|---|---|---|---|
| Plan mode | Enter / ExitPlanMode | update_plan | plan mode | ✅ write tools removed (hard read-only) |
| Subagents | Agent + TaskStop | 9 control tools | subagent + fork | ✅ navigable sub-thread + control plane |
| Persistent terminal | TerminalCapture | write_stdin | terminal_* (node-pty) | ✅ zero-dependency PTY |
| Screen perception | — | — | — | ✅ screenshot memory |

## 📄 License

MIT
