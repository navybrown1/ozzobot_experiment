#!/bin/zsh

# Keep the local OzoPet bridge available for the hosted UI. launchd owns this
# process and restarts it if either this wrapper or the Python bridge exits.

set -u

SCRIPT_DIR="${0:A:h}"
PYTHON_BIN="$SCRIPT_DIR/.venv/bin/python"
BRIDGE_APP="$SCRIPT_DIR/ozopet_bridge.py"
KEY_FILE="${OZO_BRIDGE_KEY_FILE:-$HOME/Library/Application Support/OzoPet/bridge/bridge-key}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  print -u2 "OzoPet bridge environment is missing: $PYTHON_BIN"
  print -u2 "Run $SCRIPT_DIR/install.sh first."
  exit 78
fi

if [[ ! -s "$KEY_FILE" ]]; then
  umask 077
  mkdir -p "${KEY_FILE:h}"
  "$PYTHON_BIN" -c 'import secrets; print(secrets.token_hex(16))' > "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"
export OZOPET_BRIDGE_KEY="$(< "$KEY_FILE")"
export PYTHONUNBUFFERED=1

exec "$PYTHON_BIN" "$BRIDGE_APP"
