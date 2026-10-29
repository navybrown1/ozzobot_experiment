# OzoPet Bridge API — protocol 4 (OzoPetBridge/0.4)

The local bridge retains `/health`, `/connect`, `/disconnect`, `/action`,
`/sequence`, `/stop`, and `/proximity`, their existing fields, auth, CORS, and
numeric clamps. Protocol 4 adds `/play-mode` and two status fields.
**Motor commands require explicit floor arming**, including in simulator mode.
Existing clients must adopt this contract before sending motion.

Production remains `http://127.0.0.1:8787`. Tests use temporary loopback ports,
never the installed bridge. Examples below use test port `8789`.

## Authentication and errors

Every API endpoint requires `X-OzoPet-Key: <bridge key>`. Missing/wrong key:
`401 {"ok":false,"error":"invalid bridge key"}`. OPTIONS remains unauthenticated.

- `400`: invalid input, disconnected robot, unarmed motion, duplicate routine,
  cancelled action, or operation timeout.
- `404`: unknown endpoint.
- `500`: unexpected SDK/hardware failure, including mid-command BLE errors.
- Error bodies remain `{"ok":false,"error":"..."}`.
- Bodies must be JSON objects, at most 8192 bytes. NaN/Infinity, booleans used
  as numbers, and other non-finite/non-numeric parameters are rejected.

`/proximity` degrades to `available:false` on failures. A valid authenticated
STOP returns `200 {"ok":true,"action":"stop"}`. This acknowledges the request,
not confirmed physical stopping; malformed bodies/bad keys retain their errors.

## Status and connection lifecycle

`GET /health`, `POST /connect`, `POST /disconnect`, and `POST /play-mode`
return status with additive `protocol_version` and `play_mode` fields:

```json
{
  "ok": true,
  "protocol_version": 4,
  "mode": "hardware",
  "connected": true,
  "play_mode": "desk",
  "robot": "OzoEvo-*",
  "sdk_available": true,
  "sdk_error": null,
  "surface": "unclassified"
}
```

`mode` remains `hardware` or `simulator`; `play_mode` is `desk` or `floor`,
always initially `desk`.

Hardware health checks the installed native SDK's underlying Bleak client at
`evo._driver._control._channel._client.is_connected`. Bleak's CoreBluetooth
property reads local peripheral state without scanning or GATT I/O. Health
never queues hardware work, connects, probes LEDs, or sends motion.
An unknown/unavailable driver shape fails closed as disconnected.

A detected dead link marks the session disconnected, clears floor arming,
cancels old work, and discards cached proximity. A client property becoming
true again cannot resurrect the session. Explicit `/connect` and fresh floor
confirmation are required. The explicit-connect handshake can retry, but
**no failed action or sequence is automatically reconnected or replayed**.
A command may already have reached the robot when its acknowledgement fails.

## POST /play-mode

After placing the robot on a safe floor, arm motion with:

```json
{"mode":"floor","floor_confirmed":true}
```

The robot must be connected. Confirmation must be the JSON boolean `true`,
not `1` or a string. Missing confirmation or any other mode produces 400.
Return to desk mode with `{"mode":"desk"}`, also allowed while disconnected.

Desk mode cancels work and requests a best-effort halt. STOP, disconnect,
observed link loss, and a routine deadline also clear floor arming. No mode
change starts motion. In desk mode, `move`, `turn`, and `dance` are refused
server-side, including motor primitives inside `/sequence`. A motor sequence
is refused before its LED/tone steps execute. Zero distance/angle does not
bypass arming. Connected `led`, `tone`, `hello`, and `read_color` remain usable.

## POST /action

Existing action shapes and effective-parameter response fields remain:

```json
{"action":"move","distance":40,"speed":50}
{"action":"turn","angle":35,"speed":70}
{"action":"led","color":"mint"}
{"action":"tone","frequency":660,"duration":0.08}
{"action":"hello"}
{"action":"dance"}
{"action":"read_color"}
```

Hardware tone remains acknowledged without sending PlayTone; the browser
provides audio. Simulator tone waits for its clamped duration.

## POST /sequence

Send `{"steps":[...]}`. Each nonempty step object sets one or more keys in
fixed execution order: `led` → `tone` → `move` → `turn` → `wait`.

```json
{
  "steps": [
    {"led":"violet"},
    {"tone":{"frequency":880,"duration":0.1}},
    {"move":{"distance":40,"speed":50},"turn":{"angle":45,"speed":90}},
    {"wait":0.2}
  ]
}
```

All retained steps are validated before any execute. Unknown step/nested keys,
invalid object/string shapes, and invalid numbers produce 400. Missing numeric
fields use `/action` defaults. Empty lists are allowed. Only the first 16 steps
are retained; discarded tail steps do not execute or undergo step validation.

