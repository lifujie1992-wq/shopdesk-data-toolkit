#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
PLIST="$HOME/Library/LaunchAgents/com.xdr.failure-watch.plist"
NODE="$(command -v node)"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/var/logs"
chmod 700 "$ROOT/var/logs"
/usr/bin/python3 - "$ROOT/macos/com.xdr.failure-watch.plist" "$PLIST" "$ROOT" "$NODE" <<'PY'
import os, pathlib, plistlib, sys
source, target, root, node = sys.argv[1:]
with open(source, 'rb') as stream:
    data = plistlib.load(stream)
data['ProgramArguments'] = [node, str(pathlib.Path(root)/'bin/xdr-failure-watch.js')]
data['WorkingDirectory'] = root
logdir = pathlib.Path(root)/'var/logs'
data['StandardOutPath'] = str(logdir/'failure-watch.out.log')
data['StandardErrorPath'] = str(logdir/'failure-watch.err.log')
temporary = pathlib.Path(target+'.tmp')
with temporary.open('wb') as stream:
    plistlib.dump(data, stream)
os.chmod(temporary, 0o600)
temporary.replace(target)
PY
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/com.xdr.failure-watch" 2>/dev/null || true
launchctl enable "$DOMAIN/com.xdr.failure-watch"
launchctl bootstrap "$DOMAIN" "$PLIST"
echo '已安装并加载com.xdr.failure-watch，每60秒检查一次实际执行结果。'
