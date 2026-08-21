#!/bin/zsh
# Install the OzoPet bridge Python environment (macOS/Linux, Python 3.13+).
#
# The Ozobot control packages are installed from the official monorepo at a
# pinned commit: the PyPI release of ozobot-evo 0.3.2 only supports the
# Ozobot Editor web runtime ("Evo native driver is not yet implemented") and
# its ozobot-ble dependency is unpublished on PyPI. Master implements native
# BLE via bleak, which works on macOS with CoreBluetooth.
#
# macOS note: the first BLE scan triggers a system prompt asking permission
# for python to use Bluetooth — approve it once.

set -euo pipefail

OZO_REF="${OZO_REF:-caead3f59c862e329cbb0a96abc0ce2c0e21999b}"
REPO="https://github.com/ozobot/python-libraries"
PY="${PYTHON:-../bridge/.venv/bin/python}"

if [ ! -x "$PY" ]; then
  PYTHON_BIN="${PYTHON_BIN:-python3.13}"
  echo "Creating .venv with $PYTHON_BIN (3.13+ required by the Ozobot SDK)"
  "$PYTHON_BIN" -m venv .venv
  PY="./.venv/bin/python"
fi

"$PY" -m pip install --upgrade pip

# Third-party dependencies first.
"$PY" -m pip install loguru "bleak~=2.0.0" "pydantic>=2.11.5" "ozobot-web>=0.3.0,<0.4.0"

# Official Ozobot packages from one pinned commit. Installed with --no-deps:
# the git builds self-report dev versions that do not satisfy each other's
# PyPI-style version ranges (a uv-workspace convention pip cannot see).
for pkg in ozobot-common ozobot-ble ozobot-linefollower ozobot-evo; do
  "$PY" -m pip install --no-deps "git+$REPO@$OZO_REF#subdirectory=$pkg"
done

echo
echo "Verifying imports and native driver selection..."
"$PY" - <<'PY'
from ozobot.evo import SyncEvoHandle
from ozobot.evo.driver import get_driver
from ozobot.linefollower import LEDMask, RawColor

driver = get_driver()
name = f"{driver.__module__}.{driver.__qualname__}"
assert "native" in name.lower(), f"expected native driver, got {name}"
print(f"OK: SyncEvoHandle available, driver = {name}")
PY

echo
echo "Done. Start the bridge with:"
echo "  $PY ozopet_bridge.py          # real Evo over Bluetooth"
echo "  $PY ozopet_bridge.py --sim    # simulator mode"