| Parameter | Range / behavior |
|---|---|
| Steps | First 16; larger lists set `truncated:true` |
| LED | `mint`, `violet`, `amber`, `red`, `blue`, `off`, or `#rrggbb`; unknown names use mint |
| Tone frequency | 180–1600 Hz |
| Tone duration | 0.03–0.35 s |
| Move distance | −120–120 mm |
| Move speed | Absolute value clamped to 20–80 mm/s |
| Turn angle | −180–180 degrees |
| Turn speed | Absolute value clamped to 30–120 degrees/s |
| Wait | 0–1.5 s |
| Execution budget | 8.0 s, monotonic deadline from execution start |

Out-of-range numbers are clamped. Motor limits have not been expanded. The
deadline is checked before and after **each primitive**, including within a
multi-key step. Waits and SDK operation timeouts are clipped to remaining time.
At expiry, the bridge cancels the pending SDK operation, clears floor arming,
and requests a halt. Thread/OS scheduling overhead can extend response time;
queue time and asynchronous halt completion are outside the execution budget.
No additional primitive starts after the deadline.

Example partial response:

```json
{
  "ok": true,
  "action": "sequence",
  "results": [
    {"index":0,"ok":true,"actions":[{"ok":true,"action":"led","color":"violet"}]}
  ],
  "truncated": true,
  "steps_executed": 1,
  "steps_received": 4
}
```

- `steps_received` counts the original list, including discarded tail steps.
- `results` retains completed primitives and any partial wait in execution
  order. An interrupted motor primitive is not reported as completed.
- `steps_executed` counts entries in `results`, including a partial step/wait;
  it does not promise every primitive in that step completed.
- `wait.seconds` reports effective time slept, clipped for budget or STOP.
- `truncated` is true for excess steps, STOP/cancellation, or deadline,
  **including a shortened final wait in the final step**.
- BLE failure follows the error model; partial physical movement is possible,
  and no command is replayed to compensate.

## STOP and concurrency

The server is threaded. STOP immediately signals the current generation of
work and clears floor arming. Waits wake immediately; pending BLE waits check
cancellation at intervals up to 25 ms. Velocity zero is scheduled directly on
the owned BLE loop, bypassing the routine queue, with a 0.5 s best-effort
timeout. The HTTP response does not wait for that acknowledgement.

Cancellation is captured at admission. Work queued before STOP stays cancelled
even if floor mode is rearmed before the worker reaches it. No request resets
another request's cancellation. A stopped sequence returns partial results
with `truncated:true`; a cancelled action returns 400. New motor requests need
fresh floor confirmation.

Only one sequence or built-in dance can be admitted, including one waiting
for the worker. A duplicate returns 400. The guard is held until the worker
actually finishes, even if its HTTP caller times out. The bridge retains one
hardware worker on timeout rather than allowing a replacement to race an old
motor dispatcher. It does not automatically restart the service.

```sh
curl -s -X POST http://127.0.0.1:8789/stop \
  -H "X-OzoPet-Key: $OZOPET_BRIDGE_KEY"
```

## GET /proximity

```json
{"ok":true,"available":true,"front":{"left":false,"right":true}}
```

The installed SDK returns `Sample` objects whose `.value` contains the sensor
reading. `Sample(0, timestamp)` itself is truthy. The bridge converts
**`.value`**: zero reports `false`, nonzero reports `true`. The fake SDK mirrors
this Sample behavior.

Simulator, disconnected state, or read failure returns
`{"ok":true,"available":false}`. During an admitted routine, proximity returns
the last sample instead of queuing a competing read. A passive link check
precedes the cache, so a known dead link cannot return stale readings. These IR
sensors provide obstacle indications, not reliable table-edge detection.

## Verification and limits

From the repository root, with the existing environment:

```sh
bridge/.venv/bin/python -B -m unittest discover -s bridge -p 'test_*.py' -v
```

The stdlib suite uses simulator mode and fake BLE, exercising the real HTTP
handler on dynamically allocated loopback ports. It never calls the installed
bridge on 8787 or opens a radio connection. An optional installed-SDK test
checks actual Sample/Evo shape without Bluetooth; it skips if unavailable.
No added dependencies are required.

The existing hooks remain: `OZI_FAKE_BLE=1`, `OZI_FAKE_HANG_AT_OP=k`,
`OZI_FAKE_DROP_AT_OP=k`, and `OZI_TEST_DROP_AT_OP=k`. They verify cancellation
and link-loss handling without automatic recovery or replay.

Tests do not validate physical stopping distance, firmware cancellation, or
radio reliability. A delivered command can move the robot before STOP takes
effect; a disconnected/unresponsive robot may not receive the halt. SDK
cancellation and zero velocity are best effort. The private native SDK
connection path must be reviewed on upgrades; unknown shapes fail closed.
