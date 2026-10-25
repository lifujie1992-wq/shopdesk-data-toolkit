#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
TASK_NODE="$(command -v node)"
TASK_PLIST="$HOME/Library/LaunchAgents/com.xdr.feige-customer-daily.plist"
mkdir -p "$PROJECT_ROOT/logs" "$HOME/Library/LaunchAgents"
chmod 700 "$PROJECT_ROOT/logs"
python3 - "$PROJECT_ROOT" "$TASK_NODE" "$TASK_PLIST" <<'PY'
import sys,plistlib,os
root,node,target=sys.argv[1:]
raw=open(root+'/launchd/com.xdr.feige-customer-daily.plist').read()
data=plistlib.loads(raw.encode())
def replace(v):
 if isinstance(v,str):return v.replace('__NODE__',os.path.realpath(node)).replace('__ROOT__',root)
 if isinstance(v,list):return [replace(x) for x in v]
 if isinstance(v,dict):return {k:replace(x) for k,x in v.items()}
 return v
with open(target,'wb') as f:plistlib.dump(replace(data),f)
os.chmod(target,0o600)
PY
plutil -lint "$TASK_PLIST"
if launchctl print "gui/$(id -u)/com.xdr.feige-customer-daily" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/com.xdr.feige-customer-daily"
fi
launchctl enable "gui/$(id -u)/com.xdr.feige-customer-daily"
launchctl bootstrap "gui/$(id -u)" "$TASK_PLIST"
echo "已加载 com.xdr.feige-customer-daily：每天10:30采集上海时区昨天的客服表现。"
