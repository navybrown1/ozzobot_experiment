# Ozi Play Club

A small, colorful playroom for ages 8–9, with four short games, expressive screen animation, custom move recipes, and optional supervised Ozobot Evo play.

## Play

- **Freeze Dance:** three rounds of dance/freeze cues. Scores measure the child's button reaction, not body movement.
- **Copycat:** remember and repeat five growing color patterns. Wrong answers produce an honest retry, not a disconnected-robot message.
- **Color Quest:** screen matching, or genuine surface-color reads when connected to a physical Evo. Use colored paper beneath its sensor; it does not recognize objects across the room.
- **Treasure Trail:** steer around obstacles on a five-by-five game board. The board is a plan, not localization of the physical robot.
- **Make a move:** tap a button to play the move immediately, or choose **Build a routine** to preview each move and add it to the routine. Up to eight blocks, sixteen commands and seven predicted seconds per routine. With floor play enabled, each preview moves the real Evo.
- **Quick tricks:** six-second choreography with 120 mm steps, wider turns and full spins. Audio is synthesized by the browser, not the robot speaker.

The screen starts in **Screen Play**. That label does not claim a physical robot is connected. Scores, recipes and badges are stored on the current browser/device. Old v1/v2 pet data remains intact, but is not loaded into the new game system.

## Real Evo setup

1. Install the local bridge dependencies once with `bridge/install.sh`.
2. On macOS, run `bridge/install-launch-agent.sh` to install/update its background service. Keep the bridge key private; paste it into **Connect Ozi**.
3. Turn on the Evo and keep it nearby. An explicit connection checks a harmless light command before saying the robot is ready.
4. Place it on a clear, flat floor, away from stairs, with an adult nearby. Check the floor confirmation and select **Enable floor play**.
5. Choose a game or trick. The robot never starts a physical routine just because the page loads.

**Desk / lights-only play never sends wheels or turns.** Protocol 4 is required for floor motion. STOP, disconnect, a detected dead Bluetooth link, and the server's routine deadline lock the wheels again. Floor permission is not saved across page loads. Reconnection never replays a failed movement.

STOP is a best-effort physical halt, not a guaranteed acknowledgement from a disconnected robot. If the robot keeps moving after a lost connection, turn it off. Keep it off tables and away from stairs during floor play. The browser stops the activity when hidden; radio failure can still prevent delivery of the stop command.

Website deployment does **not** update the local bridge. Update the service separately after changes to the Python file. The bridge remains bound to `127.0.0.1:8787`; do not expose it to the internet.

See [bridge/SEQUENCE_API.md](bridge/SEQUENCE_API.md) for authentication, limits, cancellation, protocol and SDK assumptions.

## Develop and verify

```sh
npm ci --ignore-scripts
npm start
npm test
npx playwright install chromium
npm run test:browser
```

If your global npm settings select a workspace, append `--workspaces=false` to npm commands. Browser tests need the local server running. They intercept bridge requests and **never access real Bluetooth hardware**. Screenshots are written to the gitignored `output/playwright/` folder.

`npm test` covers source/DOM checks, deterministic activity tests and Python fake-BLE/HTTP bridge tests. `test:browser` plays the games, verifies replay and STOP, saved recipes, wheel arming, failure without motor replay, and mobile layout. Tests do not prove actual robot motion or radio reliability; those require a supervised physical session.

## Architecture

`index.html` → `playroom/scene.js` (clock, canvas, audio) → `playroom/robot.js` (one explicit transport) → `playroom/activities.js` (cancellable game state) → `app.js` (UI, storage, controls).

Legacy `pet/` and `runtime-guard.js` sources are retained for history but are not loaded. There is no legacy fetch interceptor running alongside the new transport.

GitHub's `main` branch deploys the existing Vercel site. The workflow runs static, game, bridge and browser regression checks. No account credentials or bridge keys belong in the repository.
