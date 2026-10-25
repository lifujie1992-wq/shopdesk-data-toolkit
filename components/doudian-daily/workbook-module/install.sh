#!/usr/bin/env bash
# 把采集模块装进「店铺工作台」（不需要点 GUI）
# 用法: bash install.sh [模块名]  （默认 shopmetrics）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ID="${1:-shopmetrics}"
HOME_DIR="$HOME/Library/Application Support/shopdesk/collectors"

if [ ! -d "$HOME_DIR" ]; then
  echo "❌ 找不到工作台采集目录：$HOME_DIR" >&2
  echo "   请先启动一次「店铺工作台」" >&2
  exit 1
fi

UUID="v-$(uuidgen | tr 'A-Z' 'a-z')"
DEST="$HOME_DIR/$UUID"
mkdir -p "$DEST"
cp "$HERE/collector.json" "$HERE/metrics.py" "$HERE/doudian.py" "$HERE/probe.py" "$DEST/"
chmod 700 "$DEST"; chmod 600 "$DEST"/*
rm -rf "$DEST/__pycache__"

/usr/bin/python3 - "$HOME_DIR/active.json" "$ID" "$UUID" <<'PY'
import json, os, sys
f, mid, uuid = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(f))
except Exception:
    d = {}
d[mid] = uuid
json.dump(d, open(f + '.tmp', 'w'), ensure_ascii=False)
os.replace(f + '.tmp', f)
os.chmod(f, 0o600)
print('active.json ->', json.dumps(d, ensure_ascii=False))
PY

echo "✅ 已安装 $ID → $DEST"
echo "   打开工作台 → Agent/采集 页面即可看到能力列表（无需重启）"
