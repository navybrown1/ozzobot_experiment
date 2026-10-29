"""Bridge regressions: stdlib only, fake BLE/simulator, ephemeral HTTP ports.

Never connects to Bluetooth or the installed bridge on port 8787.
Run: bridge/.venv/bin/python -B -m unittest discover -s bridge -p 'test_*.py' -v
"""

import asyncio
import http.client
import json
import os
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

import ozopet_bridge as bridge


class BridgeTestCase(unittest.TestCase):
    def controller(self, simulate=False):
        with patch.dict(os.environ, {
            "OZI_FAKE_BLE": "1", "OZI_FAKE_DROP_AT_OP": "0",
            "OZI_FAKE_HANG_AT_OP": "0", "OZI_TEST_DROP_AT_OP": "0",
        }):
            controller = bridge.RobotController(simulate=simulate)
        self.addCleanup(self.close_controller, controller)
        return controller

    @staticmethod
    def close_controller(controller):
        controller._hw.shutdown(wait=True, cancel_futures=True)

        async def cancel_tasks():
            tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        controller._ble.call(cancel_tasks(), 2)
        controller._ble.loop.call_soon_threadsafe(controller._ble.loop.stop)
        controller._ble.thread.join(2)
        controller._ble.loop.close()

    def started_sequence(self, controller, steps):
        started = threading.Event()
        original = controller._sequence_impl

        def observed(*args):
            started.set()
            return original(*args)

        observed.__name__ = "_sequence_impl"
        controller._sequence_impl = observed
        pool = ThreadPoolExecutor(max_workers=2)
        self.addCleanup(pool.shutdown, wait=True)
        future = pool.submit(controller.sequence, steps)
        self.assertTrue(started.wait(1), "sequence did not start")
        return future

    def arm(self, controller):
        controller.connect()
        result = controller.set_play_mode("floor", True)
        self.assertEqual(result["play_mode"], "floor")

    def pool(self):
        pool = ThreadPoolExecutor(max_workers=4)
        self.addCleanup(pool.shutdown, wait=True)
        return pool

    def block_worker(self, controller):
        entered, release = threading.Event(), threading.Event()

        def block():
            entered.set()
            release.wait(3)

        controller._hw.submit(block)
        self.assertTrue(entered.wait(1))
        self.addCleanup(release.set)
        return release

    def observe_admission(self, controller):
        admitted = threading.Event()
        submit = controller._hw.submit

        def observed(*args, **kwargs):
            future = submit(*args, **kwargs)
            admitted.set()
            return future

        controller._hw.submit = observed
        return admitted


