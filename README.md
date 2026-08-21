# OzoPet

OzoPet is a persistent digital pet built around the physical personality of an Ozobot Evo. The hosted app is deliberately useful without hardware, then upgrades into a real-robot experiment when a local Evo bridge is connected.

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

The current `ozobot-evo` package requires Python 3.13+.

```powershell
cd bridge
py -m venv .venv
.venv\Scripts\activate
py -m pip install -r requirements.txt
py ozopet_bridge.py
```

The default BLE name filter is `OzoEvo-*`. Override it if necessary:

```powershell
py ozopet_bridge.py --name "OzoEvo-ABC*"
```

### Important hardware status

Ozobot's current Python documentation exposes Evo movement, rotation, LEDs, tones and sensor reads, but the `ozobot-evo` 0.3.2 package is still labeled **work in progress** and notes that its available runtime driver is web-oriented. Because of that, OzoPet treats native hardware connection as experimental until it is tested against the specific Evo and Windows environment.

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
```

The product direction is larger than a controller. The Evo becomes a persistent desk creature with memories, learned preferences, autonomous behavior, physical color zones, a relationship model and eventually an AI behavior planner behind a deterministic safety controller.

## Sources used for the hardware adapter

- Ozobot Python SDK, Ari & Evo documentation: https://docs.ozobot.com/python/linefollower/index.html
- Ozobot synchronous API reference: https://docs.ozobot.com/python/linefollower/sync/apidoc.html
- `ozobot-evo` package: https://pypi.org/project/ozobot-evo/

