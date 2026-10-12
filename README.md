<h1 align="center">
  <img src="control-panel/public/dove-icon-512.png" alt="Dove" width="72">
  <br>
  Dove
</h1>

<p align="center"><strong>A coding agent with screen memory.</strong><br>Resident HTTP kernel · CLI, browser and desktop clients · 44 built-in tools</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="#-quick-start"><img src="https://img.shields.io/badge/Quick_Start-3_steps-blue?style=for-the-badge" alt="Quick Start"></a>
  <a href="#-features"><img src="https://img.shields.io/badge/Tools-44-green?style=for-the-badge" alt="Tools"></a>
  <a href="#-verification"><img src="https://img.shields.io/badge/Tests-59_passing-brightgreen?style=for-the-badge" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/TypeScript-zero--build-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/macOS-Swift_helpers-000000?logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/UI-React_19_+_Tauri-61DAFB?logo=react&logoColor=white" alt="UI">
</p>

Dove is not a chat box around a model. It runs as a **resident process**: the CLI, the browser and the desktop shell
are clients of the same kernel over HTTP — one memory, one session store, one set of approvals.

```
change code  →  build to prove it  →  look at the result  →  roll back if you do not like it
```

## ✨ Features

| | |
|---|---|
| 🧠 **Screen memory** | screenshots → 3-level dedupe → local OCR → CJK index → retrieved into the current turn |
| 🐍 **PTC (RunScript)** | the model writes a TS/JS script that calls other tools; one approval covers the whole script, every call still re-enters the kernel |
| ⌨️ **`dove` CLI** | 17 subcommands against the resident kernel (`run` · `chat` · `approve` · `steer` · `tools` …); `--json` emits NDJSON |
| 🤖 **Subagents** | isolated context, 10-tool whitelist, 100-step cap; the run is a sub-thread you can click into |
| 🖥️ **Terminal & jobs** | one shell stays alive, so `cd` / `export` survive; background jobs keep the last 200,000 chars, stall at 90 s, auto-background at 60 s |
| 📋 **Goals with acceptance** | `criteria` are graded by an independent evaluator each round; empty evidence = automatic FAIL, failures are fed into the next round |
| 🛡️ **Permissions** | read-only removes the write tools from the tool table; approvals scan **every segment**, and script calls re-enter the same chain |
| 🧩 **Event-sourced turns** | what the model saw is what is on disk; unpaired tool calls become "unknown result"; a turn with no output emits `interrupted` |

## 🤔 Why it is different

- **It remembers your screen, not just your files.** OCR frames are indexed with a self-built CJK 2-gram inverted
  index (FTS5 returns 0 hits for Chinese) and retrieved with two legs: local ONNX vectors at 0.40, or bag-of-words at 0.25.
- **Its permissions are capability cuts.** Read-only does not instruct the model to avoid writing — the write tools are
  removed from its tool table before the turn starts, and approvals scan **every segment** of a command chain. A script
  call is never a way around this: `doveTool` re-enters the same approval chain.
- **Multi-step work is code, not chat.** A 4-step script that reads two files finishes in 5.5 s; before PTC, one
  deep-research turn of the same shape ran 76 steps / 14 min / 5.7M input tokens.
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
Talk to the same kernel from the terminal:

```bash
cd harness && npm link                          # puts `dove` on PATH (without it: node bin/dove.mjs)
dove health                                     # port · model · tools · threads
dove run "fix the failing test" --thread <id>   # one turn, streamed to stdout
dove approve --allow                            # answer pending approvals headlessly
```

Optional local embedding model. Without it, memory falls back to literal matching and the screen-memory
vector leg stays off (lexical matching still works). Both steps are needed — the model alone is not enough:

```bash
# 1) the one external dependency, isolated in that package (this is what loads the ONNX runtime)
cd harness/packages/embedding && npm install && cd -

# 2) the model itself (~24 MB)
node --no-warnings harness/packages/embedding/scripts/fetch-model.mjs
```

