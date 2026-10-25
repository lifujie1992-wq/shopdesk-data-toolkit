#!/bin/sh
# 卸载定时任务（保留数据与日志）
set -eu
for label in local.shopdesk.aftersale-counts local.shopdesk.aftersale-push; do
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
echo "已卸载定时任务；数据仍在 ~/projects/shopdesk-aftersale/data/"
