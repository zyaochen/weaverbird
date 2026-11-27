#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$PROJECT_ROOT/scripts/com.weaverbird.audit-pipe.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/com.weaverbird.audit-pipe.plist"
LOG_DIR="$HOME/.weaverbird/logs/_audit-pipe"
LABEL="com.weaverbird.audit-pipe"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$LOG_DIR"

sed -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" -e "s|__HOME__|$HOME|g" \
  "$TEMPLATE" > "$PLIST_DEST"

if ! plutil -lint "$PLIST_DEST"; then
  exit 1
fi

launchctl bootout "gui/$UID" "$PLIST_DEST" >/dev/null 2>&1 || true
if ! launchctl bootstrap "gui/$UID" "$PLIST_DEST"; then
  exit 2
fi

launchctl list | grep audit-pipe || true
printf 'Installed %s at %s\n' "$LABEL" "$PLIST_DEST"
printf 'Logs: %s\n' "$LOG_DIR"
