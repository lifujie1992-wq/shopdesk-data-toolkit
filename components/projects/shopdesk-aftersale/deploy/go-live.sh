#!/bin/sh
# 一键上线：填入云端地址 → 探活 → 安装补传任务 → 补传历史 → 打印状态
# 用法：./deploy/go-live.sh https://api.example.com
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENVF="$HOME/.config/aftersale/env"
URL="${1:-}"

if [ -z "$URL" ]; then
  echo "用法：$0 https://<API_DOMAIN>" >&2
  exit 2
fi
case "$URL" in
  https://*) ;;
  http://127.0.0.1*|http://localhost*) ;;
  *) echo "只接受 https://（本机联调可用 http://127.0.0.1）" >&2; exit 2 ;;
esac

if [ ! -f "$ENVF" ]; then
  echo "缺少 $ENVF，请先按 config/config.env.example 创建（chmod 600）" >&2
  exit 2
fi

# 只替换 AFTERSALE_API_URL 行，保留 token 不变，且不打印文件内容
tmp="$ENVF.tmp"
umask 077
sed "s|^AFTERSALE_API_URL=.*|AFTERSALE_API_URL=$URL|" "$ENVF" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$ENVF"

echo "== 1/4 配置已更新：$URL"
echo "== 2/4 探活"
"$ROOT/bin/push.py" --check

echo "== 3/4 安装定时任务"
"$ROOT/deploy/install.sh"

echo "== 4/4 补传历史并查看状态"
"$ROOT/bin/push.py" --once --verbose || true
"$ROOT/bin/push.py" --status || true

echo
echo "完成。日志：$ROOT/data/push.log"
