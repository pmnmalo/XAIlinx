#!/bin/sh
# Silinx launcher for Linux: run ./start-silinx-ise.sh (or double-click it, "Run in terminal").
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version (https://nodejs.org, or e.g. 'sudo apt install nodejs npm') and run this again."
  exit 1
fi
if ! node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"; then
  echo "Your Node.js is too old: install the current LTS version from https://nodejs.org"; exit 1
fi
[ -d node_modules/express ] || npm install --omit=dev || exit 1
echo "Starting Silinx at http://127.0.0.1:${PORT:-8642}"
exec node bin/silinx-ise.js serve --open
