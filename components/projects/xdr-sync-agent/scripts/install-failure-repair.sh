#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPAIR_PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
REPAIR_NODE="$(command -v node)"
REPAIR_PLIST="$HOME/Library/LaunchAgents/com.xdr.failure-repair.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$REPAIR_PROJECT_ROOT/var/logs" "$REPAIR_PROJECT_ROOT/var/failure-repair"
chmod 700 "$REPAIR_PROJECT_ROOT/var/failure-repair" "$REPAIR_PROJECT_ROOT/var/logs"
/usr/bin/python3 - "$REPAIR_PLIST" "$REPAIR_PROJECT_ROOT" "$REPAIR_NODE" <<'PY'
import os,pathlib,plistlib,sys
target,root,node=sys.argv[1:]
root=pathlib.Path(root)
data={'Label':'com.xdr.failure-repair','ProgramArguments':[node,str(root/'bin/xdr-failure-repair.js'),'--once'],
 'WorkingDirectory':str(root),'RunAtLoad':True,'StartInterval':60,'ProcessType':'Background','ExitTimeOut':10,
 'EnvironmentVariables':{'PATH':str(pathlib.Path(node).parent)+':'+str(pathlib.Path.home()/'.local/bin')+':/usr/bin:/bin:/usr/sbin:/sbin','TZ':'Asia/Shanghai'},
 'StandardOutPath':str(root/'var/logs/failure-repair.out.log'),'StandardErrorPath':str(root/'var/logs/failure-repair.err.log')}
path=pathlib.Path(target);path.write_bytes(plistlib.dumps(data));os.chmod(path,0o600)
PY
REPAIR_DOMAIN="gui/$(id -u)"
launchctl bootout "$REPAIR_DOMAIN/com.xdr.failure-repair" 2>/dev/null || true
launchctl enable "$REPAIR_DOMAIN/com.xdr.failure-repair"
launchctl bootstrap "$REPAIR_DOMAIN" "$REPAIR_PLIST"
echo '已加载com.xdr.failure-repair；每60秒领取一个故障，单进程串行处理。'
