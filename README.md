# OzoPet

OzoPet is a persistent digital pet built around the physical personality of an Ozobot Evo. The hosted app is deliberately useful without hardware, then upgrades into a real-robot experiment when a local Evo bridge is connected.

## What Ozi can now do

Ozi runs on a real behavior engine — it is not a row of decorative buttons.

- **12 internal drives** (energy, hunger, affection, social, curiosity, boredom, confidence, trust, mischief, sleepiness, playfulness, stress) that drift in real time and shape everything Ozi does
- **Initiates interaction**: asks for attention, play, snacks, dances, exploration or sing-alongs via request cards with PLAY / LATER choices — with cooldowns so it never nags
- **Self-directed life**: wanders zones, hums original melodies, does micro-dances, scans suspiciously, drifts to the nest when tired, throws zoomies
- **9 named dance routines** built from choreography primitives (The Wiggle, Happy Spin, Robot Salsa, Moonwalk, Dramatic Entrance, Shy Dance, Victory Lap, Zoomies — plus one SECRET routine that unlocks after five dances)
- **10 original songs** (greeting, lullaby, victory arpeggio, feeding anthem, mischief noises, wandering hum…) performed with synchronized LED patterns; unheard tracks appear as `???` in the Songbook until Ozi performs them
- **Body language**: 13 physical expressions (curious, excited, nervous, angry, sad, happy, sleepy, suspicious, refusal, startle…) that work in simulation and on the real robot
- **7 arcade missions**: Simon Says, Red Light Wiggle, Dance Party, Color Hunt (reads real surface colors), Mystery Box, Guard Duty (uses real IR proximity), Hide & Seek
- **Meaningful sleep**: bedtime journey to the nest, soft-blue lullaby, dreams composed from the day's actual memories, mentioned at wake-up
- **Memory that matters**: preferences learned per activity/zone/game/dance/song, habits (morning greetings, evening sleepy nudges, dance-after-snack), discoveries instead of trophies (First Song, Trusted Human, Night Owl, Purple Obsession…)
- **Personality evolution**: DNA traits drift slowly from how you actually treat Ozi, changing planner weights — two OzoPets behave differently over time

## Desk mode vs Floor Adventure mode

**DESK MODE (default).** The browser stays the brain and every wheel stays locked. Autonomous behavior is limited to LEDs, tones, tiny stationary turns (≤20°) and sensor reactions. Translation commands are stripped client-side *and* clamped server-side. Living Mode can never drive the robot off your desk.

**FLOOR ADVENTURE MODE (explicit only).** Inside Hardware Lab: switch to FLOOR, tick *"The robot is on a clear floor area."*, and supervised autonomy arms — short clamped moves (≤50 mm/step, 45°/step, 7 s budget), Follow Me / Come Here / Follow My Hand using an honest webcam color-card tracker (the Evo has no camera of its own), with IR proximity obstacle guards. A huge red STOP button is always visible while a body is attached; e-stop fires automatically on bridge loss, camera loss or tab-hidden, cutting motion and disconnecting.

## What is already in this first build

- Persistent pet state in browser localStorage
- Personality DNA that changes behavior
- Autonomous "living mode"
- Interactive desk habitat and color-coded physical-zone concept
- Memories, trust, boredom, curiosity, mischief and relationship state
- Dream generator that remixes recent experiences
- Synthesized Ozo-style chirps with Web Audio
- Hardware Lab with safety-clamped movement, turn, LED, tone and surface-color actions
- A localhost-only Python bridge with a random session key
- Full simulation fallback when the experimental Evo runtime is unavailable

## Run the web app locally

The site is static. Any simple local server works:

```powershell
py -m http.server 3000
```

Then open `http://localhost:3000`.

## Try the bridge without the robot

Python 3.13+:

```powershell
cd bridge
py ozopet_bridge.py --sim
```

The bridge prints a one-time key. Open **Hardware Lab** in OzoPet, paste that key, and connect. This verifies the Vercel/browser-to-local-bridge path without moving real hardware.

## Try the real Ozobot Evo

The current `ozobot-evo` package requires Python 3.13+. On PyPI it only
supports the Ozobot Editor web runtime ("Evo native driver is not yet
implemented"), so `install.sh` installs the official packages from a pinned
commit of [ozobot/python-libraries](https://github.com/ozobot/python-libraries),
where native BLE via bleak is implemented.

macOS / Linux:

```bash
cd bridge
./install.sh          # creates .venv, installs pinned SDK + dependencies
.venv/bin/python ozopet_bridge.py
```

Windows (PowerShell) — same script logic manually:

```powershell
cd bridge
py -3.13 -m venv .venv
.venv\Scripts\activate
python -m pip install loguru "bleak~=2.0.0" "pydantic>=2.11.5" "ozobot-web>=0.3.0,<0.4.0"
python -m pip install --no-deps `
  "git+https://github.com/ozobot/python-libraries@caead3f59c862e329cbb0a96abc0ce2c0e21999b#subdirectory=ozobot-common" `
  "git+https://github.com/ozobot/python-libraries@caead3f59c862e329cbb0a96abc0ce2c0e21999b#subdirectory=ozobot-ble" `
  "git+https://github.com/ozobot/python-libraries@caead3f59c862e329cbb0a96abc0ce2c0e21999b#subdirectory=ozobot-linefollower" `
  "git+https://github.com/ozobot/python-libraries@caead3f59c862e329cbb0a96abc0ce2c0e21999b#subdirectory=ozobot-evo"
python ozopet_bridge.py
```

On macOS the first BLE scan makes the system ask permission for Python to
use Bluetooth — approve it once. Chrome may also ask for Local Network
Access the first time the hosted app talks to the loopback bridge.

The default BLE name filter is `OzoEvo-*`. Override it if necessary:

```powershell
py ozopet_bridge.py --name "OzoEvo-ABC*"
```

### Important hardware status

The bridge drives the Evo over native Bluetooth LE using Ozobot's official
`ozobot` Python packages (bleak/CoreBluetooth transport). Verified working
end-to-end on macOS (Apple Silicon, Python 3.13): LED, tone, surface-color
read, small turns and short moves.

The bridge is intentionally conservative:

- binds only to `127.0.0.1`
- requires a random bridge key
- does not accept arbitrary code
- clamps movement to +/-120 mm
- clamps turns to +/-180 degrees
- clamps speed and tone ranges
- keeps physical commands short

## Architecture

```text
Vercel static UI
    |
    | localhost HTTP + one-time key
    v
OzoPet local bridge
    |
    | Ozobot Python API
    v
Ozobot Evo

<!-- last updated: 2026-08-21 -->
```

The product direction is larger than a controller. The Evo becomes a persistent desk creature with memories, learned preferences, autonomous behavior, physical color zones, a relationship model and eventually an AI behavior planner behind a deterministic safety controller.

## Sources used for the hardware adapter

- Ozobot Python SDK, Ari & Evo documentation: https://docs.ozobot.com/python/linefollower/index.html
- Ozobot synchronous API reference: https://docs.ozobot.com/python/linefollower/sync/apidoc.html
- `ozobot-evo` package: https://pypi.org/project/ozobot-evo/

