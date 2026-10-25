#!/bin/bash
# 聚水潭售后明细每日同步：刷新昨天；从最新成功日期追赶漏跑，每轮最多七天。
# 依赖 OpenBridge（浏览器登录态）。
#   定时：com.xdr.jst-aftersales-sync.plist（08:00 / 12:00 / 16:00 上海）
#   加固：单次失败自动重试 3 次；连续失败 → 飞书告警 + 系统通知。
# 说明：本脚本只是"驱动 + 重试 + 告警"外壳，真正的抓取逻辑在
#       ~/jushuitan-aftersales/bin/jst-aftersales.js（走 OpenBridge 驱动 ERP 售后页）。

set -uo pipefail

LOG_DIR="$HOME/Library/Logs/xdr-sync-agent"
LOG="$LOG_DIR/aftersales-sync.log"
mkdir -p "$LOG_DIR"

ts() { TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

# 飞书告警：复用店铺工作台的告警机器人（webhook + 签名）
notify() {
  local text="$1"
  osascript -e "display notification \"$text\" with title \"售后明细同步失败\" sound name \"Glass\"" >/dev/null 2>&1 || true
  node "$HOME/xdr-sync-agent/bin/xdr-failure-alert.js" --task com.xdr.jst-aftersales-sync --reason "$text" --log "$LOG" >>"$LOG" 2>&1 || true
}

TARGET_DATE="${1:-}"
TRIES=3
DELAY=60

if [ -n "$TARGET_DATE" ]; then
  TARGET_DATES="$TARGET_DATE"
else
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  if ! TARGET_DATES="$(/usr/bin/python3 "$SCRIPT_DIR/aftersales-pending-dates.py" 2>>"$LOG")"; then
    log "无法确定待同步日期，停止本轮"
    notify "【聚水潭售后明细同步失败】无法读取待同步日期，详见 $LOG"
    exit 1
  fi
fi

for TARGET_DATE in $TARGET_DATES; do
  for i in $(seq 1 "$TRIES"); do
    log "=== 开始同步售后明细（${TARGET_DATE}，第 ${i}/${TRIES} 次） ==="
    "$HOME/.local/bin/jst-aftersales" sync --date "$TARGET_DATE" >> "$LOG" 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
      log "同步完成：${TARGET_DATE}"
      break
    fi
    log "同步失败（退出码 ${rc}）"
    [ "$i" -lt "$TRIES" ] && sleep "$DELAY"
  done
  if [ "$rc" -ne 0 ]; then
    log "${TARGET_DATE} 连续失败 $TRIES 次，放弃本轮"
    notify "【聚水潭售后明细同步失败】${TARGET_DATE} 连续 $TRIES 次失败，详见 $LOG"
    exit 1
  fi
done

exit 0
