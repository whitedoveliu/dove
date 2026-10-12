#!/bin/bash
# dove 功能验证脚本
# 用法: ./verify.sh [--quick]    --quick 跳过耗时检查（E2E 对话）
#
# 验的是**当前的 TS 内核**（harness/）：静态检查 + 单测 + 冒烟 + 服务健康 + E2E 对话。
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
H="$ROOT/harness"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

echo "== 1. 静态检查 =="
if (cd "$H" && npm run lint >/dev/null 2>&1); then ok "lint（文件大小 + 依赖方向）"; else bad "lint 失败"; fi

echo "== 2. 单元测试 =="
if (cd "$H" && node --no-warnings --test packages/core/test/core.test.ts >/dev/null 2>&1); then ok "核心单测"; else bad "核心单测失败"; fi
if (cd "$H" && node --no-warnings --test packages/core/test/goal.test.ts >/dev/null 2>&1); then ok "目标（Goal）单测"; else bad "目标单测失败"; fi
if (cd "$H" && node --no-warnings --test packages/core/test/p0.test.ts packages/core/test/wiring.test.ts >/dev/null 2>&1); then ok "P0 能力单测（看图 / MCP / 子代理 / 定时 / 上下文）"; else bad "P0 单测失败"; fi

echo "== 3. 冒烟（真实执行，不是纯函数）=="
for s in smoke-turn smoke-subagent smoke-memory smoke-terminal smoke-mcp-resources; do
  if (cd "$H" && node --no-warnings "scripts/$s.ts" >/dev/null 2>&1); then ok "$s"; else bad "$s 失败"; fi
done
for s in smoke-routes.mjs smoke-cli-exit.mjs smoke-cli.mjs; do
  if (cd "$H" && node --no-warnings "scripts/$s" >/dev/null 2>&1); then ok "$s"; else bad "$s 失败"; fi
done

echo "== 3b. 新能力冒烟（PTC / 后台任务 / 循环纪律 / 目标验收）=="
for s in smoke-ptc smoke-jobs smoke-loop-audit smoke-goal-eval smoke-goal-events; do
  if (cd "$H" && node --no-warnings "scripts/$s.ts" >/dev/null 2>&1); then ok "$s"; else bad "$s 失败"; fi
done

# 屏幕记忆（真实截屏 + Vision OCR）。这类能力依赖「屏幕录制」权限：
# 没权限时脚本自己降级成「⚠️ 跳过」并 exit 0 —— 这里把它显示出来，不当失败，
# 否则没授权的机器上 verify 永远红，反而教人忽略它。
echo "== 3c. 屏幕记忆冒烟（真实截屏 + OCR；无屏幕录制权限时降级为跳过）=="
SMEM="$(cd "$H" && node --no-warnings scripts/smoke-screen-memory.ts 2>&1)"; SMEM_RC=$?
if [ "$SMEM_RC" != "0" ]; then
  bad "smoke-screen-memory 失败"; printf '%s\n' "$SMEM" | tail -6
elif printf '%s' "$SMEM" | grep -q "跳过"; then
  ok "smoke-screen-memory（无屏幕录制权限，已按降级跳过）"
  printf '%s\n' "$SMEM" | grep "跳过"
else
  ok "smoke-screen-memory"
fi

echo "== 4. 服务健康 =="
curl -s -m 5 http://localhost:8790/api/health | grep -q '"ok":true' && ok "内核 8790 健康" || bad "内核 8790 不健康（App 没在跑？）"
curl -s -m 5 -o /dev/null -w "%{http_code}" http://localhost:8008/api/projects | grep -q 200 && ok "兼容层 8008 可访问" || bad "兼容层 8008 不可访问"

if [ "$QUICK" = "1" ]; then
  echo "== (quick 模式跳过 E2E 对话) =="
else
  echo "== 5. E2E 对话 =="
  P=$(curl -s -m 5 http://localhost:8008/api/projects | python3 -c "import sys,json;p=json.load(sys.stdin).get('projects',[]);print(p[0]['port'] if p else '')" 2>/dev/null)
  if [ -z "$P" ]; then
    bad "没有可用的项目，跳过 E2E"
  else
    T=$(mktemp)
    curl -N -s -m 120 -X POST http://localhost:8008/api/chat -H "Content-Type: application/json" \
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
