#!/bin/zsh

# Install/update the OzoPet bridge as a per-user macOS LaunchAgent.
# Desktop is protected from background services, so launchd runs a synchronized
# runtime copy from ~/Library/Application Support/OzoPet/bridge.

set -euo pipefail

SCRIPT_DIR="${0:A:h}"
RUNTIME_DIR="$HOME/Library/Application Support/OzoPet/bridge"
AGENT_DIR="$HOME/Library/LaunchAgents"
AGENT_FILE="$AGENT_DIR/com.ozopet.bridge.plist"
SERVICE="com.ozopet.bridge"
USER_ID="$(id -u)"

if [[ ! -x "$SCRIPT_DIR/.venv/bin/python" ]]; then
  print -u2 "Bridge environment is missing. Run $SCRIPT_DIR/install.sh first."
  exit 78
fi

mkdir -p "$RUNTIME_DIR" "$AGENT_DIR"
ditto "$SCRIPT_DIR/.venv" "$RUNTIME_DIR/.venv"
install -m 0644 "$SCRIPT_DIR/ozopet_bridge.py" "$RUNTIME_DIR/ozopet_bridge.py"
install -m 0755 "$SCRIPT_DIR/run-supervised.sh" "$RUNTIME_DIR/run-supervised.sh"
install -m 0644 "$SCRIPT_DIR/com.ozopet.bridge.plist" "$AGENT_FILE"

launchctl bootout "gui/$USER_ID/$SERVICE" 2>/dev/null || true
loaded=0
for delay in 0 1 2; do
  if (( delay > 0 )); then
    sleep "$delay"
  fi
  if launchctl bootstrap "gui/$USER_ID" "$AGENT_FILE" 2>/dev/null; then
    loaded=1
    break
  fi
done
if (( loaded == 0 )); then
  print -u2 "Could not load $SERVICE after replacing its LaunchAgent."
  exit 1
fi
launchctl kickstart -k "gui/$USER_ID/$SERVICE"

for _ in {1..5}; do
  [[ -s "$RUNTIME_DIR/bridge-key" ]] && break
  sleep 1
done

print "OzoPet bridge service installed and started."
print "Health: http://127.0.0.1:8787/health"
if [[ -s "$RUNTIME_DIR/bridge-key" ]]; then
  print "Bridge key: $(< "$RUNTIME_DIR/bridge-key")"
  print "Key file: $RUNTIME_DIR/bridge-key"
fi
