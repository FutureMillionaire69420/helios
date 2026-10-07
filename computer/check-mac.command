#!/bin/bash
cd "$(dirname "$0")"
node copybot.mjs check
read -p "Press Enter to close"
