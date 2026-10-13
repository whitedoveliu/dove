#!/bin/bash
# dove 功能验证脚本
# 用法: ./verify.sh [--quick]    --quick 跳过耗时检查（E2E 对话）
#
# 验的是**当前的 TS 内核**（harness/）：静态检查 + 单测 + 冒烟 + 服务健康 + E2E 对话。
#
# 兼容层（8008）除 /api/health 外都要本地令牌，令牌在内核配置目录里（<DOVE_CONFIG>/api-token）。
# 想验另一个内核（端口被 App 占着时起的临时内核）：DOVE_PORT / DOVE_LEGACY_PORT / DOVE_CONFIG 一起给。
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
H="$ROOT/harness"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

KERNEL_PORT="${DOVE_PORT:-8790}"
LEGACY_PORT="${DOVE_LEGACY_PORT:-8008}"
TOKEN_FILE="${DOVE_CONFIG:-$HOME/.dove}/api-token"
# 令牌文件读不到就不带头：检查如实报失败，绝不用「反正老代码不校验」蒙混过去
AUTH=()
TOKEN_VAL=""
if [ -r "$TOKEN_FILE" ]; then
  TOKEN_VAL=$(tr -d '\n' < "$TOKEN_FILE")
  AUTH=(-H "X-Dove-Token: $TOKEN_VAL")
fi
# 8790 现在也上了同一把锁，而 smoke-routes 打的是**真实在跑的内核** —— 令牌得传给它。
# 只传令牌、不传 DOVE_CONFIG：后者会让所有冒烟脚本共用一个配置目录（见下面的 unset）。
[ -n "$TOKEN_VAL" ] && export DOVE_TOKEN="$TOKEN_VAL"
# DOVE_CONFIG 只在上面找令牌时用一次，**不能漏给下面的 harness 子进程**：
# 冒烟脚本会按它去找配置目录（_isolate.ts 只在没设时才指到临时目录），
# 共用一个配置目录会让它们互相踩 —— 实测 smoke-loop-audit 的缓存前缀断言会挂。
unset DOVE_CONFIG

echo "== 0. 前置检查 =="
# 冒烟脚本用的是**固定端口**（每个脚本自己认领一个），所以两个 verify.sh 同时跑必然互相踩：
# 症状是「8831 上响应 /api/health 的不是这次起的那个内核」这类看着像代码坏了的报错。
# 与其让人去猜，不如在这里就把话说清楚、直接失败。
BUSY=""
for p in 8831 8841 8851 8861 8862 8871 8881 8882 8883; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then BUSY="$BUSY $p"; fi
done
if [ -n "$BUSY" ]; then
  bad "冒烟端口被占用：$BUSY —— 多半是另一次 verify.sh 还在跑（或上次没退干净）"
  echo "     查是谁： lsof -nP -iTCP:8831 -sTCP:LISTEN"
  echo "     清掉：   for p in$BUSY; do lsof -t -nP -iTCP:\$p -sTCP:LISTEN | xargs -r kill; done"
  echo "     确认没有别的 verify 在跑之后重试。"
else
  ok "冒烟端口（8831/8841/8851/8861/8862/8871/8881/8882/8883）都空闲"
fi

echo "== 1. 静态检查 =="
if (cd "$H" && npm run lint >/dev/null 2>&1); then ok "lint（文件大小 + 依赖方向）"; else bad "lint 失败"; fi

echo "== 2. 单元测试 =="
# ⚠️ 这里以前是**点名 3 个文件**（core / goal / p0+wiring），
#    于是 cache-usage / capture / mode / prefix 这 4 个文件从来没被 verify 跑过 ——
#    「测试通过」这句话因此是打了折扣的。现在跑完整 glob，并把统计打出来。
UNIT_OUT=$(cd "$H" && node --no-warnings --test packages/core/test/*.test.ts 2>&1)
UNIT_SUM=$(printf '%s\n' "$UNIT_OUT" | grep -E "^(ℹ|#) *(tests|pass|fail) " | tr '\n' ' ')
if printf '%s\n' "$UNIT_OUT" | grep -qE "^(ℹ|#) *fail 0$"; then
  ok "单元测试全部通过（${UNIT_SUM:-无统计}）"
else
  bad "单元测试失败（${UNIT_SUM:-无统计}）"
  printf '%s\n' "$UNIT_OUT" | grep -E "^not ok|^✖|✖ " | head -20
fi

echo "== 3. 冒烟（真实执行，不是纯函数）=="
for s in smoke-turn smoke-subagent smoke-memory smoke-terminal smoke-mcp-resources smoke-context; do
  if (cd "$H" && node --no-warnings "scripts/$s.ts" >/dev/null 2>&1); then ok "$s"; else bad "$s 失败"; fi
done
for s in smoke-routes.mjs smoke-cli-exit.mjs smoke-cli.mjs; do
  if (cd "$H" && node --no-warnings "scripts/$s" >/dev/null 2>&1); then ok "$s"; else bad "$s 失败"; fi
done

echo "== 3b. 新能力冒烟（PTC / 后台任务 / 循环纪律 / 目标验收 / 本机准入 / 撤销 / 文件面边界 / 预览路由）=="
for s in smoke-ptc smoke-jobs smoke-loop-audit smoke-goal-eval smoke-goal-events smoke-auth smoke-undo smoke-legacy-files smoke-preview; do
  if (cd "$H" && node --no-warnings "scripts/$s.ts" >/dev/null 2>&1); then ok "$s"; else bad "$s 失败"; fi
done

echo "== 4. 服务健康 =="
curl -s -m 5 "http://localhost:$KERNEL_PORT/api/health" | grep -q '"ok":true' && ok "内核 $KERNEL_PORT 健康" || bad "内核 $KERNEL_PORT 不健康（App 没在跑？）"
curl -s -m 5 -o /dev/null -w "%{http_code}" "${AUTH[@]+"${AUTH[@]}"}" "http://localhost:$LEGACY_PORT/api/projects" | grep -q 200 && ok "兼容层 $LEGACY_PORT 可访问" || bad "兼容层 $LEGACY_PORT 不可访问"

if [ "$QUICK" = "1" ]; then
  echo "== (quick 模式跳过 E2E 对话) =="
else
  echo "== 5. E2E 对话 =="
  P=$(curl -s -m 5 "${AUTH[@]+"${AUTH[@]}"}" "http://localhost:$LEGACY_PORT/api/projects" | python3 -c "import sys,json;p=json.load(sys.stdin).get('projects',[]);print(p[0]['port'] if p else '')" 2>/dev/null)
  if [ -z "$P" ]; then
    bad "没有可用的项目，跳过 E2E"
  else
    T=$(mktemp)
    curl -N -s -m 120 -X POST "http://localhost:$LEGACY_PORT/api/chat" -H "Content-Type: application/json" \
      "${AUTH[@]+"${AUTH[@]}"}" \
      -d "{\"message\":\"只回复两个字：你好\",\"project_id\":\"$P\"}" -o "$T"
    grep -q '"type":"text"' "$T" && ok "E2E 有文本输出" || bad "E2E 无文本输出"
    grep -q '"type":"error"' "$T" && bad "E2E 出现错误事件" || ok "E2E 无错误事件"
    rm -f "$T"
  fi
fi

echo ""
echo "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" = "0" ] && echo "🎉 全部通过" || echo "⚠️ 存在失败项"
exit $FAIL
