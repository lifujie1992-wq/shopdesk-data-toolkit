#!/bin/bash
# 自动部署：检查 GitHub 有没有新提交，有就拉下来重新构建 + 重启 App
# 由 launchd 每 5 分钟跑一次（见 local.shopdesk.autodeploy.plist）
set -u
cd "$(dirname "$0")"
LOG="$HOME/Library/Application Support/shopdesk/autodeploy.log"
mkdir -p "$(dirname "$LOG")"
say(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# 有任务在跑就跳过本轮，避免打断采集/申诉
BRIDGE="$HOME/Library/Application Support/shopdesk/agent-bridge.json"
if pgrep -f "python.*worker.py" >/dev/null 2>&1; then say "有采集在跑，跳过本轮"; exit 0; fi
if [ -f "$BRIDGE" ]; then
  P=$(/usr/bin/plutil -extract port raw -o - "$BRIDGE" 2>/dev/null)
  T=$(/usr/bin/plutil -extract token raw -o - "$BRIDGE" 2>/dev/null)
  if [ -n "${P:-}" ] && [ -n "${T:-}" ]; then
    R=$(/usr/bin/curl -s --max-time 15 --noproxy '*' -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"method":"auto_appeal_status"}' "http://127.0.0.1:$P/call" 2>/dev/null)
    case "$R" in *'"running":true'*) say "申诉任务正在跑，跳过本轮部署"; exit 0;; "") say "接口无响应（App 可能在忙），安全起见跳过部署"; exit 0;; esac
  fi
fi

BEFORE=$(git rev-parse HEAD 2>/dev/null)
git fetch --quiet origin main 2>>"$LOG" || { say "git fetch 失败（没网？）"; exit 0; }
AFTER=$(git rev-parse origin/main 2>/dev/null)
[ -z "$AFTER" ] && { say "取不到远端 main"; exit 0; }
[ "$BEFORE" = "$AFTER" ] && exit 0     # 没变化，静默退出

# 安全闸：工作区还有未提交改动（例如本机正在调试的修复）时绝不 reset --hard，
# 否则会把本机改动静默覆盖掉，还把旧代码重新部署上去。
if [ -n "$(git status --porcelain)" ]; then
  say "工作区有未提交改动，跳过自动部署（避免 reset --hard 覆盖本机改动）"
  exit 0
fi

say "发现新提交 ${BEFORE:0:7} → ${AFTER:0:7}，开始部署"
git checkout -q main 2>>"$LOG" || true
git reset --hard -q origin/main 2>>"$LOG" || { say "git reset 失败"; exit 1; }
bash build.sh >>"$LOG" 2>&1
say "部署完成，当前版本 $(git rev-parse --short HEAD)"
