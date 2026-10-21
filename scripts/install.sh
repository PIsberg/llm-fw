#!/usr/bin/env sh
# llm-fw one-step installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/PIsberg/llm-fw/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/PIsberg/llm-fw/main/scripts/install.sh | sh -s -- --proxy-only
#
# Environment overrides:
#   LLM_FW_PKG         Package spec passed to `npm install -g` (default: llm-fw)
#   LLM_FW_NO_SUDO     Set to 1 to never invoke sudo (runs setup unprivileged)
#   LLM_FW_NO_START    Set to 1 to skip starting the proxy after setup

set -eu

PKG="${LLM_FW_PKG:-llm-fw}"
NO_SUDO="${LLM_FW_NO_SUDO:-0}"
NO_START="${LLM_FW_NO_START:-0}"
PROXY_ONLY=0
JUDGE_FLAG=""
SETUP_EXTRA=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --proxy-only)
      PROXY_ONLY=1
      SETUP_EXTRA="$SETUP_EXTRA --proxy-only"
      ;;
    --sinkhole)
      SETUP_EXTRA="$SETUP_EXTRA --sinkhole"
      ;;
    --judge)
      JUDGE_FLAG="--judge"
      ;;
    --no-judge)
      JUDGE_FLAG="--no-judge"
      ;;
    --no-start)
      NO_START=1
      ;;
    --no-sudo)
      NO_SUDO=1
      ;;
    --version)
      shift
      PKG="llm-fw@$1"
      ;;
    *)
      echo "llm-fw install: unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# Default to --no-judge when stdin is not a terminal (e.g. `curl ... | sh`).
if [ -z "$JUDGE_FLAG" ] && [ ! -t 0 ]; then
  JUDGE_FLAG="--no-judge"
fi

# 1. Verify Node.js >= 22 and npm.
if ! command -v node >/dev/null 2>&1; then
  echo "llm-fw requires Node.js 22 or newer (node was not found on PATH)." >&2
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "  Install with Homebrew:  brew install node" >&2
  else
    echo "  Install from https://nodejs.org/ or via fnm/nvm:  fnm install 22" >&2
  fi
  exit 1
fi

NODE_VER="$(node -v 2>/dev/null || echo v0.0.0)"
NODE_MAJOR="$(printf '%s' "$NODE_VER" | sed 's/^v//;s/\..*//')"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) NODE_MAJOR=0 ;;
esac
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "llm-fw requires Node.js 22+ (found $NODE_VER)." >&2
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "  Upgrade with Homebrew:  brew upgrade node" >&2
  else
    echo "  Upgrade from https://nodejs.org/ or via fnm/nvm:  fnm install 22" >&2
  fi
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "llm-fw requires npm, which was not found alongside node." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"

# 2. Install llm-fw globally (--ignore-scripts: llm-fw needs no install scripts).
echo "==> Installing $PKG..."
NPM_PREFIX="$(npm prefix -g)"
if [ -w "$NPM_PREFIX" ] || [ -w "$NPM_PREFIX/lib" ] || [ "$(id -u)" -eq 0 ]; then
  npm install -g --ignore-scripts "$PKG"
elif [ "$NO_SUDO" = "0" ] && command -v sudo >/dev/null 2>&1; then
  sudo env "PATH=$NODE_DIR:$PATH" npm install -g --ignore-scripts "$PKG"
else
  npm install -g --ignore-scripts "$PKG"
fi

# 3. Locate the installed llm-fw binary even if npm's global bin is not on PATH.
if command -v llm-fw >/dev/null 2>&1; then
  LLM_FW_BIN="$(command -v llm-fw)"
elif [ -x "$NPM_PREFIX/bin/llm-fw" ]; then
  LLM_FW_BIN="$NPM_PREFIX/bin/llm-fw"
else
  echo "llm-fw binary not found after install (checked PATH and $NPM_PREFIX/bin/llm-fw)." >&2
  exit 1
fi

# 4. Run `llm-fw setup`.
# When sudo is used for sinkhole/CA trust, preserve the invoking user's PATH
# (for nvm/fnm/volta/Homebrew node) and HOME (so ~/.llm-fw and shell profiles
# are written to the user's home rather than /root), then restore user ownership.
echo "==> Running llm-fw setup..."
# shellcheck disable=SC2086
if [ "$(id -u)" -eq 0 ] || [ "$PROXY_ONLY" = "1" ] || [ "$NO_SUDO" = "1" ] || ! command -v sudo >/dev/null 2>&1; then
  "$NODE_BIN" "$LLM_FW_BIN" setup $SETUP_EXTRA $JUDGE_FLAG
else
  USER_ID="$(id -u)"
  GROUP_ID="$(id -g)"
  USER_HOME="$HOME"
  sudo env "PATH=$NODE_DIR:$PATH" "HOME=$USER_HOME" "SHELL=${SHELL:-}" \
    "$NODE_BIN" "$LLM_FW_BIN" setup $SETUP_EXTRA $JUDGE_FLAG
  if [ -d "${LLM_FW_DIR:-$USER_HOME/.llm-fw}" ]; then
    sudo chown -R "$USER_ID:$GROUP_ID" "${LLM_FW_DIR:-$USER_HOME/.llm-fw}"
  fi
  for rc in .zshrc .bashrc .profile .bash_profile; do
    if [ -f "$USER_HOME/$rc" ]; then
      sudo chown "$USER_ID:$GROUP_ID" "$USER_HOME/$rc"
    fi
  done
fi

# 5. Start the proxy as the invoking user.
if [ "$NO_START" = "0" ]; then
  echo "==> Starting llm-fw..."
  "$NODE_BIN" "$LLM_FW_BIN" start
fi
