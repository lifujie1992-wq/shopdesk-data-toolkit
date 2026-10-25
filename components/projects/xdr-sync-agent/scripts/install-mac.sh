#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
NODE="$(command -v node)"
[[ -x "$NODE" ]] || { print -u2 "Node.js not found"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/xdr-sync-agent" "$HOME/Library/Application Support/xdr-sync-agent"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/bin/xdr-sync-agent.js" "$HOME/.local/bin/xdr-sync-agent"
LABEL="com.xdr.sync-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
sed -e "s|/opt/homebrew/bin/node|$NODE|" -e "s|/Users/zhaoxiaozhong/xdr-sync-agent|$ROOT|g" \
  -e "s|/Users/zhaoxiaozhong|$HOME|g" "$ROOT/macos/$LABEL.plist" > "$PLIST"
chmod 600 "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl enable "gui/$(id -u)/$LABEL"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
launchctl bootout "gui/$(id -u)/com.xdr.sync-shop-products" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.xdr.sync-shop-products.plist"
print "Installed com.xdr.sync-agent"
