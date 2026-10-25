#!/bin/bash
# 聚水潭会话刷新：选择可用浏览器 → 刷新专用订单页 → 验证后回灌 Keychain。
# 每天09:30/15:30/21:30；失败重试三次，并沿用工作台告警配置。
set -uo pipefail
LOG_DIR="$HOME/Library/Logs/xdr-sync-agent"
LOG="$LOG_DIR/auth-refresh.log"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$LOG_DIR"
ts() { TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }
notify() {
  osascript -e 'display notification "聚水潭登录态刷新连续失败，请查看 auth-refresh.log" with title "聚水潭会话需要处理" sound name "Glass"' >/dev/null 2>&1 || true
  node "$HOME/xdr-sync-agent/bin/xdr-failure-alert.js" --task com.xdr.jst-auth-refresh --reason "登录态刷新连续三次失败，请检查Chrome聚水潭登录" --log "$LOG" >>"$LOG" 2>&1 || true
}
for attempt in 1 2 3; do
  log "refresh start: attempt ${attempt}/3"
  if node "$SCRIPT_DIR/refresh-jst-auth.mjs" >>"$LOG" 2>&1; then
    log "refresh done: all sessions healthy"
    exit 0
  fi
  log "refresh attempt ${attempt} failed"
  [ "$attempt" -lt 3 ] && sleep 60
done
log "refresh done: session check failed after 3 attempts"
notify
exit 1
