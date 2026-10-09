#!/bin/bash
# ============================================================================
# Dove 启动器 ——「打开即最新」，并且自己负责把服务拉起来、看住
#
#   1. 面板（Vite dev server, :3006）：没起就起，挂了就重启
#   2. agent API（FastAPI, :8008）：没起就起，挂了就重启；起了就告诉桌面壳别重复拉
#   3. 桌面壳（Tauri debug 构建）：直接读本地 dev server，所以永远是最新代码
#   4. 关掉窗口时，把自己拉起来的服务一并收走（别人的服务不动）
#
# 因此：改完代码重新打开就是最新的；窗口开着时 Vite HMR 还会即时热更。
# 只有改了 Rust 壳（apps/desktop/src-tauri/src/*.rs）才需要 ./scripts/dove.sh --build
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"; mkdir -p "$LOG_DIR"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

PANEL_PORT=3006
API_PORT=8008
APP_BIN="$ROOT/apps/desktop/src-tauri/target/debug/dove"
PID_DIR="${TMPDIR:-/tmp}/dove"; mkdir -p "$PID_DIR"

PANEL_PID=""; API_PID=""
port_open() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }
say() { printf '[dove] %s\n' "$1"; }

# ------------------------------------------------------------------ 启动服务
start_panel() {
  [ -n "$PANEL_PID" ] && kill -0 "$PANEL_PID" 2>/dev/null && return 0
  if port_open $PANEL_PORT; then say "面板已在 :$PANEL_PORT（外部进程），复用"; return 0; fi
  say "启动面板 dev server (:$PANEL_PORT)…"
  ( cd "$ROOT/control-panel" && exec pnpm dev >> "$LOG_DIR/control_panel.log" 2>&1 ) &
  PANEL_PID=$!
  for _ in $(seq 1 60); do port_open $PANEL_PORT && break; sleep 0.5; done
  port_open $PANEL_PORT && say "面板就绪 (pid $PANEL_PID)" || say "⚠️ 面板启动超时，见 logs/control_panel.log"
}

start_api() {
  [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null && return 0
  if port_open $API_PORT; then say "agent API 已在 :$API_PORT（外部进程），复用"; return 0; fi
  say "启动 agent API (:$API_PORT)…"
  ( cd "$ROOT/python" && exec ./venv/bin/python api_server.py >> "$LOG_DIR/api_server.log" 2>&1 ) &
  API_PID=$!
  for _ in $(seq 1 60); do port_open $API_PORT && break; sleep 0.5; done
  port_open $API_PORT && say "API 就绪 (pid $API_PID)" || say "⚠️ API 启动超时，见 logs/api_server.log"
}

cleanup() {
  say "收尾：关闭本次启动的服务"
  [ -n "$PANEL_PID" ] && kill "$PANEL_PID" 2>/dev/null
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  pkill -P "$PANEL_PID" 2>/dev/null
  pkill -P "$API_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- 可选重建
if [ "${1:-}" = "--build" ] || [ ! -x "$APP_BIN" ]; then
  say "构建桌面壳（约 1-3 分钟）…"
  ( cd "$ROOT/apps/desktop/src-tauri" && "$HOME/.cargo/bin/cargo" build ) || { say "❌ 构建失败"; exit 1; }
fi

start_panel
start_api
export DOVE_NO_SIDECAR=1   # API 已由启动器保证，桌面壳不用再拉一个

# ------------------------------------------------------------ 打开窗口 + 守护
say "打开 Dove 窗口…"
cd "$ROOT"
"$APP_BIN" &
APP_PID=$!

while kill -0 "$APP_PID" 2>/dev/null; do
  sleep 5
  if ! port_open $PANEL_PORT; then
    say "⚠️ 面板掉了，重启中…"; PANEL_PID=""; start_panel
  fi
  if ! port_open $API_PORT; then
    say "⚠️ API 掉了，重启中…"; API_PID=""; start_api
  fi
done

wait "$APP_PID" 2>/dev/null
say "窗口已关闭"
