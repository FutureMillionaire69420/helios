#!/bin/bash
# Double-click me (first time: right-click > Open). Keep this window open.
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed yet. Go to https://nodejs.org, install the LTS version, then double-click me again."
  read -p "Press Enter to close"; exit 1
fi
echo "Paper results and on/off state of the running bot"
node copybot.mjs status
read -p "Press Enter to close"
