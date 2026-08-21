#!/usr/bin/env python3
"""OzoPet local hardware bridge.

Runs only on 127.0.0.1 and exposes a tiny, safety-clamped HTTP API to the
OzoPet web UI. Hardware support uses Ozobot's current Python API when the
package/runtime can open an Evo connection. Because the upstream package is
still labeled work in progress, this bridge also has a simulator mode.

Python 3.13+ is required by ozobot-evo 0.3.x.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

HOST = "127.0.0.1"
PORT = 8787
MAX_BODY_BYTES = 8192

PALETTE = {
    "mint": (0.45, 1.0, 0.78),
    "violet": (0.72, 0.50, 1.0),
    "amber": (1.0, 0.82, 0.42),
    "red": (1.0, 0.36, 0.47),
    "blue": (0.49, 0.86, 1.0),
    "off": (0.0, 0.0, 0.0),
}


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


class RobotController:
    def __init__(self, simulate: bool = False, robot_name: str = "OzoEvo-*") -> None:
        self.simulate = simulate
        self.robot_name = robot_name
        self.connected = False
        self.robot = None
        self._ctx = None
        self.sdk_error: str | None = None
        self.surface = "unclassified"
        self._imports: dict[str, Any] = {}

        if not self.simulate:
            try:
                from ozobot.evo import SyncEvoHandle  # type: ignore
                from ozobot.linefollower import LEDMask, RawColor  # type: ignore

                self._imports = {
                    "SyncEvoHandle": SyncEvoHandle,
                    "LEDMask": LEDMask,
                    "RawColor": RawColor,
                }
            except Exception as exc:
                self.sdk_error = f"Ozobot SDK import failed: {exc}"

    @property
    def mode(self) -> str:
        return "simulator" if self.simulate else "hardware"

    def connect(self) -> dict[str, Any]:
        if self.connected:
            return self.status()
        if self.simulate:
            self.connected = True
            return self.status()
        if self.sdk_error:
            raise RuntimeError(self.sdk_error)
        if not self._imports:
            raise RuntimeError("Ozobot SDK is unavailable")

        handle = None
        try:
            handle = self._imports["SyncEvoHandle"](name=self.robot_name)
            robot = handle.__enter__()
            self._ctx = handle
            self.robot = robot
            self.connected = True
            return self.status()
        except Exception as exc:
            if handle is not None:
                try:
                    handle.__exit__(type(exc), exc, exc.__traceback__)
                except Exception:
                    pass
            self.connected = False
            self.robot = None
            self._ctx = None
            raise RuntimeError(
                "The SDK loaded but did not open the Evo connection. "
                "The current ozobot-evo package is still experimental, so this may depend on its runtime driver. "
                f"Original error: {exc}"
            ) from exc

    def disconnect(self) -> dict[str, Any]:
        if self._ctx is not None:
            try:
                self._ctx.__exit__(None, None, None)
            except Exception:
                pass
        self._ctx = None
        self.robot = None
        self.connected = False
        return self.status()

    def status(self) -> dict[str, Any]:
        return {
            "ok": True,
            "mode": self.mode,
            "connected": self.connected,
            "robot": self.robot_name,
            "sdk_available": bool(self._imports) or self.simulate,
            "sdk_error": self.sdk_error,
            "surface": self.surface,
        }

    def _require(self) -> None:
        if not self.connected:
            raise RuntimeError("Evo is not connected")

    def move(self, distance: float, speed: float) -> dict[str, Any]:
        self._require()
        distance = clamp(float(distance), -120, 120)
        speed = clamp(abs(float(speed)), 20, 80)
        if self.simulate:
            time.sleep(min(abs(distance) / max(speed, 1), 0.35))
        else:
            self.robot.move(distance, speed)
        return {"ok": True, "action": "move", "distance": distance, "speed": speed}

    def turn(self, angle: float, speed: float) -> dict[str, Any]:
        self._require()
        angle = clamp(float(angle), -180, 180)
        speed = clamp(abs(float(speed)), 30, 120)
        if self.simulate:
            time.sleep(min(abs(angle) / max(speed, 1), 0.35))
        else:
            self.robot.rotate(angle, speed)
        return {"ok": True, "action": "turn", "angle": angle, "speed": speed}

    def led(self, name: str) -> dict[str, Any]:
        self._require()
        name = name if name in PALETTE else "mint"
        rgb = PALETTE[name]
        if not self.simulate:
            LEDMask = self._imports["LEDMask"]
            RawColor = self._imports["RawColor"]
            self.robot.set_led(LEDMask.ALL_ROBOT, RawColor(*rgb))
        return {"ok": True, "action": "led", "color": name}

    def tone(self, frequency: float, duration: float) -> dict[str, Any]:
        self._require()
        frequency = clamp(float(frequency), 180, 1600)
        duration = clamp(float(duration), 0.03, 0.35)
        if not self.simulate:
            self.robot.play_tone(int(frequency), duration)
        else:
            time.sleep(duration)
        return {"ok": True, "action": "tone", "frequency": frequency, "duration": duration}

    def read_color(self) -> dict[str, Any]:
        self._require()
        if self.simulate:
            self.surface = secrets.choice(["GREEN", "BLUE", "YELLOW", "PURPLE", "UNKNOWN"])
        else:
            sample = self.robot.data.surface_color.read()
            value = getattr(sample, "value", sample)
            self.surface = str(getattr(value, "name", value))
        return {"ok": True, "action": "read_color", "surface": self.surface}

    def hello(self) -> dict[str, Any]:
        self._require()
        self.led("mint")
        self.tone(660, 0.06)
        self.tone(880, 0.08)
        return {"ok": True, "action": "hello"}

    def dance(self) -> dict[str, Any]:
        self._require()
        self.led("amber")
        self.turn(45, 90)
        self.turn(-90, 100)
        self.turn(45, 90)
        self.tone(784, 0.07)
        self.led("mint")
        return {"ok": True, "action": "dance"}

    def action(self, payload: dict[str, Any]) -> dict[str, Any]:
        action = str(payload.get("action", ""))
        if action == "move":
            return self.move(payload.get("distance", 40), payload.get("speed", 50))
        if action == "turn":
            return self.turn(payload.get("angle", 35), payload.get("speed", 70))
        if action == "led":
            return self.led(str(payload.get("color", "mint")))
        if action == "tone":
            return self.tone(payload.get("frequency", 660), payload.get("duration", 0.08))
        if action == "read_color":
            return self.read_color()
        if action == "hello":
            return self.hello()
        if action == "dance":
            return self.dance()
        raise ValueError(f"Unsupported action: {action}")


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "OzoPetBridge/0.2"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[bridge] " + (fmt % args) + "\n")

    @property
    def controller(self) -> RobotController:
        return self.server.controller  # type: ignore[attr-defined]

    @property
    def bridge_key(self) -> str:
        return self.server.bridge_key  # type: ignore[attr-defined]

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-OzoPet-Key")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The browser can abandon a request if BLE discovery takes longer than its UI timeout.
            pass

    def _authorized(self) -> bool:
        return secrets.compare_digest(self.headers.get("X-OzoPet-Key", ""), self.bridge_key)

    def _read_body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError as exc:
            raise ValueError("Invalid Content-Length") from exc
        if length < 0:
            raise ValueError("Invalid Content-Length")
        if length > MAX_BODY_BYTES:
            raise ValueError("Request body too large")
        raw = self.rfile.read(length) if length else b"{}"
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
        return payload

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            return self._json(404, {"ok": False, "error": "not found"})
        if not self._authorized():
            return self._json(401, {"ok": False, "error": "invalid bridge key"})
        self._json(200, self.controller.status())

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            return self._json(401, {"ok": False, "error": "invalid bridge key"})
        try:
            payload = self._read_body()
            if self.path == "/connect":
                result = self.controller.connect()
            elif self.path == "/disconnect":
                result = self.controller.disconnect()
            elif self.path == "/action":
                result = self.controller.action(payload)
            else:
                return self._json(404, {"ok": False, "error": "not found"})
            self._json(200, result)
        except (ValueError, RuntimeError) as exc:
            self._json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            self._json(500, {"ok": False, "error": f"bridge failure: {exc}"})


class BridgeServer(HTTPServer):
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], controller: RobotController, bridge_key: str):
        super().__init__(address, BridgeHandler)
        self.controller = controller
        self.bridge_key = bridge_key


def main() -> int:
    parser = argparse.ArgumentParser(description="OzoPet local Evo bridge")
    parser.add_argument("--sim", action="store_true", help="Run without hardware for bridge/UI testing")
    parser.add_argument("--name", default=os.environ.get("OZOBOT_NAME", "OzoEvo-*"), help="Evo BLE name filter")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()

    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")

    key = os.environ.get("OZOPET_BRIDGE_KEY") or secrets.token_hex(12)
    controller = RobotController(simulate=args.sim, robot_name=args.name)
    server = BridgeServer((HOST, args.port), controller, key)

    print("\nOzoPet bridge")
    print("==============")
    print(f"mode: {controller.mode}")
    print(f"listening: http://{HOST}:{args.port}")
    print(f"bridge key: {key}")
    if controller.sdk_error:
        print(f"sdk note: {controller.sdk_error}")
    print("\nPaste the bridge key into OzoPet > Hardware Lab.")
    print("Press Ctrl+C to stop.\n")

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        controller.disconnect()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
