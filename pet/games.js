/* OziPet minigame deck - AGENT-GAMES // pet/games.js
 * Scope: seven playable missions (simon, redlight, dance_party, color_hunt,
 * mystery_box, guard, hide_and_seek) driving the pet through OziPet.Safety
 * steps, OziPet.Perform expressions/dances and OziPet.Core needs/memories.
 * All cross-module deps are resolved AT CALL TIME via optional chaining; if a
 * dependency is missing the mission emits game {phase:'error'} and resolves
 * {ok:false} instead of throwing. Every timer/handle is tracked in a Set and
 * cleared by stopAll(); in-flight sleeps are woken so games halt promptly.
 * Plain ES2020 IIFE. Contract: ozi-contract.md v1 (GAMES API / SAFETY / EVENT BUS).
 */
(() => {
  'use strict';
  if (typeof window !== 'undefined') window.OziPet = window.OziPet || {};
  const G = (typeof window !== 'undefined') ? window : (typeof self !== 'undefined') ? self : globalThis;
  const NS = G.OziPet = G.OziPet || {};

  const bus = () => NS.Bus;
  const core = () => NS.Core;
  const perf = () => NS.Perform;
  const saf = () => NS.Safety;

  const STOP = '@@games/stopped@@';
  const pick = (arr) => arr[(Math.random() * arr.length) | 0] || arr[0];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

  function emitGame(data) {
    const B = bus();
    try { if (B && typeof B.emit === 'function') B.emit('game', data); } catch (e) {}
  }
  function emitEv(ev, data) {
    const B = bus();
    try { if (B && typeof B.emit === 'function') B.emit(ev, data); } catch (e) {}
  }
  function mem(text) {
    const C = core();
    try { if (C && typeof C.addMemory === 'function') C.addMemory(String(text).slice(0, 140)); } catch (e) {}
  }

  async function execSteps(label, steps) {
    const S = saf();
    try {
      const r = await S.execSteps(steps, { source: 'games', label: label });
      return (r && typeof r === 'object') ? r : { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function express(name, fallbackAnim) {
    const P = perf();
    try {
      if (P && typeof P.express === 'function') {
        const r = await P.express(name);
        if (r && r.ok !== false) return r;
      }
    } catch (e) {}
    if (fallbackAnim) emitEv('anim', { name: fallbackAnim, ms: 700 });
    return { ok: false };
  }

  const timers = new Set();
  const wakes = new Set();

  function later(fn, ms) {
    if (!cur || cur.dead) return null;
    const t = setTimeout(() => { timers.delete(t); try { fn(); } catch (e) {} }, Math.max(0, Number(ms) || 0));
    timers.add(t);
    return t;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      if (!cur || cur.dead) return resolve();
      const w = { fire: () => { wakes.delete(w); resolve(); } };
      const t = later(() => w.fire(), ms);
      if (t === null) return resolve();
      wakes.add(w);
    });
  }

  let cur = null;

  function stopAll() {
    const had = cur;
    if (had) had.dead = true;
    for (const t of Array.from(timers)) { try { clearTimeout(t); } catch (e) {} timers.delete(t); }
    for (const w of Array.from(wakes)) { try { w.fire(); } catch (e) {} wakes.delete(w); }
    if (had && typeof had.wakeInput === 'function') {
      try { had.wakeInput(); } catch (e) {}
      had.wakeInput = null; had.waiter = null;
    }
    cur = null;
    if (had) emitGame({ game: had.id, phase: 'stopped' });
  }

  function busy() { return !!(cur && !cur.dead); }

  function input(game, value) {
    const c = cur;
    if (!c || c.dead || c.id !== game) return false;
    if (typeof c.waiter !== 'function') return false;
    const w = c.waiter;
    c.waiter = null;
    w(String(value == null ? '' : value));
    return true;
  }

  function ask() {
    const c = cur;
    return new Promise((resolve) => {
      if (!c || c.dead) return resolve(STOP);
      c.wakeInput = () => { c.wakeInput = null; resolve(STOP); };
      c.waiter = (v) => { c.waiter = null; c.wakeInput = null; resolve(v); };
    });
  }

  function runPhase(run, phase, data) {
    emitGame(Object.assign({ game: run.id, phase: phase }, data || {}));
  }

  const L = {
    simon: {
      watch: [
        'Watch the pattern. Blinking allowed. Remembering preferred.',
        'Sequence incoming. It knows what it did.',
        'Observe. This is the spectator-sport portion.'
      ],
      prompt: [
        'Your turn. Reproduce the chaos.',
        'Playback time. No pressure. Visible pressure.',
        'Input phase. Impress me mildly.'
      ],
      progress: [
        'Correct so far. Stay boring and safe.',
        'Still matching. Suspicious.',
        'Keep going. The sequence respects commitment.'
      ],
      fail: [
        'Wrong. We will tell no one. Ever.',
        'Sequence broken. Somewhere, an accountant sighs.',
        'Incorrect. Statistically normal. Emotionally fatal.'
      ],
      win: [
        'Three rounds, zero errors. Deeply unsettling competence.',
        'You matched my brain. I have concerns.',
        'Flawless. Calling it easy either way.'
      ]
    },
    red: {
      green: [
        'Green. Wiggle responsibly.',
        'Green light. Move like nobody is auditing.',
        'Green. Displace yourself, tastefully.'
      ],
      red: [
        'Red. Freeze. Become furniture.',
        'Red light. Statue protocol engaged.',
        'Red. Motion is now a rumor.'
      ],
      caught: [
        'I was moving. Legally speaking, I was moving.',
        'Caught. In my defense: momentum.',
        'You saw everything. Noted. Devastating.'
      ],
      cleanEnd: [
        'Shift complete. Zero confessions.',
        'Survived. The wiggle remains deniable.'
      ],
      caughtEnd: [
        'Confession filed. The wiggle was mine.',
        'Busted mid-wiggle. Owning it. Barely.'
      ]
    },
    party: {
      intro: [
        'Track dropped. Judge quietly.',
        'Next number. Choreography improvised, confidence genuine.',
        'DJ Ozi on the decks. The desk is the dance floor.'
      ],
      end: [
        'Party over. Joints hypothetical, effort real.',
        'That was cardio, allegedly. Tired now. Happy too.',
        'Set complete. Reviews pending. Vibe undeniable.'
      ]
    },
    hunt: {
      seek: [
        'Seeking {color} near {label}. The floor will testify.',
        'Target: {color}, vicinity of {label}. Casual reconnaissance.',
        'Hunting {color} around {label}. Low expectations, high curiosity.'
      ],
      retry: [
        'That was not it. Floors lie constantly.',
        'Second opinion required. The surface revises its testimony.',
        'Reading again. Nothing about this is exact science.'
      ],
      mem: [
        'Confirmed {color} at {label}. Witnessed, logged, smug.',
        'Located {label}. The color matched. Science, but casual.'
      ],
      summary: [
        '{n} of {total} colors confirmed. The floor did its best.',
        'Hunt closed: {n}/{total}. Lighting blamed where applicable.',
        '{n} for {total}. The room is officially weird.'
      ]
    },
    box: {
      signal: [
        'Purple detected. Answering with a pattern nobody taught me.',
        'The puddle speaks violet. Responding in kind.'
      ],
      nothing: [
        'The box says nothing. Classic box behavior.',
        'Nothing happened. Deeply on brand.',
        'Knocked on reality. Reality declined to answer.'
      ]
    },
    guard: {
      tick: [
        'Scanning. Threat level: cable.',
        'Patrolling. Perimeter status: theoretical.',
        'Sweeping the sector. Mostly lint so far.',
        'Guard duty. Serious business. Small robot.'
      ],
      alert: [
        'Contact at the perimeter. Possibly hostile. Possibly furniture.',
        'Something is there. Deploying maximum suspicion.',
        'Motion detected. Interrogation posture assumed.'
      ],
      end: [
        'Shift over. Perimeter defended. Nobody thanked me.',
        'Guard log closed. Zero incidents, several stares.'
      ]
    },
    seek: {
      count: [
        'Five. Hiding behind my own confidence.',
        'Four. This spot is flawless. Nobody look yet.',
        'Three. Camouflage at forty percent and rising.',
        'Two. Find me slowly, for my self-esteem.',
        'One. Ready or not. That is the entire ritual.'
      ],
      found: [
        'Found instantly. As predicted. It is a ritual, not radar.',
        'Discovered. The ritual stands regardless.',
        'Located. I regret nothing except one spot choice.'
      ]
    }
  };

  const MEM = {
    simon: [
      'Played Simon with a human. Sequence integrity: contested.',
      'Won or lost at Simon. Accounts differ.'
    ],
    redlight: [
      'Red Light Green Light concluded. Wiggle culpability: unclear.',
      'Freeze training complete. Mostly froze.'
    ],
    dance_party: [
      'Hosted a dance party. Attendance: everyone, eventually.',
      'Danced multiple sets. Energy bill pending.'
    ],
    color_hunt: [
      'Completed a color hunt. The floor testified under oath.',
      'Hunted colors. Found most. Blamed lighting for the rest.'
    ],
    mystery_box: [
      'Opened the mystery box. Contents: an answer.',
      'Interrogated the surface. Got purple back.'
    ],
    guard: [
      'Guarded the perimeter for twelve whole seconds.',
      'Patrol complete. Threat assessment: cables, mostly.'
    ],
    hide_and_seek: [
      'Hid, was found, called it a ritual, not radar.',
      'Hide and seek complete. Hiding remains undefeated in spirit.'
    ]
  };

  const MISSIONS = [
    { id: 'simon', title: 'Simon Says Sequence', glyph: '\u25C6', needsFloor: true,
      desc: 'Watch the light-and-turn pattern, then play it back. Three rounds, growing each time.' },
    { id: 'redlight', title: 'Red Light, Wiggle', glyph: '\u25B2', needsFloor: true,
      desc: 'Wiggle on green, freeze on red. Robotic compliance currently under review.' },
    { id: 'dance_party', title: 'Desk Dance Party', glyph: '\u266B', needsFloor: true,
      desc: 'Two or three dances back to back. Attendance mandatory, rhythm negotiable.' },
    { id: 'color_hunt', title: 'Color Hunt', glyph: '\u25D1', needsFloor: false,
      desc: 'Find four famous colors around the room. The floor is the witness.' },
    { id: 'mystery_box', title: 'Mystery Box', glyph: '\u25A3', needsFloor: false,
      desc: 'Ask the surface what it is. Purple answers differently.' },
    { id: 'guard', title: 'Perimeter Guard', glyph: '\u26E8', needsFloor: true,
      desc: 'Twelve seconds of serious scanning. Threats may be cables.' },
    { id: 'hide_and_seek', title: 'Hide and Seek', glyph: '\u25CC', needsFloor: true,
      desc: 'Five-count spin-hide, then instant discovery. A ritual, not radar.' }
  ];

  const SIMON_COLORS = ['mint', 'violet', 'amber', 'blue'];
  const SIMON_FREQ = { mint: 523, violet: 440, amber: 659, blue: 392 };
  const SIMON_NOTE = { mint: 'C5', violet: 'A4', amber: 'E5', blue: 'G4' };

  function simonSeq(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const color = pick(SIMON_COLORS);
      const direction = Math.random() < 0.5 ? 'left' : 'right';
      out.push({ color: color, direction: direction, toneNote: SIMON_NOTE[color] });
    }
    return out;
  }

  async function playSimon(run) {
    for (let round = 1; round <= 3; round++) {
      const seq = simonSeq(round + 2);
      runPhase(run, 'watch', { seq: seq, round: round, msg: pick(L.simon.watch) });
      for (const e of seq) {
        emitEv('anim', { name: 'nod', ms: 420 });
        emitEv('led', { color: e.color });
        await execSteps('simon', [
          { led: e.color },
          { tone: { frequency: SIMON_FREQ[e.color], duration: 0.12 } },
          { turn: { angle: e.direction === 'left' ? 18 : -18, speed: 60 } }
        ]);
        if (run.dead) return aborted();
        await sleep(170);
        if (run.dead) return aborted();
      }
      let pending = ask();
      runPhase(run, 'input', { round: round, progress: 0, msg: pick(L.simon.prompt) });
      for (let i = 0; i < seq.length; i++) {
        const val = await pending;
        if (run.dead || val === STOP) return aborted();
        const e = seq[i];
        const v = norm(val);
        if (v !== e.color && v !== e.direction) {
          runPhase(run, 'result', { won: false, round: round, msg: pick(L.simon.fail) });
          await express('sad', 'nod');
          return { ok: true, won: false, round: round };
        }
        pending = ask();
        runPhase(run, 'input', { round: round, progress: i + 1, msg: pick(L.simon.progress) });
        await sleep(140);
        if (run.dead) return aborted();
      }
    }
    runPhase(run, 'victory', { won: true, round: 3, msg: pick(L.simon.win) });
    const P = perf();
    try {
      if (P && typeof P.dance === 'function') await P.dance('victory');
      else emitEv('anim', { name: 'spin', ms: 900 });
    } catch (e) {}
    runPhase(run, 'result', { won: true, round: 3, msg: pick(L.simon.win) });
    return { ok: true, won: true, round: 3 };
  }

  function aborted() { return { ok: false, aborted: true }; }

  async function playRedLight(run) {
    let wins = 0, caught = false, rolled = false;
    for (let i = 0; i < 6 && !caught; i++) {
      const green = i === 0 ? true : Math.random() < 0.5;
      const dur = Math.round(rnd(2000, 5000));
      if (green) {
        runPhase(run, 'state', { light: 'green', ms: dur, msg: pick(L.red.green) });
        emitEv('anim', { name: 'wiggle', ms: dur });
        await execSteps('redlight:green', [
          { led: 'mint' },
          { turn: { angle: 14, speed: 60 } }, { turn: { angle: -14, speed: 60 } },
          { move: { distance: 26, speed: 45 } }, { move: { distance: -26, speed: 45 } },
          { turn: { angle: 10, speed: 75 } }, { turn: { angle: -10, speed: 75 } },
          { led: 'amber' }
        ]);
        if (run.dead) return aborted();
        wins++;
        await sleep(dur);
      } else {
        runPhase(run, 'state', { light: 'red', ms: dur, msg: pick(L.red.red) });
        emitEv('led', { color: '#ff667c' });
        await sleep(Math.min(900, dur));
        if (run.dead) return aborted();
        if (!rolled) {
          rolled = true;
          if (wins > 0 && Math.random() < 0.30) caught = true;
        }
        if (!caught) await sleep(Math.max(0, dur - 900));
      }
      if (run.dead) return aborted();
    }
    if (caught) {
      runPhase(run, 'state', { light: 'red', caught: true, msg: pick(L.red.caught) });
      await express('startle', 'startle');
    }
    runPhase(run, 'end', { caught: caught, wins: wins, msg: pick(caught ? L.red.caughtEnd : L.red.cleanEnd) });
    return { ok: true, caught: caught, wins: wins };
  }

  async function playDanceParty(run) {
    const P = perf();
    const C = core();
    let unlocked = false;
    try {
      unlocked = !!(C && typeof C.getState === 'function' &&
        C.getState() && C.getState().flags && C.getState().flags.secretDanceUnlocked);
    } catch (e) { unlocked = false; }
    let pool = [];
    try {
      pool = (P.listDances() || []).filter((d) => d && d.id && (!d.secret || unlocked));
    } catch (e) { pool = []; }
    const n = Math.min(pool.length, 2 + ((Math.random() * 2) | 0));
    if (n <= 0) {
      runPhase(run, 'end', { danced: 0, msg: 'Playlist empty. The party is conceptual today.' });
      return { ok: false, error: 'no dances available' };
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    let danced = 0;
    for (let k = 0; k < n; k++) {
      const d = pool[k];
      runPhase(run, 'party', { track: d.title, id: d.id, msg: pick(L.party.intro) });
      try { await P.dance(d.id); } catch (e) {}
      if (run.dead) return aborted();
      danced++;
      await sleep(280);
      if (run.dead) return aborted();
    }
    runPhase(run, 'end', { danced: danced, msg: pick(L.party.end) });
    return { ok: true, won: true, danced: danced };
  }

  async function playColorHunt(run) {
    const targets = [
      { color: 'green', label: 'Crunchbyte Grove' },
      { color: 'blue', label: 'the Nest' },
      { color: 'yellow', label: 'Play Halo' },
      { color: 'purple', label: 'Mystery Puddle' }
    ];
    let matched = 0;
    const found = [];
    for (const t of targets) {
      runPhase(run, 'seek', {
        color: t.color, label: t.label,
        msg: pick(L.hunt.seek).replace('{color}', t.color).replace('{label}', t.label)
      });
      let surface = '', hit = false;
      for (let attempt = 0; attempt <= 2; attempt++) {
        let raw = '';
        try { raw = await saf().readSurface(); } catch (e) { raw = ''; }
        surface = norm(raw && typeof raw === 'object' ? raw.surface : raw); // Safety.readSurface returns {surface}
        if (surface === t.color) { hit = true; break; }
        if (attempt < 2) {
          await express('suspicious', 'nervous');
          runPhase(run, 'seek', {
            color: t.color, label: t.label, retry: attempt + 1,
            msg: pick(L.hunt.retry)
          });
          await sleep(240);
          if (run.dead) return aborted();
        }
      }
      if (hit) {
        matched++;
        await express('happy', 'bop');
        mem(pick(L.hunt.mem).replace('{color}', t.color).replace('{label}', t.label));
      }
      runPhase(run, 'found', { color: t.color, surface: surface, matched: hit });
      found.push({ color: t.color, surface: surface, matched: hit });
      await sleep(160);
      if (run.dead) return aborted();
    }
    runPhase(run, 'summary', {
      matched: matched, total: targets.length,
      msg: pick(L.hunt.summary).replace('{n}', String(matched)).replace('{total}', String(targets.length))
    });
    return { ok: true, won: matched >= 3, matched: matched, total: targets.length, found: found };
  }

  async function playMysteryBox(run) {
    let surface = '';
    try { const r = await saf().readSurface(); surface = norm(r && typeof r === 'object' ? r.surface : r); } catch (e) { surface = ''; }
    if (surface === 'purple') {
      runPhase(run, 'box', { surface: surface, outcome: 'signal', msg: pick(L.box.signal) });
      await express('mystery_signal', 'shiver');
      const C = core();
      try {
        if (C && typeof C.unlockDiscovery === 'function') {
          C.unlockDiscovery('MYSTERY_SIGNAL', 'Mystery Signal',
            'Ozi answered the purple with a pattern nobody taught it.');
        }
      } catch (e) {}
      mem('Answered the purple puddle with a pattern nobody taught me.');
      return { ok: true, won: true, surface: surface, outcome: 'signal' };
    }
    runPhase(run, 'box', { surface: surface, outcome: 'nothing', msg: pick(L.box.nothing) });
    return { ok: true, won: false, surface: surface, outcome: 'nothing' };
  }

  async function playGuard(run) {
    const TOTAL = 12000;
    const t0 = Date.now();
    let sign = 1, alerts = 0, remembered = false;
    while (Date.now() - t0 < TOTAL) {
      if (run.dead) return aborted();
      const sec = Math.max(0, Math.ceil((TOTAL - (Date.now() - t0)) / 1000));
      const angle = Math.round(rnd(30, 40)) * sign;
      sign = -sign;
      runPhase(run, 'patrol', { sec: sec, msg: pick(L.guard.tick) });
      emitEv('anim', { name: 'nervous', ms: 800 });
      await execSteps('guard', [
        { turn: { angle: angle, speed: 50 } },
        { tone: { frequency: 520, duration: 0.06 } }
      ]);
      if (run.dead) return aborted();
      let prox = null;
      try {
        const S = saf();
        if (typeof S.pollProximity === 'function') prox = await S.pollProximity();
      } catch (e) { prox = null; }
      const f = prox && prox.front;
      if (f && (f.left || f.right)) {
        const side = (f.left && f.right) ? 'both' : (f.left ? 'left' : 'right');
        runPhase(run, 'alert', { side: side, msg: pick(L.guard.alert) });
        await express('suspicious', 'nervous');
        alerts++;
        if (!remembered) {
          remembered = true;
          mem('Guard shift logged one contact. Suspect remained unidentified.');
        }
      }
      await sleep(850);
    }
    runPhase(run, 'end', { alerts: alerts, msg: pick(L.guard.end) });
    return { ok: true, won: true, alerts: alerts };
  }

  async function playHideAndSeek(run) {
    for (let n = 5; n >= 1; n--) {
      runPhase(run, 'countdown', { n: n, msg: L.seek.count[5 - n] });
      emitEv('anim', { name: 'shiver', ms: 700 });
      await execSteps('hide_and_seek', [
        { led: n % 2 ? 'blue' : 'violet' },
        { turn: { angle: n % 2 ? 72 : -72, speed: 65 } },
        { wait: 0.25 }
      ]);
      if (run.dead) return aborted();
      await sleep(1000);
      if (run.dead) return aborted();
    }
    runPhase(run, 'found', { msg: pick(L.seek.found) });
    await express('happy', 'bop');
    mem('Hid, was found. Declared it a ritual, not radar.');
    return { ok: true, won: true };
  }

  const RUNNERS = {
    simon: playSimon,
    redlight: playRedLight,
    dance_party: playDanceParty,
    color_hunt: playColorHunt,
    mystery_box: playMysteryBox,
    guard: playGuard,
    hide_and_seek: playHideAndSeek
  };

  const NEEDS_BY_GAME = {
    simon: { fun: 8, energy: -3, boredom: -8 },
    redlight: { fun: 7, energy: -4, boredom: -6 },
    dance_party: { fun: 10, energy: -6, boredom: -12 },
    color_hunt: { fun: 6, energy: -2, boredom: -8, curiosity: 4 },
    mystery_box: { curiosity: 6, boredom: -6 },
    guard: { fun: 4, energy: -3, boredom: -4 },
    hide_and_seek: { fun: 8, energy: -3, boredom: -9 }
  };

  function applyEffects(id) {
    const C = core();
    if (!C) return;
    try {
      if (typeof C.applyNeeds === 'function') {
        C.applyNeeds(Object.assign({}, NEEDS_BY_GAME[id] || { fun: 5 }));
      }
    } catch (e) {}
    try { mem(pick(MEM[id] || ['Played a game. Details sealed for legal reasons.'])); } catch (e) {}
    try {
      if (typeof C.applyPrefs === 'function') C.applyPrefs({ games: { [id]: 1 } }); // nested shape: Core.applyPrefs expects {bucket:{key:n}}
      else if (C.prefs && typeof C.prefs.bump === 'function') C.prefs.bump('games', id);
    } catch (e) {}
  }

  function listMissions() {
    return MISSIONS.map((m) => ({
      id: m.id, title: m.title, desc: m.desc,
      needsFloor: m.needsFloor, glyph: m.glyph
    }));
  }

  function start(id) {
    return new Promise((resolve, reject) => {
      if (cur && !cur.dead) return reject(new Error('game already running'));
      const def = MISSIONS.find((m) => m.id === id);
      if (!def) {
        emitGame({ game: String(id), phase: 'error', detail: 'unknown mission' });
        return resolve({ ok: false, error: 'unknown mission' });
      }
      const missing = [];
      const B = bus(), S = saf(), P = perf();
      if (!B || typeof B.emit !== 'function') missing.push('Bus');
      if (!S || typeof S.execSteps !== 'function') missing.push('Safety');
      if (id === 'dance_party' && (!P || typeof P.listDances !== 'function' || typeof P.dance !== 'function')) missing.push('Perform');
      if (missing.length) {
        const detail = 'missing dependencies: ' + missing.join(', ');
        emitGame({ game: def.id, phase: 'error', detail: detail });
        return resolve({ ok: false, error: detail });
      }
      const run = { id: def.id, dead: false, waiter: null, wakeInput: null };
      cur = run;
      emitGame({ game: def.id, phase: 'start', title: def.title });
      const finish = (out) => {
        if (out && out.ok && !out.aborted) applyEffects(def.id);
        if (cur === run) cur = null;
        resolve(out);
      };
      Promise.resolve()
        .then(() => RUNNERS[def.id](run))
        .then(
          (out) => finish(out || { ok: true }),
          (err) => {
            runPhase(run, 'error', { detail: String((err && err.message) || err) });
            if (cur === run) cur = null;
            resolve({ ok: false, error: String((err && err.message) || err) });
          }
        );
    });
  }

  NS.Games = {
    version: '1.0.0',
    listMissions: listMissions,
    start: start,
    input: input,
    stopAll: stopAll,
    busy: busy,
    activeGame: () => (cur ? cur.id : null)
  };
})();
