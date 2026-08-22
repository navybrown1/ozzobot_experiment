# OzoPet Bridge — Sequence API (OzoPetBridge/0.3)

Additions to the local hardware bridge (`ozopet_bridge.py`). All pre-existing
endpoints (`/health`, `/connect`, `/disconnect`, `/action`), auth, CORS and
clamping behavior are unchanged. Base URL is always `http://127.0.0.1:8787`
in production; the examples below use a test port.

## Auth

Every endpoint requires the bridge key header:

```
X-OzoPet-Key: <key printed at bridge startup>
```

Missing/wrong key → `401 {"ok": false, "error": "invalid bridge key"}`.
The server is multi-threaded (ThreadingHTTPServer), so `POST /stop` can be
served while a `POST /sequence` is still running.

## Step shapes

A sequence is a list of step objects. Each step sets **one or more** of these
keys; execution order within a step is fixed: `led` → `tone` → `move` →
`turn` → `wait`.

```jsonc
{
  "led":   "mint",                                   // palette name
  "tone":  { "frequency": 880, "duration": 0.1 },    // Hz, seconds
  "move":  { "distance": 40,  "speed": 50 },         // mm, mm/s
  "turn":  { "angle": 45,     "speed": 90 },         // degrees, deg/s
  "wait":  0.5                                       // seconds
}
```

## Clamp table (server-side, single source: `move`/`turn`/`led`/`tone` methods)

| Parameter        | Range            | Out-of-range behavior            |
|------------------|------------------|----------------------------------|
| `steps` count    | 0..16            | >16 → 400                        |
| `led` color name | PALETTE names: `mint`, `violet`, `amber`, `red`, `blue`, `off` | unknown name silently becomes `mint` |
| `tone.frequency` | 180..1600        | clamped                          |
| `tone.duration`  | 0.03..0.35 s     | clamped                          |
| `move.distance`  | -120..120 mm     | clamped                          |
| `move.speed`     | 20..80 (abs)     | clamped                          |
| `turn.angle`     | -180..180 deg    | clamped                          |
| `turn.speed`     | 30..120 (abs)    | clamped                          |
| `wait`           | 0..1.5 s         | clamped                          |
| wall-clock total | ≤ 8.0 s          | excess steps are not run; `truncated: true` |

Validation (→ `400 {"ok": false, "error": ...}`, nothing executes):

- `steps` missing / not a list / longer than 16
- a step that is not an object, or an **empty** object
- any **unknown key** on a step (only `led`, `tone`, `move`, `turn`, `wait` allowed)
- `move`/`turn`/`tone` values that are not objects
- any non-numeric or **non-finite** parameter (`NaN`, `Infinity` are rejected
  by the JSON parser itself and by `require_finite`)

Numeric out-of-range values are **clamped, not rejected** (same policy as
`/action`).

## POST /sequence

```bash
curl -s -X POST http://127.0.0.1:8787/sequence \
  -H "X-OzoPet-Key: $OZOPET_BRIDGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"steps":[{"led":"violet"},{"tone":{"frequency":880,"duration":0.1}},{"wait":0.2},{"turn":{"angle":45,"speed":90}}]}'
```

Response:

```json
{
  "ok": true,
  "action": "sequence",
  "results": [
    { "index": 0, "ok": true, "actions": [ { "ok": true, "action": "led", "color": "violet" } ] },
    { "index": 1, "ok": true, "actions": [ { "ok": true, "action": "tone", "frequency": 880.0, "duration": 0.1 } ] },
    { "index": 2, "ok": true, "actions": [ { "ok": true, "action": "wait", "seconds": 0.2 } ] },
    { "index": 3, "ok": true, "actions": [ { "ok": true, "action": "turn", "angle": 45.0, "speed": 90.0 } ] }
  ],
  "truncated": false,
  "steps_executed": 4
}
```

- `results[i].actions` holds one entry per primitive executed for that step,
  in execution order (a multi-key step yields multiple entries).
- `steps_executed` = number of step objects actually executed.
- A `wait` may be shortened near the 8 s budget; the effective seconds slept
  is reported.

## Abort semantics

Two conditions stop a sequence early, both reported as `truncated: true`
(already-executed steps keep their results):

1. **Wall-clock cap**: 8.0 s monotonic budget. Checked before every step; a
   `wait` is additionally clipped to the remaining budget, so total wall time
   never exceeds ~8 s.
2. **`POST /stop`**: sets an internal abort flag and is checked **between
   every step**. In-flight primitives finish; the next step never starts.

The abort flag resets to `false` at the start of every `POST /sequence` and
every `POST /action`, so a stopped sequence can simply be re-run.

```bash
curl -s -X POST http://127.0.0.1:8787/stop -H "X-OzoPet-Key: $OZOPET_BRIDGE_KEY"
# → {"ok": true, "action": "stop"}
```

`/stop` also best-effort calls `robot.set_velocity(0, 0, 0)` on hardware
(failures swallowed); in simulator mode it is a no-op. `/stop` always
answers `200`.

## GET /proximity

Same auth as `/health`. Hardware + connected only:

```bash
curl -s http://127.0.0.1:8787/proximity -H "X-OzoPet-Key: $OZOPET_BRIDGE_KEY"
```

```json
{ "ok": true, "available": true, "front": { "left": false, "right": true } }
```

`front.left` / `front.right` = obstacle detected. In simulator mode, when not
connected, or if either sensor read fails, it degrades to
`{"ok": true, "available": false}`. This endpoint never raises.

## Error model (unchanged)

`400` for validation/connection errors (`ValueError`/`RuntimeError`),
`401` bad key, `404` unknown path, `500` unexpected failures. Bodies are
`{"ok": false, "error": "..."}`. Bodies larger than 8192 bytes are rejected.
