/* OziPet behavior engine - AGENT-PERFORM // pet/perform.js
 * Scope: dance deck, body-language expressions, songbook and chirps.
 * Builds SAFE step arrays ({led,tone,move,turn,wait}) from primitives, hands them
 * to OziPet.Safety.execSteps() (transport/clamping is Safety's job, never ours),
 * mirrors audio through WebAudio so simulation users hear it, and emits Bus events
 * (dance/song/anim/led/mood) so the digital creature reacts in parallel.
 * Zero DOM, zero fetch, zero storage, no leaked timers. Melodies are original.
 * Feature-detects OziPet.Bus + OziPet.Safety; if either is missing this module
 * self-disables and OziPet.Perform is simply not attached.
 * Plain ES2020 IIFE. Contract: ozi-contract.md v1 (PERFORM API / SAFETY / EVENT BUS).
 */
(() => {
  'use strict';

  const G = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined') ? window : globalThis;
  const NS = G.OziPet = G.OziPet || {};
  const Bus = NS.Bus || null;
  const Safety = NS.Safety || null;
  if (!Bus || !Safety || typeof Bus.emit !== 'function' || typeof Safety.execSteps !== 'function') return;

  const PALETTE = { mint: '#74ffc8', violet: '#b780ff', amber: '#ffd36c', red: '#ff667c', blue: '#7ddcff', cyan: '#4bd69d' };
  const TONE_MIN = 180, TONE_MAX = 1600, TONE_DMIN = 0.03, TONE_DMAX = 0.35;
  const MOVE_MAX = 120, MOVE_SMIN = 20, MOVE_SMAX = 80;
  const TURN_MAX = 180, TURN_SMIN = 30, TURN_SMAX = 120;
  const WAIT_MAX = 1.5, ROUTINE_CAP = 16, ROUTINE_TIME_MAX = 9;

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const num = (v, f) => { if (typeof v === 'boolean') return f; const n = Number(v); return Number.isFinite(n) ? n : f; };
  const emit = (ev, data) => { try { Bus.emit(ev, data); } catch {} };

  function ledHex(c) {
    if (typeof c !== 'string') return PALETTE.mint;
    const k = c.trim().toLowerCase();
    if (PALETTE[k]) return PALETTE[k];
    return /^#[0-9a-f]{6}$/.test(k) ? k : PALETTE.mint;
  }

  function S(step) {
    const out = {};
    try {
      if (!step || typeof step !== 'object') return null;
      if (step.led) out.led = ledHex(step.led);
      if (step.tone) out.tone = {
        frequency: Math.round(clamp(num(step.tone.frequency, 440), TONE_MIN, TONE_MAX)),
        duration: Math.round(clamp(num(step.tone.duration, 0.1), TONE_DMIN, TONE_DMAX) * 1000) / 1000
      };
      if (step.move) out.move = {
        distance: Math.round(clamp(num(step.move.distance, 0), -MOVE_MAX, MOVE_MAX)),
        speed: Math.round(clamp(num(step.move.speed, 50), MOVE_SMIN, MOVE_SMAX))
      };
      if (step.turn) out.turn = {
        angle: Math.round(clamp(num(step.turn.angle, 0), -TURN_MAX, TURN_MAX)),
        speed: Math.round(clamp(num(step.turn.speed, 60), TURN_SMIN, TURN_SMAX))
      };
      if (step.wait != null) out.wait = Math.round(clamp(num(step.wait, 0), 0, WAIT_MAX) * 1000) / 1000;
    } catch { return null; }
    return Object.keys(out).length ? out : null;
  }

  function routine(steps, cap = ROUTINE_CAP) {
    const out = [];
    let t = 0;
    if (!Array.isArray(steps)) return out;
    for (const s of steps) {
      const clean = S(s);
      if (!clean) continue;
      // Same cost model as wallTime — keep builds inside the planner's pacing.
      const cost = (clean.wait || 0) + (clean.tone ? clean.tone.duration || 0 : 0) + ((clean.move || clean.turn) ? 0.45 : 0);
      if (out.length && t + cost > ROUTINE_TIME_MAX) break;
      out.push(clean);
      t += cost;
      if (out.length >= cap) break;
    }
    return out;
  }

  function wallTime(steps) {
    let t = 0;
    for (const s of (steps || [])) {
      if (!s) continue;
      t += s.wait || 0;
      if (s.tone) t += s.tone.duration || 0;
      if (s.move || s.turn) t += 0.45;
    }
    return t;
  }

  const prims = {
    wiggle() {
      return routine([
        { turn: { angle: 22, speed: 95 } }, { turn: { angle: -22, speed: 95 } },
        { turn: { angle: 16, speed: 95 } }, { turn: { angle: -16, speed: 95 } },
        { turn: { angle: 22, speed: 95 } }, { turn: { angle: -22, speed: 95 } },
        { turn: { angle: 16, speed: 95 } }, { turn: { angle: -16, speed: 95 } }
      ]);
    },
    spin(dir) {
      const d = num(dir, 1) < 0 ? -1 : 1;
      return routine([
        { turn: { angle: 180 * d, speed: 90 } },
        { turn: { angle: 180 * d, speed: 90 } }
      ]);
    },
    shimmy() {
      return routine([
        { turn: { angle: 12, speed: 120 } }, { turn: { angle: -12, speed: 120 } },
        { turn: { angle: 12, speed: 120 } }, { turn: { angle: -12, speed: 120 } },
        { turn: { angle: 12, speed: 120 } }, { turn: { angle: -12, speed: 120 } }
      ]);
    },
    bounce() {
      return routine([
        { move: { distance: 48, speed: 60 } }, { wait: 0.06 },
        { move: { distance: -48, speed: 60 } }, { tone: { frequency: 523, duration: 0.06 } },
        { move: { distance: 48, speed: 60 } }, { wait: 0.06 },
        { move: { distance: -48, speed: 60 } }, { tone: { frequency: 659, duration: 0.08 } }
      ]);
    },
    approach(mm, speed) {
      return routine([{ move: { distance: clamp(Math.abs(num(mm, 40)), 0, MOVE_MAX), speed: clamp(num(speed, 55), MOVE_SMIN, MOVE_SMAX) } }]);
    },
    retreat(mm, speed) {
      return routine([{ move: { distance: -clamp(Math.abs(num(mm, 40)), 0, MOVE_MAX), speed: clamp(num(speed, 55), MOVE_SMIN, MOVE_SMAX) } }]);
    },
    look_left() { return routine([{ turn: { angle: 16, speed: 55 } }]); },
    look_right() { return routine([{ turn: { angle: -16, speed: 55 } }]); },
    pause_dramatically(s) {
      const total = clamp(num(s, 1), 0, 3);
      const out = [];
      let left = total;
      while (left > 0.05 && out.length < ROUTINE_CAP) {
        const w = clamp(left, 0.05, WAIT_MAX);
        out.push({ wait: Math.round(w * 1000) / 1000 });
        left -= w;
      }
      return out;
    }
  };

  const DANCES = [
    {
      id: 'wiggle', title: 'The Wiggle', color: 'cyan', anim: 'wiggle',
      desc: 'Tiny left/right turns under a cyan glow with chirpy blips. Maximum sass, zero displacement.',
      melody: [[740, 0.07], [880, 0.07], [988, 0.07], [880, 0.06], [740, 0.08]],
      build: () => [{ led: 'cyan' }, ...prims.wiggle(), { tone: { frequency: 880, duration: 0.07 } }]
    },
    {
      id: 'happy_spin', title: 'Happy Spin', color: 'amber', anim: 'spin', minPlayfulness: 40,
      desc: 'Spins a full circle, pauses to consider the applause, then spins back the other way. Amber throughout.',
      melody: [[659, 0.09], [784, 0.09], [988, 0.12], [784, 0.09], [659, 0.09], [523, 0.12]],
      build: () => [{ led: 'amber' }, ...prims.spin(1), { wait: 0.35 }, ...prims.spin(-1)]
    },
    {
      id: 'robot_salsa', title: 'Robot Salsa', color: 'violet', anim: 'bop',
      desc: 'Left, right, forward, back - a rhythmic box step with its own built-on melody.',
      melody: [[440, 0.11], [554, 0.11], [659, 0.11], [554, 0.11], [440, 0.11], [330, 0.16]],
      build: () => [
        { led: 'violet' }, { turn: { angle: 28, speed: 75 } }, ...prims.approach(70),
        { turn: { angle: -28, speed: 75 } }, ...prims.retreat(70),
        { turn: { angle: 28, speed: 80 } }, ...prims.approach(70),
        { turn: { angle: -28, speed: 80 } }, ...prims.retreat(70),
        { turn: { angle: 28, speed: 85 } }, ...prims.approach(70),
        { tone: { frequency: 659, duration: 0.09 } }
      ]
    },
    {
      id: 'zoomies', title: 'Zoomies', color: 'mint', anim: 'spin', minPlayfulness: 60,
      desc: 'Short fast bursts out and back with sharp scanning turns between. Pure unfiltered energy.',
      melody: [[988, 0.05], [1175, 0.05], [988, 0.05], [1319, 0.07], [988, 0.05], [1175, 0.05]],
      build: () => [
        { led: 'mint' }, ...prims.approach(55, 80), ...prims.retreat(55, 80),
        { turn: { angle: 30, speed: 110 } }, ...prims.approach(55, 80), ...prims.retreat(55, 80),
        { turn: { angle: -30, speed: 110 } }, ...prims.approach(55, 80), ...prims.retreat(55, 80),
        { turn: { angle: 90, speed: 110 } }, { tone: { frequency: 988, duration: 0.06 } }
      ]
    },
    {
      id: 'moonwalk', title: 'Moonwalk', color: 'blue', anim: 'wiggle',
      desc: 'Slow reverse glide with deliberate pauses and rotating LEDs. Claims zero credit for the name.',
      melody: [[494, 0.16], [440, 0.16], [494, 0.16], [415, 0.2], [440, 0.24]],
      build: () => [
        { led: 'blue' }, { move: { distance: -55, speed: 35 } }, { wait: 0.1 },
        { led: 'violet' }, { move: { distance: -55, speed: 35 } }, { wait: 0.1 },
        { led: 'cyan' }, { move: { distance: -55, speed: 35 } }, { wait: 0.1 },
        ...prims.retreat(45, 35)
      ]
    },
    {
      id: 'dramatic_entrance', title: 'Dramatic Entrance', color: 'violet', anim: 'nervous',
      desc: 'Creeps in on a slow dim turn, holds a long pause... then a sudden chirp and a confident approach.',
      melody: [[220, 0.3], [262, 0.12], [330, 0.12], [1047, 0.1], [1319, 0.16]],
      build: () => [
        { led: 'blue' }, { turn: { angle: 45, speed: 35 } }, { wait: 0.7 },
        { led: 'violet' }, { tone: { frequency: 196, duration: 0.28 } }, { tone: { frequency: 392, duration: 0.08 } },
        { led: 'amber' }, ...prims.approach(70, 70)
      ]
    },
    {
      id: 'shy_dance', title: 'Shy Dance', color: 'blue', anim: 'shiver',
      desc: 'A small step forward, an immediate retreat, then a quiet shimmy under soft lights.',
      melody: [[523, 0.08], [587, 0.08], [523, 0.08], [440, 0.1], [392, 0.14]],
      build: () => [
        { led: 'blue' }, ...prims.approach(22, 35), ...prims.retreat(30, 40),
        ...prims.shimmy(), { led: 'violet' }
      ]
    },
    {
      id: 'victory', title: 'Victory Lap', color: 'amber', anim: 'spin', minPlayfulness: 50,
      desc: 'A rising celebration arpeggio, one proud full spin, and a high finishing note.',
      melody: [[523, 0.1], [659, 0.1], [784, 0.1], [1047, 0.12], [784, 0.08], [1319, 0.18]],
      build: () => [
        { led: 'amber' }, { tone: { frequency: 523, duration: 0.1 } }, { tone: { frequency: 659, duration: 0.1 } },
        { tone: { frequency: 784, duration: 0.1 } }, ...prims.spin(1),
        { led: 'mint' }, { tone: { frequency: 1047, duration: 0.16 } }
      ]
    },
    {
      id: 'secret', title: 'The Forbidden Boogie', color: 'violet', anim: 'shiver', secret: true, minPlayfulness: 75,
      desc: 'Unclassified movement. Odd angles, odder notes, one suspicious retreat. Do not ask what it means.',
      melody: [[233, 0.12], [466, 0.09], [220, 0.12], [494, 0.09], [185, 0.14], [1397, 0.07]],
      build: () => [
        { led: 'violet' }, { turn: { angle: 7, speed: 40 } }, { wait: 0.25 },
        { tone: { frequency: 233, duration: 0.12 } }, { turn: { angle: -13, speed: 60 } },
        { tone: { frequency: 466, duration: 0.1 } }, ...prims.retreat(18, 30),
        { tone: { frequency: 1397, duration: 0.07 } }
      ]
    }
  ];

  const EXPRESSIONS = {
    curious: {
      mood: 'curious', anim: 'nod', melody: [[523, 0.09], [659, 0.12]],
      build: () => [{ led: 'cyan' }, { turn: { angle: 14, speed: 45 } }, { wait: 0.3 }, { turn: { angle: -14, speed: 45 } }]
    },
    excited: {
      mood: 'excited', anim: 'bop', melody: [[784, 0.07], [988, 0.07], [1175, 0.1]],
      build: () => [{ led: 'amber' }, { turn: { angle: 16, speed: 90 } }, { turn: { angle: -16, speed: 90 } }, { tone: { frequency: 988, duration: 0.07 } }, { tone: { frequency: 1175, duration: 0.09 } }]
    },
    nervous: {
      mood: 'restless', anim: 'shiver', melody: [[392, 0.07], [370, 0.07], [392, 0.07]],
      build: () => [{ led: 'violet' }, { turn: { angle: 8, speed: 70 } }, { turn: { angle: -8, speed: 70 } }, { turn: { angle: 8, speed: 80 } }, { turn: { angle: -8, speed: 80 } }]
    },
    angry: {
      mood: 'grumpy', anim: 'nervous', melody: [[196, 0.25], [185, 0.2]],
      build: () => [{ led: 'red' }, { turn: { angle: -20, speed: 80 } }, { tone: { frequency: 196, duration: 0.3 } }, { tone: { frequency: 185, duration: 0.25 } }]
    },
    sad: {
      mood: 'sad', anim: 'nod', melody: [[330, 0.25], [294, 0.28], [262, 0.32]],
      build: () => [{ led: 'blue' }, { tone: { frequency: 330, duration: 0.25 } }, { tone: { frequency: 294, duration: 0.28 } }, { wait: 0.25 }, { tone: { frequency: 262, duration: 0.32 } }]
    },
    happy: {
      mood: 'excited', anim: 'bop', melody: [[784, 0.08], [1047, 0.1]],
      build: () => [{ led: 'mint' }, { turn: { angle: 12, speed: 70 } }, { turn: { angle: -12, speed: 70 } }, { tone: { frequency: 784, duration: 0.08 } }, { tone: { frequency: 1047, duration: 0.1 } }]
    },
    sleepy: {
      mood: 'sleepy', anim: 'nod', melody: [[392, 0.2], [330, 0.26], [262, 0.32]],
      build: () => [{ led: 'blue' }, { tone: { frequency: 392, duration: 0.2 } }, { tone: { frequency: 330, duration: 0.26 } }, { wait: 0.4 }, { tone: { frequency: 262, duration: 0.32 } }]
    },
    suspicious: {
      mood: 'scheming', anim: 'nervous', melody: [[247, 0.1], [247, 0.12]],
      build: () => [{ led: 'violet' }, { turn: { angle: 10, speed: 35 } }, { wait: 0.35 }, { turn: { angle: -10, speed: 35 } }, { tone: { frequency: 247, duration: 0.1 } }, { tone: { frequency: 247, duration: 0.1 } }]
    },
    refusal: {
      mood: 'grumpy', anim: 'shiver', melody: [[220, 0.12], [208, 0.16]],
      build: () => [{ led: 'red' }, { turn: { angle: -14, speed: 80 } }, { turn: { angle: 14, speed: 80 } }, { turn: { angle: -14, speed: 80 } }, { tone: { frequency: 220, duration: 0.14 } }]
    },
    startle: {
      mood: 'startled', anim: 'startle', melody: [[1319, 0.06], [660, 0.08]],
      build: () => [{ led: 'red' }, { tone: { frequency: 1319, duration: 0.06 } }, { move: { distance: 18, speed: 80 } }, { move: { distance: -18, speed: 80 } }, { led: 'amber' }, { tone: { frequency: 660, duration: 0.08 } }]
    },
    mystery_signal: {
      mood: 'scheming', anim: 'shiver', melody: [[523, 0.1], [415, 0.1], [523, 0.1], [622, 0.14]],
      build: () => [
        { led: 'violet' }, { tone: { frequency: 523, duration: 0.1 } }, { led: 'blue' }, { tone: { frequency: 415, duration: 0.1 } },
        { led: 'violet' }, { tone: { frequency: 523, duration: 0.1 } }, { led: 'blue' }, { tone: { frequency: 622, duration: 0.14 } }
      ]
    },
    hungry: {
      mood: 'hungry', anim: 'nod', melody: [[660, 0.09], [660, 0.09], [660, 0.12]],
      build: () => [{ led: 'mint' }, { tone: { frequency: 660, duration: 0.09 } }, { tone: { frequency: 660, duration: 0.09 } }, { wait: 0.2 }, { tone: { frequency: 660, duration: 0.12 } }]
    },
    lonely: {
      mood: 'lonely', anim: 'nod', melody: [[440, 0.2], [415, 0.22], [392, 0.26]],
      build: () => [{ led: 'blue' }, { tone: { frequency: 440, duration: 0.2 } }, { wait: 0.25 }, { tone: { frequency: 415, duration: 0.22 } }, { wait: 0.3 }, { tone: { frequency: 392, duration: 0.26 } }]
    }
  };

  const SONGS = [
    { id: 'greeting', title: 'Hello Protocol', mood: 'warm', palette: ['mint', 'blue'], notes: [[392, 0.14], [523, 0.14], [659, 0.14], [784, 0.2], [659, 0.12], [880, 0.26]] },
    { id: 'happy', title: 'Small Bright Loops', mood: 'happy', palette: ['amber', 'mint'], notes: [[659, 0.1], [784, 0.1], [880, 0.1], [784, 0.08], [988, 0.12], [880, 0.08], [1175, 0.2]] },
    { id: 'lullaby', title: 'Soft Descent', mood: 'sleepy', palette: ['blue', 'violet'], notes: [[659, 0.3], [587, 0.32], [523, 0.34], [440, 0.36], [392, 0.4], [330, 0.5]] },
    { id: 'feeding', title: 'CrunchByte Anthem', mood: 'pleased', palette: ['mint', 'amber'], notes: [[523, 0.08], [392, 0.08], [523, 0.08], [587, 0.1], [523, 0.08], [659, 0.18]] },
    { id: 'victory', title: 'Undefeated For Now', mood: 'triumphant', palette: ['amber', 'mint', 'cyan'], notes: [[392, 0.11], [494, 0.11], [587, 0.11], [784, 0.13], [988, 0.13], [1175, 0.24]] },
    { id: 'mischief', title: 'Plan Noises', mood: 'scheming', palette: ['violet', 'red'], notes: [[311, 0.12], [370, 0.1], [349, 0.12], [415, 0.1], [392, 0.12], [466, 0.2]] },
    { id: 'lonely', title: 'One Small Signal', mood: 'wistful', palette: ['blue'], notes: [[440, 0.22], [415, 0.22], [440, 0.2], [392, 0.26], [349, 0.3], [330, 0.4]] },
    { id: 'discovery', title: 'Found Something??', mood: 'curious', palette: ['cyan', 'violet'], notes: [[587, 0.1], [622, 0.1], [740, 0.12], [698, 0.1], [880, 0.14], [1175, 0.22]] },
    { id: 'birthday', title: 'Unlicensed Birthday Noise', mood: 'celebratory', palette: ['amber', 'mint', 'cyan'], notes: [[659, 0.1], [784, 0.1], [880, 0.1], [1047, 0.12], [880, 0.1], [784, 0.1], [988, 0.12], [1319, 0.24]] },
    { id: 'humming', title: 'Wandering Hum', mood: 'content', palette: ['mint', 'blue', 'cyan'], notes: [[440, 0.18], [494, 0.14], [466, 0.18], [523, 0.14], [466, 0.18], [440, 0.16], [392, 0.22], [440, 0.3]] }
  ];

  const CHIRPS = {
    hello: [[660, 0.06], [880, 0.08]],
    feed: [[520, 0.05], [760, 0.05], [980, 0.07]],
    explore: [[440, 0.06], [610, 0.06]],
    dance: [[523, 0.07], [659, 0.07], [784, 0.09]],
    mischief: [[330, 0.08], [495, 0.05], [370, 0.07]],
    sleep: [[523, 0.08], [392, 0.1], [262, 0.14]],
    alert: [[880, 0.06], [880, 0.06], [1175, 0.1]],
    happy: [[784, 0.06], [988, 0.06], [1175, 0.09]],
    sad: [[440, 0.12], [392, 0.16]],
    ping: [[988, 0.05]]
  };

  let audioCtx = null;
  function getAudioCtx() {
    const AC = (typeof window !== 'undefined') ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AC) return null;
    try {
      if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AC();
      if (audioCtx.state === 'suspended') {
        const p = audioCtx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      return audioCtx;
    } catch { return null; }
  }

  function playNotes(notes) {
    try {
      if (!Array.isArray(notes) || !notes.length) return;
      const ctx = getAudioCtx();
      if (!ctx) return;
      let t = ctx.currentTime + 0.02;
      // Absolute-time grid (no cumulative drift); three-voice band so the
      // browser version sounds like a tune, not a test beep.
      for (const n of notes) {
        if (!Array.isArray(n)) continue;
        const f = clamp(num(n[0], 440), TONE_MIN, TONE_MAX);
        const d = clamp(num(n[1], 0.08), 0.03, 0.5);
        const voice = (type, freq, vol, dur, at) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = type;
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(vol, at + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
          osc.connect(gain);
          try { gain.connect(ctx.destination); } catch {}
          osc.start(at);
          osc.stop(at + dur + 0.02);
        };
        voice('square', f, 0.055, d, t);                       // lead
        voice('triangle', f * 1.26, 0.02, Math.max(d, 0.1), t); // pad fifth-ish
        voice('sawtooth', Math.max(f / 2, TONE_MIN), 0.03, d, t); // bass
        t += d + 0.03;
      }
    } catch {}
  }

  // Interleave a dance's melody as real tone steps (the robot's own beeps).
  // Notes land on direction changes/waits so they read as the beat without
  // delaying motion beyond their (<=0.35s) duration — serial execution is the
  // tempo.
  function withMelody(steps, melody) {
    if (!Array.isArray(steps) || !Array.isArray(melody) || !melody.length) return steps;
    const out = [];
    let ni = 0;
    for (const s of steps) {
      out.push(s);
      const boundary = s.turn || s.wait || s.led;
      if (boundary && ni < melody.length) {
        const n = melody[ni++];
        if (Array.isArray(n)) out.push({ tone: { frequency: clamp(num(n[0], 440), TONE_MIN, TONE_MAX), duration: clamp(num(n[1], 0.08), TONE_DMIN, TONE_DMAX) } });
      }
    }
    while (ni < melody.length) {
      const n = melody[ni++];
      if (Array.isArray(n)) out.push({ tone: { frequency: clamp(num(n[0], 440), TONE_MIN, TONE_MAX), duration: clamp(num(n[1], 0.08), TONE_DMIN, TONE_DMAX) } });
    }
    return out;
  }

  let syncTimers = [];
  function clearSync() {
    for (const id of syncTimers) { try { clearTimeout(id); } catch {} }
    syncTimers = [];
  }
  function scheduleLedSync(steps) {
    clearSync();
    let t = 0;
    (steps || []).forEach((s, i) => {
      t += (s.wait || 0) + (s.tone ? s.tone.duration : 0) + ((s.move || s.turn) ? 0.45 : 0);
      if (s.led && i > 0) {
        const color = s.led;
        syncTimers.push(setTimeout(() => { emit('led', { color }); }, Math.round(t * 1000)));
      }
    });
  }

  async function execViaSafety(steps, label) {
    try {
      const r = await Safety.execSteps(steps, { source: 'gesture', label });
      return (r && typeof r === 'object') ? r : { simulated: true };
    } catch (e) {
      return { simulated: false, error: (e && e.message) || 'execSteps failed' };
    }
  }

  async function dance(id) {
    const d = DANCES.find(x => x && x.id === id);
    if (!d) return { ok: false, simulated: false, error: 'unknown dance: ' + String(id) };
    let steps = [];
    try { steps = routine(d.build() || [], ROUTINE_CAP); } catch { steps = []; }
    if (!steps.length) return { ok: false, simulated: false, error: 'dance produced no steps' };
    const hwConnected = !!(Safety && Safety.state && Safety.state().connected);
    if (hwConnected) steps = routine(withMelody(steps, d.melody), ROUTINE_CAP);
    emit('dance', { name: d.id, title: d.title });
    emit('anim', { name: d.anim || 'bop', ms: clamp(Math.round(wallTime(steps) * 1000) + 300, 400, 6000) });
    const firstLed = (steps.find(s => s.led) || {}).led || PALETTE[d.color] || PALETTE.mint;
    emit('led', { color: firstLed });
    scheduleLedSync(steps);
    if (!hwConnected) playNotes(d.melody);
    const res = await execViaSafety(steps, 'dance:' + d.id);
    return { ok: !res.error, simulated: !!res.simulated, name: d.id, title: d.title, steps: steps.length, error: res.error || null };
  }

  async function express(name) {
    const e = EXPRESSIONS[name];
    if (!e) return { ok: false, simulated: false, error: 'unknown expression: ' + String(name) };
    let steps = [];
    try { steps = routine(e.build() || [], ROUTINE_CAP); } catch { steps = []; }
    if (!steps.length) return { ok: false, simulated: false, error: 'expression produced no steps' };
    if (e.mood) emit('mood', { mood: e.mood });
    emit('anim', { name: e.anim || 'bop', ms: clamp(Math.round(wallTime(steps) * 1000) + 200, 300, 3000) });
    const firstLed = (steps.find(s => s.led) || {}).led;
    if (firstLed) emit('led', { color: firstLed });
    scheduleLedSync(steps);
    // Same rule as dance()/song(): when the robot body is attached its own
    // tone steps are the music — a simultaneous browser melody would double it.
    if (!(Safety && Safety.state && Safety.state().connected)) playNotes(e.melody);
    const res = await execViaSafety(steps, 'express:' + name);
    return { ok: !res.error, simulated: !!res.simulated, name, error: res.error || null };
  }

  function songSteps(s) {
    const pal = Array.isArray(s.palette) && s.palette.length ? s.palette : ['mint'];
    const raw = (s.notes || []).map((n, i) => ({ tone: { frequency: n[0], duration: n[1] }, led: pal[i % pal.length] }));
    return routine(raw, ROUTINE_CAP);
  }

  async function song(id) {
    const s = SONGS.find(x => x && x.id === id);
    if (!s) return { ok: false, simulated: false, error: 'unknown song: ' + String(id) };
    const steps = songSteps(s);
    if (!steps.length) return { ok: false, simulated: false, error: 'song produced no steps' };
    emit('song', { name: s.id, title: s.title });
    const firstLed = (steps.find(x => x.led) || {}).led;
    if (firstLed) emit('led', { color: firstLed });
    scheduleLedSync(steps);
    if (!(Safety && Safety.state && Safety.state().connected)) playNotes(s.notes);
    const res = await execViaSafety(steps, 'song:' + s.id);
    return { ok: !res.error, simulated: !!res.simulated, name: s.id, title: s.title, steps: steps.length, error: res.error || null };
  }

  function chirp(kind) {
    const key = (typeof kind === 'string' && CHIRPS[kind]) ? kind : 'ping';
    playNotes(CHIRPS[key]);
    return { ok: true, kind: key };
  }

  function unlockAudio() {
    const ctx = getAudioCtx();
    return { ok: !!ctx && ctx.state === 'running', state: ctx ? ctx.state : 'unavailable' };
  }

  function listDances() {
    return DANCES.map(d => ({
      id: d.id,
      title: d.title,
      desc: d.desc,
      ...(d.minPlayfulness != null ? { minPlayfulness: d.minPlayfulness } : {}),
      ...(d.secret ? { secret: true } : {})
    }));
  }

  function listSongs() {
    return SONGS.map(s => ({ id: s.id, title: s.title, mood: s.mood }));
  }

  NS.Perform = {
    version: '1.0.0',
    prims,
    listDances,
    listSongs,
    dance,
    express,
    song,
    chirp,
    unlockAudio
  };
})();
