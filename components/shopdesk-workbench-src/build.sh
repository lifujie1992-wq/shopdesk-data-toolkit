#!/bin/bash
# 构建 + 部署：把 src/ 打进 app.asar，重签名，装进本机的工作台 App
#
# 用法：
#   bash build.sh              # 构建并部署到本机 /Applications 或 ~/店铺工作台.app
#   bash build.sh --no-install # 只生成 dist/app.asar，不安装
#
# 注意：必须是 macOS（要 codesign）。修改 collectors/ 里的采集模块不需要跑这个脚本。
set -e
cd "$(dirname "$0")"

# launchd 环境下 PATH 极简，必须自己找 node（用 glob 自动探测）
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
for d in "$HOME/.local"/node-*/bin "$HOME/.nvm/versions/node"/*/bin /opt/homebrew/opt/node/bin "$HOME/.volta/bin"; do
  [ -x "$d/node" ] && export PATH="$d:$PATH"
done
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "❌ 找不到 node，请检查 Node.js 安装（PATH=$PATH）"; exit 1; fi
echo "   node: $NODE_BIN"

APP="${SHOPDESK_APP:-/Users/zhaoxiaozhong/店铺工作台.app}"
ASAR_BIN="${ASAR_BIN:-npx --yes @electron/asar}"
WORK="$(mktemp -d)"
STAGE="$WORK/app"

echo "① 准备构建目录"
mkdir -p "$STAGE" dist
cp -R src "$STAGE/src"
cp -R collectors "$STAGE/collectors" 2>/dev/null || true
cp package.json "$STAGE/" 2>/dev/null || true

echo "② 打包 app.asar"
rm -f dist/app.asar
$ASAR_BIN pack "$STAGE" dist/app.asar >/dev/null
ls -lh dist/app.asar

if [ "$1" = "--no-install" ]; then echo "✅ 已生成 dist/app.asar（未安装）"; rm -rf "$WORK"; exit 0; fi

echo "③ 校验完整性哈希（Electron 要求）"
HASH=$(node -e '
const fs=require("fs"),crypto=require("crypto");
const fd=fs.openSync("dist/app.asar","r");
const b=Buffer.alloc(8); fs.readSync(fd,b,0,8,0);
const sl=Buffer.alloc(4); fs.readSync(fd,sl,0,4,12);
const n=sl.readInt32LE(0); const j=Buffer.alloc(n); fs.readSync(fd,j,0,n,16);
console.log(crypto.createHash("SHA256").update(j).digest("hex"));
fs.closeSync(fd);')
echo "   hash=$HASH"

echo "④ 安装到 App"
[ -d "$APP" ] || { echo "❌ 找不到 App: $APP（用 SHOPDESK_APP=... 指定）"; exit 1; }
cp dist/app.asar "$APP/Contents/Resources/app.asar"
/usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash $HASH" "$APP/Contents/Info.plist"

# 沙箱 preload 不能从 asar 里加载，必须放在 Resources 根目录
cp src/stealth-preload.js "$APP/Contents/Resources/stealth-preload.js"

echo "④b 同步采集模块到 App（App 从 Resources/collectors/ 加载，不是从 asar）"
if [ -d collectors ]; then
  DEST="$APP/Contents/Resources/collectors"
  mkdir -p "$DEST"
  # 仓库布局 collectors/builtin/*；兼容旧布局（collectors/ 下直接是模块文件）
  if [ -d collectors/builtin ]; then
    rsync -a --delete collectors/ "$DEST/" 2>/dev/null || cp -R collectors/* "$DEST/"
  elif [ -f collectors/worker.py ]; then
    mkdir -p "$DEST/builtin"; rsync -a --delete collectors/ "$DEST/builtin/" 2>/dev/null || cp -R collectors/* "$DEST/builtin/"
  else
    rsync -a --delete collectors/ "$DEST/" 2>/dev/null || cp -R collectors/* "$DEST/"
  fi
  rm -rf "$DEST/builtin/__pycache__" 2>/dev/null || true
  echo "   已同步 $(ls "$DEST/builtin" 2>/dev/null | wc -l | tr -d ' ') 个采集模块文件"
fi

echo "④c 同步定时任务（plist + daily-appeal.sh）"
LA="$HOME/Library/LaunchAgents"
APPD="$HOME/Library/Application Support/shopdesk"
mkdir -p "$LA" "$APPD"
CHANGED_APPEAL=0
for f in tools/*.plist; do
  [ -f "$f" ] || continue
  b="$(basename "$f")"
  # 路径替换成当前用户
  sed "s|/Users/zhaoxiaozhong|$HOME|g" "$f" > "/tmp/_plist_$b"
  if ! cmp -s "/tmp/_plist_$b" "$LA/$b" 2>/dev/null; then
    cp "/tmp/_plist_$b" "$LA/$b"
    echo "   更新 $b"
    case "$b" in
      *appeal*) CHANGED_APPEAL=1;;
      *health*) (sleep 3; launchctl unload "$LA/$b" 2>/dev/null; launchctl load -w "$LA/$b" 2>/dev/null) >/dev/null 2>&1 & ;;
      *autodeploy*) (sleep 3; launchctl unload "$LA/$b" 2>/dev/null; launchctl load -w "$LA/$b" 2>/dev/null) >/dev/null 2>&1 & ;;
    esac
  fi
  rm -f "/tmp/_plist_$b"
done
[ -f tools/daily-appeal.sh ] && { cp tools/daily-appeal.sh "$APPD/daily-appeal.sh"; chmod +x "$APPD/daily-appeal.sh"; }
[ -f tools/submit-confirmed.sh ] && { cp tools/submit-confirmed.sh "$APPD/submit-confirmed.sh"; chmod +x "$APPD/submit-confirmed.sh"; }
[ -f tools/daily-summary.sh ] && { cp tools/daily-summary.sh "$APPD/daily-summary.sh"; chmod +x "$APPD/daily-summary.sh"; }
[ -f tools/health-check.sh ] && { cp tools/health-check.sh "$APPD/health-check.sh"; chmod +x "$APPD/health-check.sh"; }
# 若存在关闭开关，则只更新文件、不启用定时任务
if [ -f "$APPD/TIMERS_OFF" ]; then
  launchctl unload -w "$LA/local.shopdesk.appeal.plist" 2>/dev/null || true
  echo "   ⏸ 检测到 TIMERS_OFF，定时任务保持关闭（文件已更新，但不加载）"
elif [ "$CHANGED_APPEAL" = "1" ]; then
  launchctl unload "$LA/local.shopdesk.appeal.plist" 2>/dev/null
  launchctl load -w "$LA/local.shopdesk.appeal.plist" 2>/dev/null
  echo "   每日申诉任务已重载"
fi

echo "⑤ 重签名（ad-hoc）"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 && echo "   OK"

echo "⑥ 重启 App"
BRIDGE="$HOME/Library/Application Support/shopdesk/agent-bridge.json"
OLD_PID=""
if [ -f "$BRIDGE" ]; then
  # 注意：agent-bridge.json 是 JSON，不是 plist——必须用 plutil；
  # 用 PlistBuddy 会打印 "Error Reading File:…" 并被当成端口号，curl 直接 exit 3 中断部署。
  P=$(/usr/bin/plutil -extract port raw -o - "$BRIDGE" 2>/dev/null || true)
  T=$(/usr/bin/plutil -extract token raw -o - "$BRIDGE" 2>/dev/null || true)
  OLD_PID=$(/usr/bin/plutil -extract pid raw -o - "$BRIDGE" 2>/dev/null || true)
  case "$P" in ''|*[!0-9]*) P="";; esac
  case "$T" in ''|*[!0-9a-f]*) T="";; esac
  if [ "${FORCE:-}" != "1" ] && [ -n "$P" ] && [ -n "$T" ]; then
    R=$(/usr/bin/curl -s --max-time 15 --noproxy '*' -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"method":"auto_appeal_status"}' "http://127.0.0.1:$P/call" 2>/dev/null || true)
    case "$R" in
      *'"running":true'*) echo "⛔ 申诉任务正在跑，已取消重启（FORCE=1 可强制）"; exit 1;;
      "") echo "⛔ 接口无响应（可能在忙），已取消重启（FORCE=1 可强制）"; exit 1;;
    esac
  fi
fi
# 关闭旧实例：优先用 bridge 里记录的 pid，避免 pkill -f 模糊模式误伤其它进程
if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  kill -TERM "$OLD_PID" 2>/dev/null || true
  for i in $(seq 1 10); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 1; done
  kill -0 "$OLD_PID" 2>/dev/null && kill -KILL "$OLD_PID" 2>/dev/null || true
fi
pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true
sleep 2
rm -f "$BRIDGE"
open "$APP"
OK=0
for i in $(seq 1 12); do
  sleep 5
  if [ -f "$HOME/Library/Application Support/shopdesk/agent-bridge.json" ]; then OK=1; break; fi
done
if [ "$OK" = "1" ]; then
  echo "✅ 部署完成，本机接口已就绪（等待 $((i*5)) 秒）"
else
  echo "⚠️ 接口 60 秒内未就绪，尝试再次重启…"
  pkill -9 -f "店铺工作台" 2>/dev/null; sleep 4
  rm -f "$HOME/Library/Application Support/shopdesk/agent-bridge.json"
  open "$APP"; sleep 20
  [ -f "$HOME/Library/Application Support/shopdesk/agent-bridge.json" ] && echo "✅ 重试成功" || echo "❌ 接口仍未就绪，请远程查看 App 界面"
fi
rm -rf "$WORK"
