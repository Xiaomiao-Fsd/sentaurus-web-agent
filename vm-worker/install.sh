#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${VM_AGENT_HOME:-$HOME/.sentaurus-web-agent/vm-agent}"

mkdir -p "$TARGET_DIR" "$TARGET_DIR/capabilities" \
  "$TARGET_DIR/queue" "$TARGET_DIR/processed" "$TARGET_DIR/processing" \
  "$TARGET_DIR/locks" "$TARGET_DIR/manuals"

install -m 0644 "$SOURCE_DIR/agent_worker.py" "$TARGET_DIR/agent_worker.py"
install -m 0644 "$SOURCE_DIR/dfise_idvg_extract.py" "$TARGET_DIR/dfise_idvg_extract.py"
install -m 0755 "$SOURCE_DIR/vm-agent-autostart.sh" "$TARGET_DIR/vm-agent-autostart.sh"
install -m 0644 "$SOURCE_DIR/capabilities/dfise-plt-postprocess-v1.json" \
  "$TARGET_DIR/capabilities/dfise-plt-postprocess-v1.json"

[ -e "$TARGET_DIR/.env.example" ] || install -m 0600 "$SOURCE_DIR/.env.example" "$TARGET_DIR/.env.example"
[ -e "$TARGET_DIR/config.example.json" ] || install -m 0600 "$SOURCE_DIR/config.example.json" "$TARGET_DIR/config.example.json"
[ -e "$TARGET_DIR/AGENTS.md" ] || install -m 0644 "$SOURCE_DIR/AGENTS.example.md" "$TARGET_DIR/AGENTS.md"

printf 'Installed Sentaurus VM worker into %s\n' "$TARGET_DIR"
printf 'Runtime configuration and data were preserved.\n'