class ProximityAndStatusTests(BridgeTestCase):
    def test_truthy_sdk_sample_uses_value(self):
        controller = self.controller()
        controller.connect()

        async def clear():
            return SimpleNamespace(value=0.0)

        async def blocked():
            return SimpleNamespace(value=1.0)

        controller.evo.data.obstacle_left_front.read = clear
        controller.evo.data.obstacle_right_front.read = blocked
        result = controller.proximity()
        self.assertEqual(result, {
            "ok": True, "available": True,
            "front": {"left": False, "right": True},
        })

    def test_health_reads_native_client_without_io(self):
        controller = self.controller()
        controller.connect()
        # Actual installed SDK path: Evo -> driver -> control -> channel -> BleakClient.
        client = SimpleNamespace(is_connected=False)
        controller.evo._driver = SimpleNamespace(
            _control=SimpleNamespace(_channel=SimpleNamespace(_client=client)))
        with patch.object(controller._ble, "call", side_effect=AssertionError("health did BLE I/O")), \
                patch.object(controller._hw, "submit", side_effect=AssertionError("health queued work")):
            self.assertFalse(controller.status()["connected"])
        # A stale client becoming true again must not silently resurrect the session.
        client.is_connected = True
        self.assertFalse(controller.status()["connected"])

    def test_protocol_and_default_play_mode(self):
        status = self.controller(simulate=True).status()
        self.assertEqual(status.get("protocol_version"), 4)
        self.assertEqual(status.get("play_mode"), "desk")

    def test_installed_sdk_sample_and_evo_shape(self):
        try:
            from ozobot.linefollower.datatypes import Sample
            from ozobot.evo import Evo
        except (ImportError, SyntaxError):
            self.skipTest("optional SDK unavailable; shape-compatible fakes still tested")
        sample = Sample(0.0, 123)
        self.assertTrue(bool(sample), "regression relies on real SDK Sample truthiness")
        controller = self.controller()
        controller.connect()
        evo = Evo(controller.evo._driver)
        # Constructing Evo around a fake driver performs no Bluetooth I/O.
        self.assertTrue(controller._client_connected(evo))

        async def clear():
            return sample

        controller.evo.data.obstacle_left_front.read = clear
        controller.evo.data.obstacle_right_front.read = clear
        self.assertEqual(controller.proximity()["front"], {"left": False, "right": False})

    def test_link_loss_disarms_and_discards_cached_proximity(self):
        controller = self.controller()
        self.arm(controller)
        self.assertTrue(controller.proximity()["available"])
        controller.evo._client.is_connected = False
        controller._sequence_active = True
        status = controller.status()
        self.assertFalse(status["connected"])
        self.assertEqual(status["play_mode"], "desk")
        self.assertEqual(controller.proximity(), {"ok": True, "available": False})

    def test_unknown_sdk_shape_fails_closed(self):
        controller = self.controller()
        self.arm(controller)
        controller.evo._driver = object()
        self.assertFalse(controller.status()["connected"])
        self.assertEqual(controller.status()["play_mode"], "desk")

    def test_sensor_failure_returns_unavailable(self):
        controller = self.controller()
        controller.connect()

        async def failed():
            raise ValueError("invalid sample")

        controller.evo.data.obstacle_left_front.read = failed
        self.assertEqual(controller.proximity(), {"ok": True, "available": False})
        self.assertTrue(controller.status()["connected"])

    def test_sensor_link_loss_disarms_without_reconnect(self):
        controller = self.controller()
        self.arm(controller)

        async def failed():
            raise bridge._FakeBleakError("Service Discovery has not been performed yet")

        controller.evo.data.obstacle_left_front.read = failed
        with patch.object(controller, "_async_connect", side_effect=AssertionError("reconnect")):
            self.assertEqual(controller.proximity(), {"ok": True, "available": False})
        self.assertFalse(controller.status()["connected"])
        self.assertEqual(controller.status()["play_mode"], "desk")


class PlayModeTests(BridgeTestCase):
    def test_desk_rejects_all_motor_actions_before_hardware(self):
        for simulate in (False, True):
            controller = self.controller(simulate=simulate)
            controller.connect()
            for action in ("move", "turn", "dance"):
                with self.subTest(simulate=simulate, action=action):
                    with self.assertRaisesRegex(RuntimeError, "floor"):
                        controller.action({"action": action})
            with self.assertRaisesRegex(RuntimeError, "floor"):
                controller.sequence([{"led": "red"}, {"move": {}}])
            if not simulate:
                self.assertEqual(controller.evo._ops, 0)

    def test_floor_requires_literal_confirmation_and_live_connection(self):
        controller = self.controller()
        with self.assertRaisesRegex(RuntimeError, "connected"):
            controller.set_play_mode("floor", True)
        controller.connect()
        for confirmation in (False, None, 1, "true", [], {}):
            with self.subTest(confirmation=confirmation):
                with self.assertRaises(ValueError):
                    controller.set_play_mode("floor", confirmation)
        for mode in (None, "FLOOR", "", {}, 1):
            with self.assertRaises(ValueError):
                controller.set_play_mode(mode, True)
        self.assertEqual(controller.status()["play_mode"], "desk")

    def test_floor_keeps_existing_motor_limits(self):
        controller = self.controller()
        self.arm(controller)
        self.assertEqual(controller.action({"action": "move", "distance": 999, "speed": -999}),
                         {"ok": True, "action": "move", "distance": 120, "speed": 80})
        self.assertEqual(controller.action({"action": "turn", "angle": -999, "speed": 0}),
                         {"ok": True, "action": "turn", "angle": -180, "speed": 30})
        self.assertTrue(controller.action({"action": "dance"})["ok"])

    def test_cosmetics_work_in_desk(self):
        controller = self.controller(simulate=True)
        controller.connect()
        for action in ("led", "tone", "hello", "read_color"):
            self.assertTrue(controller.action({"action": action})["ok"])
        self.assertFalse(controller.sequence([{"led": "red", "wait": 0}])["truncated"])

    def test_stop_desk_and_disconnect_each_disarm(self):
        controller = self.controller()
        for reset in (controller.stop, lambda: controller.set_play_mode("desk"), controller.disconnect):
            self.arm(controller)
            reset()
            self.assertEqual(controller.status()["play_mode"], "desk")
            with self.assertRaises(RuntimeError):
                controller.action({"action": "move"})
        controller.connect()
        self.assertEqual(controller.status()["play_mode"], "desk")

    def test_link_error_never_replays_any_motor_action(self):
        for action in ("move", "turn", "dance"):
            with self.subTest(action=action):
                controller = self.controller()
                self.arm(controller)
                evo = controller.evo
                evo._drop_at = 1
                with patch.object(controller, "_async_connect", side_effect=AssertionError("automatic reconnect")):
                    with self.assertRaises(bridge._FakeBleakError):
                        controller.action({"action": action})
                self.assertEqual(evo._ops, 1)
                self.assertFalse(controller.status()["connected"])
                self.assertEqual(controller.status()["play_mode"], "desk")
                controller.connect()  # explicit, fake reconnect has no motor side effect
                self.assertEqual(controller.evo._ops, 0)
                self.assertEqual(controller.status()["play_mode"], "desk")


