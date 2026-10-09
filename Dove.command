#!/bin/bash
# Dove 启动器 —— 双击即可打开
#
# 做三件事：① 没在跑就把内核起起来 ② 等它就绪 ③ 打开浏览器
# 关闭：在这个终端窗口按 Ctrl+C，或者直接关掉窗口
set -e
cd "$(dirname "$0")"

PORT="${DOVE_PORT:-8790}"
URL="http://127.0.0.1:${PORT}/"

echo "════════════════════════════════════════"
echo "  Dove"
echo "════════════════════════════════════════"
echo

# 找一个 node
NODE="${DOVE_NODE:-}"
if [ -z "$NODE" ]; then
  for c in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
if [ -z "$NODE" ]; then
  echo "✗ 找不到 node。装一个 Node 24+，或设置 DOVE_NODE 指向它。"
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi
echo "  node: $NODE  ($("$NODE" --version))"

# 已经在跑就直接开浏览器
if curl -s -m 2 "${URL}api/health" >/dev/null 2>&1; then
  echo "  内核已在运行，直接打开"
  open "$URL"
  echo
  echo "  $URL"
  exit 0
fi

# 向量模型（可选，没有就走降级）
if [ ! -f "$HOME/.dove/models/Xenova/bge-small-zh-v1.5/onnx/model_quantized.onnx" ]; then
  echo "  ⚠ 向量模型没下（记忆检索会退化成字面匹配）"
  echo "    想下的话跑：node --no-warnings packages/embedding/scripts/fetch-model.mjs"
fi
echo

# 起内核
echo "  正在启动内核…"
DOVE_PORT="$PORT" "$NODE" --no-warnings packages/server/src/main.ts &
HARNESS=$!

# 退出时收干净
cleanup() {
  echo
  echo "  正在停止…"
  kill "$HARNESS" 2>/dev/null || true
  wait "$HARNESS" 2>/dev/null || true
  echo "  已停止"
}
trap cleanup EXIT INT TERM

# 等就绪（最多 30 秒）
for i in $(seq 1 60); do
  if curl -s -m 2 "${URL}api/health" >/dev/null 2>&1; then
    echo "  ✓ 就绪"
    echo
    echo "  $URL"
    echo "  （保持这个窗口开着；关掉它就停止 Dove）"
    echo
    open "$URL"
    wait "$HARNESS"
    exit 0
  fi
  if ! kill -0 "$HARNESS" 2>/dev/null; then
    echo "  ✗ 内核启动失败，看上面的报错"
    echo
    read -n 1 -s -r -p "按任意键关闭…"
    exit 1
  fi
  sleep 0.5
done

echo "  ✗ 30 秒还没就绪"
read -n 1 -s -r -p "按任意键关闭…"
exit 1
