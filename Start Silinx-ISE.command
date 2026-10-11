#!/bin/bash
# Silinx launcher for macOS: double-click this file in Finder.
# (The first time macOS may refuse to open it: right-click it > Open > Open.)
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed."
  echo "  Install the \"LTS\" version from https://nodejs.org (it opens now), then double-click this file again."
  echo
  open "https://nodejs.org"
  read -r -p "Press Enter to close this window."
  exit 1
fi
if ! node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"; then
  echo "Your Node.js is too old. Install the current \"LTS\" version from https://nodejs.org"
  open "https://nodejs.org"; read -r -p "Press Enter to close this window."; exit 1
fi
if [ ! -d node_modules/express ]; then
  echo "Installing what Silinx needs (first time only, needs Internet)..."
  npm install --omit=dev || { read -r -p "Installation failed. Press Enter to close."; exit 1; }
fi
echo "Starting Silinx... your browser opens at http://127.0.0.1:${PORT:-8642}"
node bin/silinx-ise.js serve --open