class SequenceCancellationTests(BridgeTestCase):
    def test_link_failure_after_motion_never_replays_sequence(self):
        controller = self.controller()
        self.arm(controller)
        evo = controller.evo
        evo._drop_at = 2
        with patch.object(controller, "_async_connect", side_effect=AssertionError("automatic reconnect")):
            with self.assertRaises(bridge._FakeBleakError):
                controller.sequence([{"move": {"distance": 1}}, {"turn": {}}, {"move": {}}])
        self.assertEqual(evo._ops, 2)
        self.assertEqual(controller.status()["play_mode"], "desk")
        controller.connect()
        self.assertEqual(controller.evo._ops, 0)

    def test_sdk_timeout_cancels_and_worker_remains_usable(self):
        controller = self.controller()
        self.arm(controller)
        controller.DEFAULT_TIMEOUT = 1.2
        controller.INNER_MARGIN = 0.2
        cancelled = threading.Event()
        calls = []

        async def hung_move(*args):
            calls.append(args)
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        controller.evo.move = hung_move
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            controller.action({"action": "move", "distance": 1})
        self.assertTrue(cancelled.wait(0.5))
        self.assertEqual(calls, [(1, 50)])
        self.assertEqual(controller.status()["play_mode"], "desk")
        self.assertTrue(controller.action({"action": "led"})["ok"])

    def test_health_link_loss_cancels_active_wait_without_io(self):
        controller = self.controller()
        self.arm(controller)
        result = self.started_sequence(controller, [{"wait": 1.5}, {"move": {}}])
        controller.evo._client.is_connected = False
        with patch.object(controller._ble, "call", side_effect=AssertionError("health did I/O")):
            self.assertFalse(controller.status()["connected"])
        self.assertTrue(result.result(0.5)["truncated"])
        self.assertEqual(controller.evo._ops, 0)

    def test_desk_transition_interrupts_routine(self):
        controller = self.controller()
        self.arm(controller)
        result = self.started_sequence(controller, [{"wait": 1.5}, {"turn": {}}])
        self.assertEqual(controller.set_play_mode("desk")["play_mode"], "desk")
        self.assertTrue(result.result(0.5)["truncated"])
        self.assertEqual(controller.evo._ops, 0)

    def test_stop_interrupts_dance_before_next_turn(self):
        controller = self.controller()
        self.arm(controller)
        turning = threading.Event()
        turns = []

        async def turn(*args):
            turns.append(args)
            turning.set()
            await asyncio.Event().wait()

        controller.evo.rotate = turn
        result = self.pool().submit(controller.action, {"action": "dance"})
        self.assertTrue(turning.wait(1))
        controller.stop()
        with self.assertRaisesRegex(RuntimeError, "stopped"):
            result.result(0.5)
        self.assertEqual(turns, [(45, 90)])

    def test_stop_interrupts_wait_promptly(self):
        controller = self.controller(simulate=True)
        controller.connect()
        future = self.started_sequence(controller, [{"wait": 1.5}, {"led": "red"}])
        # Establish that the routine is inside its wait, rather than racing admission.
        time.sleep(0.05)
        started = time.monotonic()
        self.assertEqual(controller.stop(), {"ok": True, "action": "stop"})
        result = future.result(2)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(result["truncated"])
        self.assertNotIn("led", [a["action"] for r in result["results"] for a in r["actions"]])

    def test_clipped_final_wait_is_truncated(self):
        controller = self.controller(simulate=True)
        started = time.monotonic()
        result = controller.sequence([{"wait": 1.5}] * 6)
        self.assertLess(time.monotonic() - started, 8.4)
        self.assertTrue(result["truncated"])
        seconds = sum(r["actions"][0]["seconds"] for r in result["results"])
        self.assertLessEqual(seconds, 8)
        self.assertEqual(result["steps_received"], 6)

    def test_queued_routine_cannot_reset_stop_even_after_rearming(self):
        controller = self.controller()
        self.arm(controller)
        pool = self.pool()
        release = self.block_worker(controller)
        admitted = self.observe_admission(controller)
        result = pool.submit(controller.sequence, [{"move": {}}])
        self.assertTrue(admitted.wait(1))
        controller.stop()
        controller.set_play_mode("floor", True)
        release.set()
        self.assertTrue(result.result(1)["truncated"])
        self.assertEqual(controller.evo._ops, 0)

    def test_queued_action_cannot_reset_stop_even_after_rearming(self):
        controller = self.controller()
        self.arm(controller)
        pool = self.pool()
        release = self.block_worker(controller)
        admitted = self.observe_admission(controller)
        result = pool.submit(controller.action, {"action": "move"})
        self.assertTrue(admitted.wait(1))
        controller.stop()
        controller.set_play_mode("floor", True)
        release.set()
        with self.assertRaisesRegex(RuntimeError, "stopped"):
            result.result(1)
        self.assertEqual(controller.evo._ops, 0)

    def test_stop_cancels_inflight_sdk_call_and_halts_without_queueing(self):
        controller = self.controller()
        self.arm(controller)
        moving, cancelled, halted = threading.Event(), threading.Event(), threading.Event()

        async def hanging_move(*args):
            moving.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async def halt(*args):
            self.assertEqual(args, (0, 0, 0))
            halted.set()

        controller.evo.move = hanging_move
        controller.evo.set_velocity = halt
        result = self.pool().submit(controller.sequence, [{"move": {}, "turn": {}}])
        self.assertTrue(moving.wait(1))
        started = time.monotonic()
        controller.stop()
        self.assertTrue(result.result(0.5)["truncated"])
        self.assertTrue(cancelled.wait(0.5))
        self.assertTrue(halted.wait(0.5))
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(controller.evo._ops, 0, "turn executed after STOP")

    def test_stop_between_primitives_of_one_step(self):
        controller = self.controller()
        self.arm(controller)

        async def stopping_led(*args):
            controller.stop()

        controller.evo.set_led = stopping_led
        result = controller.sequence([{"led": "red", "move": {}, "turn": {}}])
        self.assertTrue(result["truncated"])
        self.assertEqual(controller.evo._ops, 0)

    def test_duplicate_routine_rejected_while_first_is_queued(self):
        controller = self.controller(simulate=True)
        self.arm(controller)
        pool = self.pool()
        release = self.block_worker(controller)
        admitted = self.observe_admission(controller)
        result = pool.submit(controller.sequence, [{"wait": 0}])
        self.assertTrue(admitted.wait(1))
        for duplicate in (lambda: controller.sequence([]), lambda: controller.action({"action": "dance"})):
            with self.assertRaisesRegex(RuntimeError, "already running"):
                duplicate()
        release.set()
        self.assertFalse(result.result(1)["truncated"])

    def test_budget_cancels_hung_primitive_and_skips_following_motor(self):
        controller = self.controller()
        self.arm(controller)
        controller.SEQUENCE_BUDGET = 0.1
        cancelled = threading.Event()

        async def hanging_led(*args):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        controller.evo.set_led = hanging_led
        started = time.monotonic()
        result = controller.sequence([{"led": "red", "move": {}}])
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(result["truncated"])
        self.assertTrue(cancelled.wait(0.5))
        self.assertEqual(controller.evo._ops, 0)

    def test_delayed_ble_dispatch_cannot_start_motor_after_deadline(self):
        controller = self.controller()
        self.arm(controller)
        controller.SEQUENCE_BUDGET = 0.05
        call = controller._ble.call

        def delayed(*args, **kwargs):
            # Model the worker being descheduled after calculating its timeout
            # but before the BLE loop can begin the operation.
            time.sleep(0.1)
            return call(*args, **kwargs)

        with patch.object(controller._ble, "call", side_effect=delayed):
            result = controller.sequence([{"move": {}}])
        self.assertTrue(result["truncated"])
        self.assertEqual(controller.evo._ops, 0, "motor started after absolute deadline")

    def test_step_cap_and_validation_execute_nothing_invalid(self):
        controller = self.controller()
        self.arm(controller)
        result = controller.sequence([{"wait": 0}] * 17)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["steps_executed"], 16)
        self.assertEqual(result["steps_received"], 17)
        self.assertFalse(controller.sequence([])["truncated"])
        for invalid in (None, {}, [{}], [1], [{"unknown": 1}], [{"move": 1}],
                        [{"move": {"distance": True}}], [{"turn": {"angle": float("inf")}}],
                        [{"wait": float("nan")}], [{"tone": {"surprise": 1}}]):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    controller.sequence(invalid if not isinstance(invalid, list) else [{"led": "red"}] + invalid)
        self.assertEqual(controller.evo._ops, 0)

    def test_active_routine_proximity_does_not_enqueue(self):
        controller = self.controller()
        self.arm(controller)
        cached = controller.proximity()
        result = self.started_sequence(controller, [{"wait": 1.5}])
        with patch.object(controller._hw, "submit", side_effect=AssertionError("proximity queued")):
            self.assertEqual(controller.proximity(), cached)
        controller.stop()
        self.assertTrue(result.result(1)["truncated"])


