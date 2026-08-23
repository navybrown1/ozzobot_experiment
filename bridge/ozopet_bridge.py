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
from typing import Any

HOST = "127.0.0.1"
PORT = 8787
MAX_BODY_BYTES = 8192


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

    def call(self, coro, timeout: float):
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        try:
            return future.result(timeout)
        except FuturesTimeoutError:
            future.cancel()
            raise TimeoutError(f"BLE operation exceeded {timeout}s ceiling and was cancelled") from None


# ---------------------------------------------------------------------------
# Test-only fake async robot (OZI_FAKE_BLE=1). Lets the QA suites exercise the
# REAL hardware plumbing (owned loop, timeouts, cancellation, auto-resurrect)
# without a radio. Hooks: OZI_FAKE_HANG_AT_OP=k makes op k hang until cancelled;
# OZI_FAKE_DROP_AT_OP=k makes op k raise a bleak-shaped "Not connected".
class _FakeBleakError(Exception):
    pass


_FakeBleakError.__module__ = "bleak.exception"
_FakeBleakError.__qualname__ = "BleakError"


class _FakeSample:
    def __init__(self, value: Any) -> None:
        self.value = value

    def __bool__(self) -> bool:
        return bool(self.value)


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

    async def _hook(self) -> None:
        self._ops += 1
        if self._hang_at and self._ops == self._hang_at:
            await asyncio.sleep(45)
        if self._drop_at and self._ops == self._drop_at:
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
        self._abort = False
        self._recovery_lock = threading.Lock()
        self._timeout_strikes: list[float] = []
        self._lifetime_timeouts = 0
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
        "_halt_motion": 6.0,
        "_sequence_impl": 30.0,
    }
    DEFAULT_TIMEOUT = 12.0
    # Inner ceilings are always below the outer _submit ceiling so the owned
    # loop cancels a hung task BEFORE the worker-level timeout machinery would
    # fire — the replacement path should now be unreachable dead weight.
    INNER_MARGIN = 2.0

    def _sdk_call(self, coro, timeout: float | None = None):
        if timeout is None:
            timeout = max(self.DEFAULT_TIMEOUT - self.INNER_MARGIN, 1.0)
        return self._ble.call(coro, timeout)

    def _submit(self, fn, *args) -> Any:
        """Run a controller operation on the single hardware worker.

        Bounded wait + poisoned-worker replacement: if the SDK hangs past its
        ceiling, return an error to the caller and swap in a fresh executor so
        later jobs are not stuck behind the hung thread.
        """
        import threading, time, traceback
        name = getattr(fn, "__name__", str(fn))
        timeout = self.OP_TIMEOUTS.get(name, self.DEFAULT_TIMEOUT)
        ts = lambda: time.strftime("%H:%M:%S")
        print(f"[hw {ts()}] submit {name} on worker (timeout={timeout}s)", flush=True)
        dispatch_fn = self._maybe_arm_test_drop(fn, name)
        future = self._hw.submit(dispatch_fn, *args)
        t0 = time.monotonic()
        try:
            result = future.result(timeout=timeout)
            print(f"[hw {ts()}] done {name} in {time.monotonic() - t0:.2f}s", flush=True)
            return result
        except FuturesTimeoutError:
            # A connect timeout is an EXPECTED, user-initiated slow path — never
            # treat it as an orphaned-link emergency that kills the process or
            # churns the executor (2026-08-22e C10).
            if name == "_connect_impl":
                print(f"[hw {ts()}] TIMEOUT {name} after {timeout}s — connect gave up (no escalation)", flush=True)
                raise RuntimeError(
                    f"Hardware operation '{name}' timed out. The Bluetooth link was stuck; "
                    "the bridge recovered itself — try connecting again."
                ) from None
            print(f"[hw {ts()}] TIMEOUT {name} after {timeout}s — replacing wedged worker", flush=True)
            with self._recovery_lock:
                self._replace_worker_locked()
                escalate = self._escalate_locked()
                if escalate:
                    # The OS-level Bluetooth link is orphaned; only a process exit
                    # reliably releases it. Try to stop motion first, best effort.
                    try:
                        self._hw.submit(self._halt_motion).result(timeout=4)
                        self.connected = False
                    except Exception:
                        print("[hw] halt unconfirmed before recovery exit", flush=True)
                if escalate:
                    print("[hw] repeated timeouts — exiting so supervisor restarts a clean "
                          "bridge (only a process exit reliably releases the Bluetooth link)", flush=True)
                    print(f"[hw {time.strftime('%H:%M:%S')}] recovery exit", flush=True)
                    os._exit(75)
            raise RuntimeError(
                f"Hardware operation '{name}' timed out. The Bluetooth link was stuck; "
                "the bridge recovered itself — try connecting again."
            ) from None
        except Exception as exc:
            # Silent auto-resurrect: BLE links do drop mid-session (2026-08-22
            # 17:57 incident — link died between two dances). If the robot was
            # believed alive and the failure says otherwise, rebuild the
            # connection once and retry the operation before giving up.
            if (
                self.connected
                and name not in ("_connect_impl", "_disconnect_impl", "_halt_motion")
                and self._is_link_dead(exc)
            ):
                print(f"[hw {ts()}] LINK LOST during {name} — attempting silent auto-resurrect", flush=True)
                try:
                    self._bury_link()
                    self._hw.submit(self._connect_impl).result(timeout=self.OP_TIMEOUTS["_connect_impl"])
                    print(f"[hw {ts()}] auto-resurrect OK — retrying {name}", flush=True)
                    t1 = time.monotonic()
                    result = self._hw.submit(fn, *args).result(timeout=timeout)
                    print(f"[hw {ts()}] done {name} (retried) in {time.monotonic() - t1:.2f}s", flush=True)
                    return result
                except Exception as resurrect_exc:
                    print(
                        f"[hw {ts()}] auto-resurrect FAILED — giving up so the app sees the real error:\n"
                        f"{resurrect_exc}",
                        flush=True,
                    )
            print(f"[hw {ts()}] FAILED {name}:\n{traceback.format_exc()}", flush=True)
            raise

    _RESURRECT_EXEMPT = ("_connect_impl", "_disconnect_impl", "_halt_motion",
                         "_proximity_impl", "_status_impl")

    def _maybe_arm_test_drop(self, fn, name):
        """Test hook (OZI_TEST_DROP_AT_OP=k): make the k-th counted hardware op
        raise a bleak 'Not connected' error once, to exercise auto-resurrect
        without real radio flakiness."""
        drop_at = int(os.environ.get("OZI_TEST_DROP_AT_OP", "0") or 0)
        if not drop_at or name in self._RESURRECT_EXEMPT:
            return fn
        self._op_counter = getattr(self, "_op_counter", 0) + 1
        if self._op_counter != drop_at or getattr(self, "_drop_fired", False):
            return fn
        self._drop_fired = True

        def boom(*a, **kw):
            try:
                import bleak
                raise bleak.BleakError("Not connected")
            except ImportError:
                raise RuntimeError("simulated link loss (bleak unavailable)")

        return boom

    def _is_link_dead(self, exc) -> bool:
        seen, cur = set(), exc
        while cur is not None and id(cur) not in seen:
            seen.add(id(cur))
            mod = type(cur).__module__ or ""
            if (mod.startswith("bleak") or type(cur).__name__ == "BleakError"):
                text = str(cur).lower()
                if "not connected" in text or "disconnect" in text or "closed" in text:
                    return True
            cur = cur.__cause__ if cur.__cause__ is not None else cur.__context__
        return False

    def _bury_link(self) -> None:
        handle, self._handle = self._handle, None
        self.evo = None
        self.robot = None
        self.connected = False
        self._ctx = None
        if handle is not None:
            try:
                self._ble.call(handle.__aexit__(None, None, None), 5.0)
            except Exception:
                pass

    def _replace_worker_locked(self) -> None:
        """Discard the executor whose thread is stuck inside SDK code.

        cancel_futures: jobs still queued behind the wedged op must NOT run later
        on the zombie thread and mutate controller state concurrently with the
        fresh worker (the BLE SDK is not thread-safe).
        """
        old = self._hw
        self._hw = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ozo-hw")
        old.shutdown(wait=False, cancel_futures=True)

    def _escalate_locked(self) -> bool:
        """True when timeouts cluster (orphaned BLE link — exit and let the
        supervisor restart us clean), or when they keep recurring over the
        bridge's lifetime (slow leak of un-killable zombie threads)."""
        now = time.monotonic()
        recent = [t for t in self._timeout_strikes if now - t < 120]
        recent.append(now)
        self._timeout_strikes = recent
        self._lifetime_timeouts += 1
        return len(recent) >= 2 or self._lifetime_timeouts >= 5

    @property
    def mode(self) -> str:
        return "simulator" if self.simulate else "hardware"

    def connect(self) -> dict[str, Any]:
        return self._submit(self._connect_impl)

    def _connect_impl(self) -> dict[str, Any]:
        if self.connected:
            return self.status()
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
                self._sdk_call(self._async_connect(), timeout=50.0)
                return self.status()
            except Exception as exc:
                last_err = exc
                self._bury_link()  # now effective: _async_connect pre-assigned the handle
                if attempt < 2:
                    try:
                        self._ble.call(asyncio.sleep(3.0), 4.0)  # let the OS BLE stack settle
                    except Exception:
                        pass
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

    def disconnect(self) -> dict[str, Any]:
        return self._submit(self._disconnect_impl)

    def _disconnect_impl(self) -> dict[str, Any]:
        try:
            self._sdk_call(
                self._async_close_handle(),
                timeout=self.OP_TIMEOUTS["_disconnect_impl"] - self.INNER_MARGIN,
            )
        except Exception:
            pass
        self._ctx = None
        self.evo = None
        self._handle = None
        self.connected = False
        return self.status()

    async def _async_close_handle(self) -> None:
        if self._handle is not None:
            try:
                await asyncio.wait_for(self._handle.__aexit__(None, None, None), timeout=6.0)
            finally:
                self._handle = None

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
        distance = clamp(require_finite(distance, "distance"), -120, 120)
        speed = clamp(abs(require_finite(speed, "speed")), 20, 80)
        if self.simulate:
            time.sleep(min(abs(distance) / max(speed, 1), 0.35))
        else:
            evo = self.evo
            self._sdk_call(evo.move(distance, speed))
        return {"ok": True, "action": "move", "distance": distance, "speed": speed}

    def turn(self, angle: float, speed: float) -> dict[str, Any]:
        self._require()
        angle = clamp(require_finite(angle, "angle"), -180, 180)
        speed = clamp(abs(require_finite(speed, "speed")), 30, 120)
        if self.simulate:
            time.sleep(min(abs(angle) / max(speed, 1), 0.35))
        else:
            evo = self.evo
            self._sdk_call(evo.rotate(angle, speed))
        return {"ok": True, "action": "turn", "angle": angle, "speed": speed}

    def led(self, name: str) -> dict[str, Any]:
        self._require()
        rgb = resolve_color(name)
        if not self.simulate:
            LEDMask = self._imports["LEDMask"]
            RawColor = self._imports["RawColor"]
            evo = self.evo
            self._sdk_call(evo.set_led(LEDMask.ALL_ROBOT, RawColor(*rgb)))
        return {"ok": True, "action": "led", "color": str(name)}

    def tone(self, frequency: float, duration: float) -> dict[str, Any]:
        self._require()
        frequency = clamp(require_finite(frequency, "frequency"), 180, 1600)
        duration = clamp(require_finite(duration, "duration"), 0.03, 0.35)
        if not self.simulate:
            evo = self.evo
            self._sdk_call(evo.play_tone(int(frequency), duration))
        else:
            time.sleep(duration)
        return {"ok": True, "action": "tone", "frequency": frequency, "duration": duration}

    def read_color(self) -> dict[str, Any]:
        self._require()
        if self.simulate:
            self.surface = secrets.choice(["GREEN", "BLUE", "YELLOW", "PURPLE", "UNKNOWN"])
        else:
            sample = self._sdk_call(self.evo.data.surface_color.read(), timeout=6.0)
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
        return self._submit(self._sequence_impl, steps)

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

        self._abort = False
        started = time.monotonic()
        budget = 8.0
        results: list[dict[str, Any]] = []
        truncated = False
        for index, step in plan:
            if self._abort or time.monotonic() - started >= budget:
                truncated = True
                break
            actions: list[dict[str, Any]] = []
            if "led" in step:
                actions.append(self.led(str(step["led"])))
            if "tone" in step:
                actions.append(self.tone(step["tone"].get("frequency", 660), step["tone"].get("duration", 0.08)))
            if "move" in step:
                actions.append(self.move(step["move"].get("distance", 40), step["move"].get("speed", 50)))
            if "turn" in step:
                actions.append(self.turn(step["turn"].get("angle", 35), step["turn"].get("speed", 70)))
            if "wait" in step:
                seconds = clamp(require_finite(step["wait"], "wait"), 0.0, 1.5)
                slept = max(0.0, min(seconds, budget - (time.monotonic() - started)))
                if slept > 0:
                    time.sleep(slept)
                actions.append({"ok": True, "action": "wait", "seconds": slept})
            results.append({"index": index, "ok": True, "actions": actions})
        return {
            "ok": True,
            "action": "sequence",
            "results": results,
            "truncated": truncated or client_steps > 16,
            "steps_executed": len(results),
            "steps_received": client_steps,
        }

    def stop(self) -> dict[str, Any]:
        # Instant: the abort flag is checked between sequence steps by the
        # hardware worker itself; velocity-zeroing is best-effort.
        self._abort = True
        if not self.simulate and self.evo is not None:
            try:
                self._submit(self._halt_motion)
            except Exception:
                pass
        return {"ok": True, "action": "stop"}

    def _halt_motion(self) -> None:
        try:
            if not self.simulate and self.evo is not None:
                evo = self.evo
                self._ble.call(evo.set_velocity(0, 0, 0), 3.0)
        except Exception:
            pass

    def proximity(self) -> dict[str, Any]:
        return self._submit(self._proximity_impl)

    def _proximity_impl(self) -> dict[str, Any]:
        if self.simulate or not self.connected or self.evo is None:
            return {"ok": True, "available": False}
        evo = self.evo
        try:
            left, right = self._ble.call(self._async_proximity(evo), 4.0)
        except Exception:
            return {"ok": True, "available": False}
        return {"ok": True, "available": True, "front": {"left": left, "right": right}}

    @staticmethod
    async def _async_proximity(evo) -> tuple[Any, Any]:
        left = bool(await evo.data.obstacle_left_front.read())
        right = bool(await evo.data.obstacle_right_front.read())
        return left, right

    def action(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._submit(self._action_impl, payload)

    def _action_impl(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._abort = False
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
    server_version = "OzoPetBridge/0.3"

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
