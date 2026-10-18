<h1 align="center">
  <img src="control-panel/public/dove-icon-512.png" alt="Dove" width="72">
  <br>
  Dove
</h1>

<p align="center"><strong>A coding agent that runs as a resident kernel.</strong><br>Resident HTTP kernel · CLI, browser and desktop clients · 44 built-in tools</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="#-quick-start"><img src="https://img.shields.io/badge/Quick_Start-3_steps-blue?style=for-the-badge" alt="Quick Start"></a>
  <a href="#-features"><img src="https://img.shields.io/badge/Tools-44-green?style=for-the-badge" alt="Tools"></a>
  <a href="#-verification"><img src="https://img.shields.io/badge/Tests-366_passing-brightgreen?style=for-the-badge" alt="Tests"></a>
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
| 🐍 **PTC (RunScript)** | the model writes a TS/JS script that calls other tools; one approval covers the whole script, every call still re-enters the kernel |
| ⌨️ **`dove` CLI** | 18 subcommands against the resident kernel (`run` · `chat` · `approve` · `steer` · `undo` · `tools` …); `--json` emits NDJSON |
| 🤖 **Subagents** | four roles (`general` / `coder` / `explore` / `plan`) each with its own tool allow-list, 100-step cap, and a run you can click into; `resume` re-attaches the **same** context instead of starting over |
| 🔌 **Reattachable turns** | the kernel keeps a per-thread frame buffer for the latest turn; switch away and back — or reload mid-turn — and the missed thinking, tool lines and **pending approval card** are replayed instead of lost |
| 🛰️ **Background agents** | list + process endpoints and a panel page (status tabs, cards, the run itself); a background subagent outlives its parent turn's stream, and the on-disk terminal state always wins over a stale `running` |
| 🖥️ **Terminal & jobs** | one shell stays alive, so `cd` / `export` survive; background jobs keep the last 200,000 chars, stall at 90 s, auto-background at 60 s |
| 📋 **Goals with acceptance** | `criteria` are graded by an independent evaluator each round; empty evidence = automatic FAIL, failures are fed into the next round |
| 🛡️ **Permissions** | two axes (sandbox × approval) with three modes (`read-only` / `workspace-write` / `danger-full-access`); read-only removes the write tools from the tool table, `workspace-write` asks once before a write leaves the workspace, credential paths ask in every mode; approvals scan **every segment**, and script calls re-enter the same chain |
| 📝 **Project instructions** | `AGENTS.md` from config home, `~/.agents`, then repo root → cwd, each block tagged with a `<!-- From: path -->` anchor; over 32 KiB warns instead of truncating |
| 🔒 **Secret-path guard** | a hard deny list (SSH / cloud creds / `.env`, plus this repo's own `env`) that **never** becomes an approval prompt; Grep and Glob filter hits out instead of erroring |
| 🧩 **Event-sourced turns** | what the model saw is what is on disk; unpaired tool calls become "unknown result"; a turn with no output emits `interrupted` |
| 🗂️ **Per-thread journal + undo** | every thread gets its own append-only log (`seq` **is** the line number, large bodies go to blobs instead of being cut at 2 000 chars); `dove undo` marks turns as undone and deletes nothing |
| ⚖️ **Ordered approval chain** | seven named policies, first verdict wins; a tool can declare its own rule pattern (`Bash(rm *)`) so "allow and remember" is per-shape, not per-tool |
| 🧵 **Conflict-aware scheduling** | tools declare which paths they touch; read-only calls run in parallel, writes to an overlapping path serialise, submission order never jumps the queue |
| 📉 **Turn net-diff** | `Write` / `Edit` self-report their mutations, so each turn yields one net diff per file (first `before` + last `after`), emitted as a `turn_diff` event |
| 🔔 **Notifications that keep the turn alive** | a background task finishing mid-turn is delivered through the steering channel, so the gate extends the turn and the model sees the result without waiting for the next prompt |
| 🔑 **Env stays in the environment** | a setting that came from an env var is never written to `model.json` (env > file > default), so a temporary secret cannot become a permanent file |

## 🤔 Why it is different

- **Its permissions are capability cuts.** Read-only does not instruct the model to avoid writing — the write tools are
  removed from its tool table before the turn starts, and approvals scan **every segment** of a command chain. A script
  call is never a way around this: `doveTool` re-enters the same approval chain.
- **Multi-step work is code, not chat.** A 4-step script that reads two files finishes in 5.5 s; before PTC, one
  deep-research turn of the same shape ran 76 steps / 14 min / 5.7M input tokens.
- **It runs with zero dependencies.** The kernel is plain Node 24 + `.ts` (no build step, no `node_modules`), and the
  persistent terminal gets a PTY from the system `script` binary instead of `node-pty`.

## 🚀 Quick start

Requires **Node 24+**. Video and PDF helpers need macOS with Xcode Command Line Tools.

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

Optional local embedding model. Without it, memory falls back to literal matching.
Both steps are needed — the model alone is not enough:

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
| Commands | `health` `status` `version` `up` `logs` `threads` `run` `chat` `stop` `steer` `approve` `pending` `answer` `tools` `skills` `goals` `goal` `undo` |
| Port discovery | `--port` > `DOVE_PORT` > `~/.dove/port` > scan 8790–8799 |
| Output | `--json` is NDJSON and never colored; notes go to stderr, so `dove run --quiet "…" > answer.txt` is a clean answer |
| Exit codes | `0` ok · `1` failure · `2` usage · `3` kernel unreachable · `4` kernel error · `130` interrupted |
| Discovery files | the kernel writes `~/.dove/port` and `~/.dove/api-spec.md` so other programs can find it |
| Approvals | asked inline in a TTY (`y/N`); `dove approve --allow` from another terminal; non-TTY only prints the hint |

## 🏗️ Architecture

```
harness/          kernel (Node runs .ts natively — no build step)
  bin/dove.mjs      CLI entry point (package.json `bin`)
  packages/cli/     CLI: port discovery · HTTP + SSE client · 18 subcommands
  packages/core/    loop · tools · memory · subagents · permissions
  packages/server/  HTTP + SSE · tool control plane · the legacy API the UI talks to
  packages/prompts/ 12 prompt slots (s01–s12; s12 = project AGENTS.md) + the swarm-mode addendum
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
| `DOVE_CONFIG` | `~/.dove` | memory, sessions, cache |
| `DOVE_DB` | `harness/.data/dove.db` | SQLite file |
| `DOVE_APPROVE` | `ask` | `ask` / `auto` / `deny` |
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
./verify.sh              # lint · full unit glob · 20 smoke scripts · 2 health · 2 E2E
cd harness && npm test   # 367 tests across 47 files (366 pass, 1 skipped)
```

The unit step runs the whole `packages/core/test/*.test.ts` glob. It used to name three files by hand, which
silently skipped `cache-usage` / `capture` / `mode` / `prefix` — "tests pass" was therefore a weaker claim than it
looked. It also now prints the pass/fail tally.

Smoke scripts real-execute the paths they claim to cover: `smoke-turn` `smoke-subagent` `smoke-memory`
`smoke-terminal` `smoke-mcp-resources` `smoke-context` `smoke-routes` `smoke-cli-exit` `smoke-cli` `smoke-ptc`
`smoke-jobs` `smoke-loop-audit` `smoke-goal-eval` `smoke-goal-events` `smoke-auth` `smoke-undo`
`smoke-legacy-files` `smoke-legacy-open-in-app` `smoke-preview` `smoke-stream`.

Failures that are environmental, not regressions: the two health checks and `smoke-routes` need a kernel on 8790;
E2E needs an existing project. `verify.sh` refuses to start if a smoke port is already taken — two concurrent
runs otherwise collide and look like code breakage.

## 🆚 Compared with

| | Claude Code | Codex | DeepSeek Harness | Dove |
|---|---|---|---|---|
| Plan mode | Enter / ExitPlanMode | update_plan | plan mode | ✅ write tools removed (hard read-only) |
| Subagents | Agent + TaskStop | 9 control tools | subagent + fork | ✅ navigable sub-thread + control plane |
| Persistent terminal | TerminalCapture | write_stdin | terminal_* (node-pty) | ✅ zero-dependency PTY |
| Tool-result budget | truncate + offload to a file | symmetric head/tail buffer (1 MiB) | — | ✅ per-line shaping **then** spill, head+tail preview |
| Conversation undo | `/rewind` (restores code too) | `ThreadRolledBack` markers | — | ✅ append-only marks; nothing is ever deleted |
| Approval memory | `allow` rules in `settings.json` | `exec_policy` amendments | — | ✅ session rules keyed by a tool-declared pattern |
| Project instructions | `CLAUDE.md` + path-scoped rules | `AGENTS.md` (32 KiB cap) | — | ✅ `AGENTS.md` + `<!-- From: -->` anchor reverse-lookup |
| Secret files | `permissions.deny` on Read | `deny` beats `write` beats `read` | — | ✅ read-side deny list, Grep/Glob filter instead of erroring |
| Prompt-cache discipline | cache stats + invalidation causes | stable synthetic ids, append-only world state | — | ✅ byte-exact rebuild + step markers (`wire-history.ts`) |

## 📄 License

MIT
