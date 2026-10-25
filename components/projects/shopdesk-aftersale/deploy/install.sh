#!/bin/sh
# 安装定时任务：每小时 :02/:32 采集 + 每 5 分钟补传
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)"     # 项目根
LA="$HOME/Library/LaunchAgents"
ENVF="$HOME/.config/aftersale/env"
PY="$(command -v python3 || echo /usr/bin/python3)"

mkdir -p "$LA" "$DIR/logs" "$DIR/data"
chmod +x "$DIR/bin/scrape_counts.py" "$DIR/bin/push.py" "$DIR/bin/query.py" 2>/dev/null || true

install_agent() {
  label="$1"
  tmpl="$DIR/deploy/launchd/$label.plist.tmpl"
  dst="$LA/$label.plist"
  [ -f "$tmpl" ] || { echo "缺少模板：$tmpl"; return 1; }
  sed -e "s|__ROOT__|$DIR|g" -e "s|__PYTHON__|$PY|g" "$tmpl" > "$dst"
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$dst"
  launchctl enable "gui/$UID/$label" 2>/dev/null || true
  echo "已安装：$dst"
}

install_agent local.shopdesk.aftersale-counts

if [ -f "$ENVF" ]; then
  install_agent local.shopdesk.aftersale-push
else
  echo "未安装补传任务：请先创建 ${ENVF}（参考 config/config.env.example，chmod 600），再重新执行 deploy/install.sh"
fi

echo
echo "项目根：$DIR"
echo "采集：每小时 :02、:32（北京时间；加载后等待计划时间）"
echo "补传：每 5 分钟一次（仅在上云配置存在时安装）"
echo "状态：launchctl print gui/$UID/local.shopdesk.aftersale-counts | head -20"
echo "日志：tail -f $DIR/logs/scrape.log $DIR/data/push.log"