class HTTPTests(BridgeTestCase):
    def server(self, simulate):
        controller = self.controller(simulate=simulate)
        server = bridge.BridgeServer(("127.0.0.1", 0), controller, "test-key")
        self.assertNotEqual(server.server_port, 8787)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()

        def close():
            server.shutdown()
            thread.join(1)
            server.server_close()

        self.addCleanup(close)
        return server

    @staticmethod
    def request(server, method, path, payload=None, key="test-key", raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        try:
            body = raw if raw is not None else json.dumps(payload or {})
            connection.request(method, path, body, {"X-OzoPet-Key": key, "Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_simulator_and_fake_ble_http_contract(self):
        for simulate in (True, False):
            with self.subTest(simulate=simulate):
                server = self.server(simulate)
                code, health = self.request(server, "GET", "/health")
                self.assertEqual(code, 200)
                self.assertEqual(health["protocol_version"], 4)
                self.assertEqual(health["play_mode"], "desk")
                self.assertFalse(health["connected"])
                self.assertEqual(self.request(server, "POST", "/connect")[0], 200)
                self.assertEqual(self.request(server, "POST", "/action", {"action": "move"})[0], 400)
                self.assertEqual(self.request(server, "POST", "/play-mode", {"mode": "floor"})[0], 400)
                self.assertEqual(self.request(server, "POST", "/play-mode", {"mode": "floor", "floor_confirmed": True})[0], 200)
                self.assertEqual(self.request(server, "POST", "/action", {"action": "turn", "angle": 1})[0], 200)
                code, sequence = self.request(server, "POST", "/sequence", {"steps": [{"wait": 0}]})
                self.assertEqual(code, 200)
                self.assertEqual(sequence["steps_executed"], 1)
                self.assertEqual(self.request(server, "GET", "/proximity")[1]["available"], not simulate)
                self.assertEqual(self.request(server, "POST", "/stop"), (200, {"ok": True, "action": "stop"}))
                self.assertEqual(self.request(server, "GET", "/health")[1]["play_mode"], "desk")
                self.assertFalse(self.request(server, "POST", "/disconnect")[1]["connected"])
                self.assertEqual(self.request(server, "POST", "/play-mode", {"mode": "desk"})[0], 200)

    def test_auth_and_json_validation(self):
        server = self.server(True)
        for method, path in (("GET", "/health"), ("GET", "/proximity"), ("POST", "/play-mode"),
                             ("POST", "/connect"), ("POST", "/action"), ("POST", "/sequence"), ("POST", "/stop")):
            self.assertEqual(self.request(server, method, path, key="wrong")[0], 401)
        for raw in ('{"steps":[{"wait":NaN}]}', '{"steps":[{"wait":Infinity}]}', '[]', 'not json', ' ' * 8193):
            self.assertEqual(self.request(server, "POST", "/sequence", raw=raw)[0], 400)
        self.assertEqual(self.request(server, "POST", "/missing")[0], 404)

    def test_http_stop_is_responsive_during_sequence(self):
        server = self.server(True)
        self.request(server, "POST", "/connect")
        admitted = self.observe_admission(server.controller)
        result = self.pool().submit(self.request, server, "POST", "/sequence", {"steps": [{"wait": 1.5}]})
        self.assertTrue(admitted.wait(1))
        started = time.monotonic()
        self.assertEqual(self.request(server, "POST", "/stop")[0], 200)
        code, body = result.result(1)
        self.assertEqual(code, 200)
        self.assertTrue(body["truncated"])
        self.assertLess(time.monotonic() - started, 0.5)


if __name__ == "__main__":
    unittest.main()