The kernel reports which backend it got on every start (`向量后端: onnx:bge-small-zh-v1.5` vs `hash-1024`).

## ⌨️ CLI

The CLI is a client: it never starts a second kernel, it finds the running one and talks HTTP.

| | |
|---|---|
| Commands | `health` `status` `version` `up` `logs` `threads` `run` `chat` `stop` `steer` `approve` `pending` `answer` `tools` `skills` `goals` `goal` |
| Port discovery | `--port` > `DOVE_PORT` > `~/.dove/port` > scan 8790–8799 |
| Output | `--json` is NDJSON and never colored; notes go to stderr, so `dove run --quiet "…" > answer.txt` is a clean answer |
| Exit codes | `0` ok · `1` failure · `2` usage · `3` kernel unreachable · `4` kernel error · `130` interrupted |
| Discovery files | the kernel writes `~/.dove/port` and `~/.dove/api-spec.md` so other programs can find it |
| Approvals | asked inline in a TTY (`y/N`); `dove approve --allow` from another terminal; non-TTY only prints the hint |

## 🏗️ Architecture

```
harness/          kernel (Node runs .ts natively — no build step)
  bin/dove.mjs      CLI entry point (package.json `bin`)
  packages/cli/     CLI: port discovery · HTTP + SSE client · 17 subcommands
  packages/core/    loop · tools · memory · subagents · permissions · screen perception
  packages/server/  HTTP + SSE · tool control plane · the legacy API the UI talks to
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
| `DOVE_AUTO_BACKGROUND_MS` | `60000` | foreground Bash without an explicit timeout becomes a background job |
| `DOVE_JOB_STALL_MS` | `90000` | no output for this long marks a job `stalled` |
| `DOVE_REPO` | — | kernel repo for the desktop shell |
| `TAVILY_API_KEY` | — | preferred WebSearch backend |

## 🧰 Tools (44)

| Layer | Count | Covers |
|---|---|---|
| CORE | 17 | files, search, shell, background jobs, memory, image input, context introspection, deliverables, PTC |
| SYSTEM | 10 | completion, questions, todos, tool search, skills, project dispatch, plan mode, goals |
| ON_DEMAND | 17 | web, subagents, MCP resources, scheduling, persistent terminals |

On-demand tools are activated by `ToolSearch`, whose description is **generated from the tool table** — a test fails
if a new on-demand tool forgets its one-line `discoverable` text.
The tool control plane is `GET /api/tools/list` (loopback, read-only — this is what `dove tools` reads) and
`POST /api/tools/invoke`, which requires a live script session + token: no credentials, `403`, no exceptions.
Reading a `SKILL.md` pre-checks its `requires.bins` / `requires.env` and warns at the top of the body when something is missing.

## ✅ Verification

```bash
./verify.sh              # 21 checks: lint, 3 test suites, 13 smoke scripts, 2 health, 2 E2E
cd harness && npm test   # 59 tests: 38 core, 12 fixes, 1 goal, 5 P0, 3 wiring
```

New this round: `smoke-cli` · `smoke-ptc` · `smoke-jobs` · `smoke-loop-audit` · `smoke-goal-eval` · `smoke-goal-events`.
Failures that are environmental, not regressions: the two health checks and `smoke-routes` need the kernel running
on 8790; E2E needs an existing project.

## 🆚 Compared with

| | Claude Code | Codex | DeepSeek Harness | Dove |
|---|---|---|---|---|
| Plan mode | Enter / ExitPlanMode | update_plan | plan mode | ✅ write tools removed (hard read-only) |
| Subagents | Agent + TaskStop | 9 control tools | subagent + fork | ✅ navigable sub-thread + control plane |
| Persistent terminal | TerminalCapture | write_stdin | terminal_* (node-pty) | ✅ zero-dependency PTY |
| Screen perception | — | — | — | ✅ screenshot memory |

## 📄 License

MIT
