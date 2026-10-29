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
import asyncio
import json
import math
import os
import re
import secrets
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from typing import Any

HOST = "127.0.0.1"
PORT = 8787
MAX_BODY_BYTES = 8192
PROTOCOL_VERSION = 4


def _reject_constant(name: str) -> float:
    raise ValueError(f"non-finite JSON constant not allowed: {name}")

PALETTE = {
    "mint": (0.45, 1.0, 0.78),
    "violet": (0.72, 0.50, 1.0),
    "amber": (1.0, 0.82, 0.42),
    "red": (1.0, 0.36, 0.47),
    "blue": (0.49, 0.86, 1.0),
    "off": (0.0, 0.0, 0.0),
}

_HEX_RE = re.compile(r"#?([0-9a-fA-F]{6})\Z")


def resolve_color(name: str) -> tuple[float, float, float]:
    """PALETTE name first; `#rrggbb` hex second (2026-08-22e: the web client
    sends hex from its choreography palette — before this, every hex silently
    rendered as mint and dance light-shows were invisible)."""
    text = str(name).strip().lower()
    if text in PALETTE:
        return PALETTE[text]
    m = _HEX_RE.fullmatch(text)
    if m:
        v = int(m.group(1), 16)
        return ((v >> 16 & 255) / 255.0, (v >> 8 & 255) / 255.0, (v & 255) / 255.0)
    return PALETTE["mint"]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def require_finite(value: Any, name: str) -> float:
    """Validate a JSON-supplied motor parameter: must be a finite number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"'{name}' must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"'{name}' must be a finite number")
    return number


class _OperationCancelled(RuntimeError):
    pass


class _BudgetExpired(_OperationCancelled):
    pass


class _BleLoop:
    """ONE permanent asyncio event loop on ONE daemon thread.

    Bleak requires that every operation (connect, GATT I/O, notifications)
    runs on the same always-running loop that created the client
    (https://bleak.readthedocs.io/en/latest/troubleshooting.html). The Ozobot
    SDK's sync wrapper violates this by sharing one asyncio.Runner across
    threads, which is exactly what produced "This event loop is already
    running" errors and silent hangs in this bridge (2026-08-22 council).

    All SDK access now goes through call(): schedule a coroutine onto this
    loop via run_coroutine_threadsafe and block the calling (HTTP worker)
    thread for at most `timeout` seconds. On timeout the TASK is cancelled —
    the loop itself stays healthy, so no thread ever gets held hostage by SDK
    internals again.
    """

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="ozo-ble", daemon=True)
        self.thread.start()

    def call(self, coro, timeout: float, cancel: threading.Event | None = None):
        if cancel is not None and cancel.is_set():
            coro.close()
            raise _OperationCancelled("Operation stopped")
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        deadline = time.monotonic() + timeout
        while True:
            if cancel is not None and cancel.is_set():
                future.cancel()
                raise _OperationCancelled("Operation stopped")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                future.cancel()
                raise TimeoutError(f"BLE operation exceeded {timeout}s ceiling and was cancelled")
            try:
                return future.result(min(remaining, 0.025) if cancel is not None else remaining)
            except FuturesTimeoutError:
                # A TimeoutError raised by the SDK is not a polling timeout.
                if future.done():
                    raise


# ---------------------------------------------------------------------------
# Test-only fake async robot (OZI_FAKE_BLE=1). Lets the QA suites exercise the
# REAL hardware plumbing (owned loop, timeouts, cancellation, link loss)
# without a radio. Hooks: OZI_FAKE_HANG_AT_OP=k makes op k hang until cancelled;
# OZI_FAKE_DROP_AT_OP=k makes op k raise a bleak-shaped "Not connected".
class _FakeBleakError(Exception):
    pass


_FakeBleakError.__module__ = "bleak.exception"
_FakeBleakError.__qualname__ = "BleakError"


class _FakeSample:
    def __init__(self, value: Any) -> None:
        self.value = value


class _FakeRegion:
    def __init__(self, value: Any = False) -> None:
        self._value = value

    async def read(self) -> _FakeSample:
        await asyncio.sleep(0.005)
        return _FakeSample(self._value)


class _FakeData:
    def __init__(self) -> None:
        self.obstacle_left_front = _FakeRegion(False)
        self.obstacle_right_front = _FakeRegion(False)
        self.surface_color = _FakeRegion("UNKNOWN")


class _FakeEvo:
    def __init__(self, hang_at: int = 0, drop_at: int = 0) -> None:
        self.data = _FakeData()
        self._hang_at = hang_at
        self._drop_at = drop_at
        self._ops = 0
        # Match the installed native SDK's passive connection-state path.
        self._client = SimpleNamespace(is_connected=True)
        self._driver = SimpleNamespace(
            _control=SimpleNamespace(_channel=SimpleNamespace(_client=self._client)))

    async def _hook(self) -> None:
        self._ops += 1
        if self._hang_at and self._ops == self._hang_at:
            await asyncio.sleep(45)
        if self._drop_at and self._ops == self._drop_at:
            self._client.is_connected = False
            raise _FakeBleakError("Not connected")
        await asyncio.sleep(0.02)

    async def move(self, distance_mm: float, speed_mmps: float) -> None:
        await self._hook()

    async def rotate(self, angle_deg: float, angular_speed_degps: float) -> None:
        await self._hook()

    async def set_velocity(self, linear_mmps: float, angular_degps: float, duration_s: float) -> None:
        await asyncio.sleep(0.01)

    async def play_tone(self, frequency_hz: int, duration_s: float) -> None:
        await self._hook()

    async def set_led(self, mask: Any, color: Any) -> None:
        await self._hook()


class _FakeLEDMask:
    ALL_ROBOT = "all"


def _fake_raw_color(r: float, g: float, b: float) -> tuple[float, float, float]:
    return (r, g, b)


class RobotController:
    def __init__(self, simulate: bool = False, robot_name: str = "OzoEvo-*") -> None:
        self.simulate = simulate
        self.robot_name = robot_name
        self.connected = False
        self.robot = None
        self.evo = None
        self._handle = None
        self._ctx = None
        self.sdk_error: str | None = None
        self.surface = "unclassified"
        self._imports: dict[str, Any] = {}
        self.play_mode = "desk"
        # Each admitted operation retains its event. STOP sets that event and
        # creates a new one; queued work can never clear its own cancellation.
        self._cancel_event = threading.Event()
        self._operation = threading.local()
        # A routine owns the hardware for its whole duration.  The browser also
        # polls proximity in the background, so keep that read out of the
        # hardware queue while a routine is running instead of letting it
        # time out behind movement and poison the worker.
        self._sequence_guard = threading.Lock()
        self._sequence_active = False
        self._state_lock = threading.RLock()
        self._last_proximity: dict[str, Any] = {"ok": True, "available": False}
        # Serialization queue: hardware ops run one-at-a-time on this worker.
        # Unlike before, a hung SDK call can no longer wedge this thread —
        # _BleLoop cancels the task at its inner ceiling (2026-08-22 council).
        self._hw = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ozo-hw")
        # ONE permanent asyncio loop owning all BLE work (bleak requirement).
        self._ble = _BleLoop()
        self.fake_ble = (not simulate) and os.environ.get("OZI_FAKE_BLE", "") == "1"
        self._fake_hang_at = int(os.environ.get("OZI_FAKE_HANG_AT_OP", "0") or 0)
        self._fake_drop_at = int(os.environ.get("OZI_FAKE_DROP_AT_OP", "0") or 0)

        if not self.simulate:
            if self.fake_ble:
                self._imports = {"LEDMask": _FakeLEDMask, "RawColor": _fake_raw_color}
            else:
                try:
                    from ozobot.evo import EvoHandle  # type: ignore
                    from ozobot.linefollower import LEDMask, RawColor  # type: ignore

                    self._imports = {
                        "EvoHandle": EvoHandle,
                        "LEDMask": LEDMask,
                        "RawColor": RawColor,
                    }
                except Exception as exc:
                    self.sdk_error = f"Ozobot SDK import failed: {exc}"

    # Per-operation ceilings. A BLE scan that never returns must not wedge the
    # single worker queue forever (observed: 42 queued connects, zero completions).
    OP_TIMEOUTS = {
        # Connect is its own slow path: a real Evo handshake can take ~20s,
        # so the ladder (2 attempts x ~50s + settle) must fit under this.
        "_connect_impl": 110.0,
        "_disconnect_impl": 10.0,
        "_sequence_impl": 10.0,
    }
    DEFAULT_TIMEOUT = 12.0
    SEQUENCE_BUDGET = 8.0
    # Leave room for cancellation before the worker-level timeout.
    INNER_MARGIN = 2.0

    def _sdk_call(self, operation, *args, timeout: float | None = None):
        if timeout is None:
            timeout = max(self.DEFAULT_TIMEOUT - self.INNER_MARGIN, 1.0)
        self._check_operation()
        cancel = getattr(self._operation, "cancel", None)
        deadline = getattr(self._operation, "deadline", None)
        if deadline is not None:
            timeout = min(timeout, max(0.0, deadline - time.monotonic()))

        async def dispatch():
            # Recheck on the BLE loop: the worker may have been descheduled
            # after admission. Create the SDK coroutine only after these
            # checks, so cancellation before dispatch cannot leak or run it.
            if cancel is not None and cancel.is_set():
                raise _OperationCancelled("Operation stopped")
            if deadline is not None and time.monotonic() >= deadline:
                raise _BudgetExpired("Sequence time budget exhausted")
            return await operation(*args)

        try:
            return self._ble.call(dispatch(), timeout, cancel)
        except TimeoutError:
            if deadline is not None and time.monotonic() >= deadline:
                raise _BudgetExpired("Sequence time budget exhausted") from None
            raise
        except Exception as exc:
            if self._is_link_dead(exc):
                self._mark_link_lost()
            raise

    def _submit(self, fn, *args, routine: bool = False) -> Any:
        """Serialize work, retaining cancellation from admission through execution.

        Never retry an operation: an error cannot tell us whether a motor
        command already reached the robot. Keep one worker even on timeout,
        rather than allowing a replacement to race a still-running old worker.
        """
        name = getattr(fn, "__name__", str(fn))
        timeout = self.OP_TIMEOUTS.get(name, self.DEFAULT_TIMEOUT)
        with self._state_lock:
            if routine:
                if not self._sequence_guard.acquire(blocking=False):
                    raise RuntimeError("A dance routine is already running")
                self._sequence_active = True
            cancel = self._cancel_event

            def run():
                self._operation.cancel = cancel
                self._operation.deadline = None
                try:
                    return dispatch_fn(*args)
                except Exception as exc:
                    # Invalidate on the worker before another queued job can
                    # start. Sensor errors swallowed by proximity are handled
                    # at the SDK boundary instead.
                    if self._is_link_dead(exc) and self.connected:
                        self._mark_link_lost()
                    raise
                finally:
                    self._operation.cancel = None
                    self._operation.deadline = None
                    if routine:
                        self._finish_routine()

            try:
                dispatch_fn = self._maybe_arm_test_drop(fn, name)
                future = self._hw.submit(run)
            except Exception:
                if routine:
                    self._finish_routine()
                raise
            if routine:
                # A cancelled queued job never enters run()'s finally block.
                # Running jobs retain the guard even if the HTTP call times out.
                future.add_done_callback(lambda f: self._finish_routine() if f.cancelled() else None)
        try:
            return future.result(timeout=timeout)
        except (FuturesTimeoutError, TimeoutError):
            cancel.set()
            future.cancel()
            self.stop()
            raise RuntimeError(f"Hardware operation '{name}' timed out; operation cancelled") from None

    def _finish_routine(self) -> None:
        with self._state_lock:
            self._sequence_active = False
            self._sequence_guard.release()

    _TEST_DROP_EXEMPT = ("_connect_impl", "_disconnect_impl", "_halt_motion",
                        "_proximity_impl", "_status_impl")

    def _maybe_arm_test_drop(self, fn, name):
        """Test hook (OZI_TEST_DROP_AT_OP=k): make the k-th counted hardware op
        raise a bleak 'Not connected' error once, to exercise link loss
        without real radio flakiness."""
        drop_at = int(os.environ.get("OZI_TEST_DROP_AT_OP", "0") or 0)
        if not drop_at or name in self._TEST_DROP_EXEMPT:
            return fn
        self._op_counter = getattr(self, "_op_counter", 0) + 1
        if self._op_counter != drop_at or getattr(self, "_drop_fired", False):
            return fn
        self._drop_fired = True

        def boom(*a, **kw):
            raise _FakeBleakError("Not connected")

        return boom

    def _is_link_dead(self, exc) -> bool:
        seen, cur = set(), exc
        while cur is not None and id(cur) not in seen:
            seen.add(id(cur))
            mod = type(cur).__module__ or ""
            if (mod.startswith("bleak") or type(cur).__name__ == "BleakError"):
                text = str(cur).lower()
                # On macOS, Bleak clears its cached GATT services as soon as
                # CoreBluetooth reports a disconnect. The ozobot SDK then
                # surfaces the next command as "Service Discovery has not
                # been performed yet" rather than "Not connected". Treat
                # both forms as the same stale-link condition so the bridge
                # invalidates the session instead of falsely keeping the
                # browser in CONNECTED state. Reconnect is always explicit.
                if (
                    "not connected" in text
                    or "disconnect" in text
                    or "closed" in text
                    or "service discovery has not been performed" in text
                ):
                    return True
            cur = cur.__cause__ if cur.__cause__ is not None else cur.__context__
        return False

    def _bury_link(self) -> None:
        handle, self._handle = self._handle, None
        self.evo = None
        self.robot = None
        with self._state_lock:
            self.connected = False
            self.play_mode = "desk"
            self._last_proximity = {"ok": True, "available": False}
        self._ctx = None
        if handle is not None:
            try:
                self._ble.call(handle.__aexit__(None, None, None), 5.0)
            except Exception:
                pass

    @property
    def mode(self) -> str:
        return "simulator" if self.simulate else "hardware"

    def connect(self) -> dict[str, Any]:
        # Detect a dead old handle before admitting the explicit new request.
        self.status()
        return self._submit(self._connect_impl)

    def _connect_impl(self) -> dict[str, Any]:
        self._check_operation()
        if self.connected:
            return self.status()
        if self._handle is not None or self.evo is not None:
            self._bury_link()
        if self.simulate:
            self.connected = True
            return self.status()
        if self.sdk_error:
            raise RuntimeError(self.sdk_error)
        if not self._imports:
            raise RuntimeError("Ozobot SDK is unavailable")

        # Connect resilience ladder (2026-08-22e, council C10). A slow/failed
        # BLE handshake is NORMAL for the experimental ozobot-evo driver — one
        # bad attempt must not kill the session. Each attempt: open the handle
        # ON the owned loop, and (critically) assign self._handle BEFORE awaiting
        # __aenter__ so a timeout can be properly buried instead of leaking a
        # half-open CoreBluetooth client that blocks every future reconnect.
        last_err = None
        for attempt in range(1, 3):
            try:
                self._sdk_call(self._async_connect, timeout=50.0)
                self._probe_hardware_ready()
                return self.status()
            except Exception as exc:
                last_err = exc
                self._bury_link()  # now effective: _async_connect pre-assigned the handle
                self._check_operation()  # STOP also cancels a pending connect/retry.
                if attempt < 2:
                    self._sleep(3.0)  # let the OS BLE stack settle
        raise RuntimeError(
            "The SDK loaded but did not open the Evo connection. "
            "The current ozobot-evo package is still experimental, so this may depend on its runtime driver. "
            f"Original error: {last_err}"
        ) from last_err

    async def _async_connect(self) -> None:
        if self.fake_ble:
            await asyncio.sleep(0.05)
            self.evo = _FakeEvo(hang_at=self._fake_hang_at, drop_at=self._fake_drop_at)
        else:
            handle = self._imports["EvoHandle"](name=self.robot_name)
            self._handle = handle  # assigned BEFORE awaiting so a timeout can be buried
            self.evo = await handle.__aenter__()
        self.connected = True

    def _probe_hardware_ready(self) -> None:
        """Force BLE service/control discovery before reporting CONNECTED."""
        if self.simulate or self.fake_ble:
            return
        LEDMask = self._imports["LEDMask"]
        RawColor = self._imports["RawColor"]
        self._sdk_call(
            self.evo.set_led, LEDMask.ALL_ROBOT, RawColor(0.0, 0.0, 0.0),
            timeout=8.0,
        )

    def disconnect(self) -> dict[str, Any]:
        self.stop()
        return self._submit(self._disconnect_impl)

    def _disconnect_impl(self) -> dict[str, Any]:
        try:
            self._sdk_call(
                self._async_close_handle,
                timeout=self.OP_TIMEOUTS["_disconnect_impl"] - self.INNER_MARGIN,
            )
        except Exception:
            pass
        self._ctx = None
        self.evo = None
        self._handle = None
        self._mark_link_lost()
        return self.status()

    async def _async_close_handle(self) -> None:
        if self._handle is not None:
            try:
                await asyncio.wait_for(self._handle.__aexit__(None, None, None), timeout=6.0)
            finally:
                self._handle = None

    @staticmethod
    def _client_connected(evo) -> bool:
        """No BLE I/O. Shape verified against the installed native Ozobot SDK.

        Evo/LineFollower._driver -> EvoNativeDriver._control ->
        AsyncControl._channel -> Characteristic._client (BleakClient).
        Bleak's CoreBluetooth is_connected property reads peripheral.state().
        An unknown driver shape fails closed, never as a truthy method/object.
        """
        try:
            return evo._driver._control._channel._client.is_connected is True
        except Exception:
            return False

    def _cancel_operations_locked(self) -> None:
        self._cancel_event.set()
        self._cancel_event = threading.Event()
        self.play_mode = "desk"

    def _mark_link_lost(self) -> None:
        with self._state_lock:
            self.connected = False
            self._cancel_operations_locked()
            self._last_proximity = {"ok": True, "available": False}

    def _connected_locked(self) -> bool:
        if self.connected and not self.simulate and not self._client_connected(self.evo):
            self._mark_link_lost()
        return self.connected

    def status(self) -> dict[str, Any]:
        # Passive: no queue, scan, GATT probe, reconnect, halt, or other write.
        with self._state_lock:
            connected = self._connected_locked()
            return {
                "ok": True,
                "protocol_version": PROTOCOL_VERSION,
                "mode": self.mode,
                "connected": connected,
                "play_mode": self.play_mode,
                "robot": self.robot_name,
                "sdk_available": bool(self._imports) or self.simulate,
                "sdk_error": self.sdk_error,
                "surface": self.surface,
            }

    def set_play_mode(self, mode: Any, floor_confirmed: Any = False) -> dict[str, Any]:
        if mode not in ("desk", "floor"):
            raise ValueError("'mode' must be 'desk' or 'floor'")
        if mode == "desk":
            self.stop()
        else:
            if floor_confirmed is not True:
                raise ValueError("Floor mode requires floor_confirmed: true")
            with self._state_lock:
                if not self._connected_locked():
                    raise RuntimeError("Evo is not connected")
                self.play_mode = "floor"
        return self.status()

    def _check_operation(self) -> None:
        cancel = getattr(self._operation, "cancel", None)
        if cancel is not None and cancel.is_set():
            raise _OperationCancelled("Operation stopped")
        deadline = getattr(self._operation, "deadline", None)
        if deadline is not None and time.monotonic() >= deadline:
            raise _BudgetExpired("Sequence time budget exhausted")

    def _sleep(self, seconds: float) -> float:
        """Interruptible sleep; return the actual clipped wait for reporting."""
        self._check_operation()
        deadline = getattr(self._operation, "deadline", None)
        if deadline is not None:
            seconds = min(seconds, max(0.0, deadline - time.monotonic()))
        started = time.monotonic()
        cancel = getattr(self._operation, "cancel", None)
        if cancel is None:
            time.sleep(seconds)
        else:
            cancel.wait(seconds)
        return min(seconds, time.monotonic() - started)

    def _require(self) -> None:
        self._check_operation()
        with self._state_lock:
            if not self._connected_locked():
                raise RuntimeError("Evo is not connected")

    def _require_motion(self) -> None:
        self._require()
        with self._state_lock:
            if self.play_mode != "floor":
                raise RuntimeError("Motion requires confirmed floor mode")

    def move(self, distance: float, speed: float) -> dict[str, Any]:
        self._require_motion()
        distance = clamp(require_finite(distance, "distance"), -120, 120)
        speed = clamp(abs(require_finite(speed, "speed")), 20, 80)
        if self.simulate:
            self._sleep(min(abs(distance) / max(speed, 1), 0.35))
            self._check_operation()
        else:
            evo = self.evo
            self._sdk_call(evo.move, distance, speed)
        return {"ok": True, "action": "move", "distance": distance, "speed": speed}

    def turn(self, angle: float, speed: float) -> dict[str, Any]:
        self._require_motion()
        angle = clamp(require_finite(angle, "angle"), -180, 180)
        speed = clamp(abs(require_finite(speed, "speed")), 30, 120)
        if self.simulate:
            self._sleep(min(abs(angle) / max(speed, 1), 0.35))
            self._check_operation()
        else:
            evo = self.evo
            self._sdk_call(evo.rotate, angle, speed)
        return {"ok": True, "action": "turn", "angle": angle, "speed": speed}

    def led(self, name: str) -> dict[str, Any]:
        self._require()
        rgb = resolve_color(name)
        if not self.simulate:
            LEDMask = self._imports["LEDMask"]
            RawColor = self._imports["RawColor"]
            evo = self.evo
            self._sdk_call(evo.set_led, LEDMask.ALL_ROBOT, RawColor(*rgb))
        return {"ok": True, "action": "led", "color": str(name)}

    def tone(self, frequency: float, duration: float) -> dict[str, Any]:
        self._require()
        frequency = clamp(require_finite(frequency, "frequency"), 180, 1600)
        duration = clamp(require_finite(duration, "duration"), 0.03, 0.35)
        if not self.simulate:
            # The browser mirrors every melody locally.  PlayTone is disabled
            # on the real Evo because this SDK/firmware combination can leave
            # the BLE command stream in FinishedForced or a multi-second hang;
            # a cosmetic beep must never take down movement or a mission.
            pass
        else:
            self._sleep(duration)
            self._check_operation()
        return {"ok": True, "action": "tone", "frequency": frequency, "duration": duration}

    def read_color(self) -> dict[str, Any]:
        self._require()
        if self.simulate:
            self.surface = secrets.choice(["GREEN", "BLUE", "YELLOW", "PURPLE", "UNKNOWN"])
        else:
            sample = self._sdk_call(self.evo.data.surface_color.read, timeout=6.0)
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
        self._require_motion()
        self.led("amber")
        self.turn(45, 90)
        self.turn(-90, 100)
        self.turn(45, 90)
        self.tone(784, 0.07)
        self.led("mint")
        return {"ok": True, "action": "dance"}

    SEQUENCE_KEYS = ("led", "tone", "move", "turn", "wait")
    NESTED_KEYS = {
        "move": ("distance", "speed"),
        "turn": ("angle", "speed"),
        "tone": ("frequency", "duration"),
    }

    def _validate_sequence_step(self, index: int, step: Any) -> None:
        if not isinstance(step, dict):
            raise ValueError(f"step {index} must be an object")
        unknown = sorted(str(key) for key in step if key not in self.SEQUENCE_KEYS)
        if unknown:
            raise ValueError(f"step {index} has unknown keys: {', '.join(unknown)}")
        if not step:
            raise ValueError(f"step {index} must set at least one of: led, tone, move, turn, wait")
        if "led" in step and not isinstance(step["led"], str):
            raise ValueError(f"step {index} 'led' must be a string")
        for key in ("move", "turn", "tone"):
            if key not in step:
                continue
            if not isinstance(step[key], dict):
                raise ValueError(f"step {index} '{key}' must be an object")
            nested_unknown = sorted(str(k) for k in step[key] if k not in self.NESTED_KEYS[key])
            if nested_unknown:
                raise ValueError(f"step {index} '{key}' has unknown keys: {', '.join(nested_unknown)}")
        if "move" in step:
            require_finite(step["move"].get("distance", 40), "distance")
            require_finite(step["move"].get("speed", 50), "speed")
        if "turn" in step:
            require_finite(step["turn"].get("angle", 35), "angle")
            require_finite(step["turn"].get("speed", 70), "speed")
        if "tone" in step:
            require_finite(step["tone"].get("frequency", 660), "frequency")
            require_finite(step["tone"].get("duration", 0.08), "duration")
        if "wait" in step:
            require_finite(step["wait"], "wait")

    def sequence(self, steps: Any) -> dict[str, Any]:
        return self._submit(self._sequence_impl, steps, routine=True)

    def _sequence_impl(self, steps: Any) -> dict[str, Any]:
        if not isinstance(steps, list):
            raise ValueError("'steps' must be a list")
        # Enforcement point: a stale or buggy client must never be able to kill
        # the radio link with a validation error. Oversized sequences are cut to
        # the contract limit and reported via truncated=true (2026-08-22 council).
        client_steps = len(steps)
        if client_steps > 16:
            steps = steps[:16]
            print(f"[hw {time.strftime('%H:%M:%S')}] WARNING client sent {client_steps} steps — "
                  "executing first 16 only (client may be stale)", flush=True)
        plan: list[tuple[int, dict[str, Any]]] = []
        for index, step in enumerate(steps):
            self._validate_sequence_step(index, step)
            plan.append((index, step))

        self._operation.deadline = time.monotonic() + self.SEQUENCE_BUDGET
        results: list[dict[str, Any]] = []
        truncated = client_steps > 16
        try:
            self._check_operation()
            # Reject a motor-bearing routine in desk mode before its LEDs or
            # tones execute. Primitive methods also enforce this at dispatch.
            if any("move" in step or "turn" in step for _, step in plan):
                self._require_motion()
            for index, step in plan:
                actions: list[dict[str, Any]] = []
                try:
                    for key in self.SEQUENCE_KEYS:
                        if key not in step:
                            continue
                        self._check_operation()
                        if key == "led":
                            result = self.led(step[key])
                        elif key == "tone":
                            result = self.tone(step[key].get("frequency", 660), step[key].get("duration", 0.08))
                        elif key == "move":
                            result = self.move(step[key].get("distance", 40), step[key].get("speed", 50))
                        elif key == "turn":
                            result = self.turn(step[key].get("angle", 35), step[key].get("speed", 70))
                        else:
                            seconds = clamp(require_finite(step[key], "wait"), 0.0, 1.5)
                            slept = self._sleep(seconds)
                            result = {"ok": True, "action": "wait", "seconds": slept}
                        actions.append(result)
                        # Includes the last primitive/last wait: clipping that
                        # final wait must still be reported as truncation.
                        self._check_operation()
                finally:
                    if actions:
                        results.append({"index": index, "ok": True, "actions": actions})
        except _BudgetExpired:
            truncated = True
            self.stop()
        except _OperationCancelled:
            truncated = True
        return {
            "ok": True,
            "action": "sequence",
            "results": results,
            "truncated": truncated,
            "steps_executed": len(results),
            "steps_received": client_steps,
        }

    def stop(self) -> dict[str, Any]:
        with self._state_lock:
            self._cancel_operations_locked()
            # Submit on the owned BLE loop directly, never behind a routine.
            self._halt_motion()
        return {"ok": True, "action": "stop"}

    def _halt_motion(self) -> None:
        evo = self.evo
        if self.simulate or not self._client_connected(evo):
            return

        async def halt():
            try:
                await asyncio.wait_for(evo.set_velocity(0, 0, 0), timeout=0.5)
            except (Exception, asyncio.CancelledError):
                pass  # STOP is best effort, including when the radio is gone.

        coro = halt()
        try:
            asyncio.run_coroutine_threadsafe(coro, self._ble.loop)
        except Exception:
            coro.close()

    def proximity(self) -> dict[str, Any]:
        # Never enqueue a read behind a live routine.  Returning the last
        # sample keeps the safety UI responsive without competing with motion
        # on the single BLE worker.
        with self._state_lock:
            if not self._connected_locked():
                return {"ok": True, "available": False}
            if self._sequence_active:
                return dict(self._last_proximity)
        try:
            result = self._submit(self._proximity_impl)
        except Exception:
            result = {"ok": True, "available": False}
        with self._state_lock:
            if not self._connected_locked():
                result = {"ok": True, "available": False}
            self._last_proximity = dict(result)
        return result

    def _proximity_impl(self) -> dict[str, Any]:
        if self.simulate or not self.connected or self.evo is None:
            return {"ok": True, "available": False}
        evo = self.evo
        try:
            left, right = self._sdk_call(self._async_proximity, evo, timeout=4.0)
        except Exception:
            return {"ok": True, "available": False}
        return {"ok": True, "available": True, "front": {"left": left, "right": right}}

    @staticmethod
    async def _async_proximity(evo) -> tuple[Any, Any]:
        # SDK Sample has no __bool__: Sample(0, timestamp) is truthy.
        left = bool((await evo.data.obstacle_left_front.read()).value)
        right = bool((await evo.data.obstacle_right_front.read()).value)
        return left, right

    def action(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._submit(self._action_impl, payload, routine=payload.get("action") == "dance")

    def _action_impl(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._check_operation()
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
    server_version = "OzoPetBridge/0.4"

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
        supplied = self.headers.get("X-OzoPet-Key", "")
        try:
            # Byte comparison: str mode rejects non-ASCII input with TypeError.
            return secrets.compare_digest(supplied.encode("utf-8"), self.bridge_key.encode("utf-8"))
        except (TypeError, ValueError, UnicodeEncodeError):
            return False

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
        payload = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
        return payload

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            if not self._authorized():
                return self._json(401, {"ok": False, "error": "invalid bridge key"})
            return self._json(200, self.controller.status())
        if self.path == "/proximity":
            if not self._authorized():
                return self._json(401, {"ok": False, "error": "invalid bridge key"})
            return self._json(200, self.controller.proximity())
        return self._json(404, {"ok": False, "error": "not found"})

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
            elif self.path == "/sequence":
                result = self.controller.sequence(payload.get("steps"))
            elif self.path == "/play-mode":
                result = self.controller.set_play_mode(payload.get("mode"), payload.get("floor_confirmed", False))
            elif self.path == "/stop":
                result = self.controller.stop()
            else:
                return self._json(404, {"ok": False, "error": "not found"})
            self._json(200, result)
        except (ValueError, RuntimeError) as exc:
            self._json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            self._json(500, {"ok": False, "error": f"bridge failure: {exc}"})


class BridgeServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], controller: RobotController, bridge_key: str):
        super().__init__(address, BridgeHandler)
        self.controller = controller
        self.bridge_key = bridge_key


def main() -> int:
    parser = argparse.ArgumentParser(description="OzoPet local Evo bridge")
    parser.add_argument("--sim", action="store_true", help="Run without hardware for bridge/UI testing")
    parser.add_argument("--name", default=os.environ.get("OZOBOT_NAME", "OzoEvo-*"), help="Evo BLE name filter")
    parser.add_argument("--port", type=int, default=PORT,
                        help="Local port (the web UI always calls the default 8787; override only for testing)")
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
