#!/bin/bash
# 聚水潭紫色旗帜(刷单)订单明细 每日同步：拉「近 7 天」，upsert 进 ~/jst-purple-orders.sqlite
# 依赖 jst-orders 的 keychain 凭据。定时：com.xdr.jst-purple-orders-sync.plist（09:25 上海）。

set -uo pipefail

LOG_DIR="$HOME/Library/Logs/xdr-sync-agent"
LOG="$LOG_DIR/purple-orders-sync.log"
mkdir -p "$LOG_DIR"

ts() { TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

notify() {
  local title="$1" body="$2"
  osascript -e "display notification \"$body\" with title \"$title\" sound name \"Glass\"" >/dev/null 2>&1 || true
  node "$HOME/xdr-sync-agent/bin/xdr-failure-alert.js" --task com.xdr.jst-purple-orders-sync --reason "$body" --log "$LOG" >>"$LOG" 2>&1 || true
}

log "=== 开始同步紫旗刷单明细（近7天） ==="
if python3 "$HOME/doudian-daily/jst_purple_orders.py" sync --days 7 >> "$LOG" 2>&1; then
  log "同步完成"
else
  log "同步失败"
  notify "紫旗刷单明细同步失败" "jst_purple_orders sync 失败，详见 $LOG"
  exit 1
fi
