#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SOURCE="$ROOT_DIR/app"
SKILL_SOURCE="$ROOT_DIR/skill"
INSTALL_ROOT="${JST_INSTALL_ROOT:-$HOME/.local/share/jst-inventory}"
BIN_DIR="${JST_BIN_DIR:-$HOME/.local/bin}"
CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
NODE_VERSION="24.20.0"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This package currently supports macOS because credentials use macOS Keychain." >&2
  exit 1
fi

if [[ ! -f "$APP_SOURCE/bin/jst-inventory.js" || ! -f "$SKILL_SOURCE/SKILL.md" ]]; then
  echo "Invalid package: app or skill files are missing." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -n "$NODE_BIN" ]]; then
  NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
else
  NODE_MAJOR=0
fi

if [[ "$NODE_MAJOR" -lt 22 ]]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64)
      NODE_ARCH="arm64"
      NODE_SHA256="40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8"
      ;;
    x86_64)
      NODE_ARCH="x64"
      NODE_SHA256="9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4"
      ;;
    *)
      echo "Unsupported Mac architecture: $ARCH" >&2
      exit 1
      ;;
  esac

  NODE_HOME="$HOME/.local/share/jst-inventory-node/node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
  NODE_BIN="$NODE_HOME/bin/node"
  if [[ ! -x "$NODE_BIN" ]]; then
    TMP_DIR="$(mktemp -d /tmp/jst-inventory-node.XXXXXX)"
    trap 'rm -rf "$TMP_DIR"' EXIT
    ARCHIVE="$TMP_DIR/node.tar.gz"
    curl -fL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz" -o "$ARCHIVE"
    ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
    if [[ "$ACTUAL_SHA256" != "$NODE_SHA256" ]]; then
      echo "Node.js checksum verification failed." >&2
      exit 1
    fi
    mkdir -p "$NODE_HOME"
    tar -xzf "$ARCHIVE" --strip-components=1 -C "$NODE_HOME"
  fi
fi

mkdir -p "$INSTALL_ROOT" "$BIN_DIR" "$CODEX_SKILLS_DIR/jst-inventory-cli" "$HOME/.agents/skills/jst-inventory-cli"
cp -R "$APP_SOURCE/." "$INSTALL_ROOT/"
cp -R "$SKILL_SOURCE/." "$CODEX_SKILLS_DIR/jst-inventory-cli/"
cp -R "$SKILL_SOURCE/." "$HOME/.agents/skills/jst-inventory-cli/"

cat > "$BIN_DIR/jst-inventory" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$INSTALL_ROOT/bin/jst-inventory.js" "\$@"
EOF
chmod 755 "$BIN_DIR/jst-inventory" "$INSTALL_ROOT/bin/jst-inventory.js"

for agent_root in "$HOME/.claude"; do
  if [[ -d "$agent_root" ]]; then
    mkdir -p "$agent_root/skills/jst-inventory-cli"
    cp -R "$SKILL_SOURCE/." "$agent_root/skills/jst-inventory-cli/"
  fi
done

echo "Installed jst-inventory to $BIN_DIR/jst-inventory"
echo "Installed agent skill to $CODEX_SKILLS_DIR/jst-inventory-cli"
echo "Next: copy a full 聚水潭 Cookie header, then run:"
echo "  pbpaste | $BIN_DIR/jst-inventory auth import"
