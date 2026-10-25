#!/bin/zsh
set -euo pipefail
for LABEL in com.xdr.sync-agent com.xdr.sync-shop-products; do
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
done
print "Removed XDR launch agents; data and logs were retained"
