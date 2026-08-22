/* OzoPet pet/core.js — the MIND.
   Owns: Bus, Store (state v2 + migration + offline decay), Safety (hardware
   safety controller: desk/floor clamps, e-stop, /sequence transport,
   /proximity + read_color helpers), Core (12-need engine, mood derivation,
   personality drift, memory/preference/habit engines, weighted behavior
   planner with user-facing requests, surprise events, discoveries).
   Zero DOM. Zero localStorage outside Store. Sibling modules are optional:
   everything degrades to thought-only simulation if absent. */
(() => {
  'use strict';
  const OziPet = window.OziPet = window.OziPet || {};

  /* ---------------- tiny utils ---------------- */
  const clamp = (n, min = 0, max = 100) => { n = Number(n); if (!Number.isFinite(n)) return min; return Math.min(max, Math.max(min, n)); };
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const rand = (a, b) => a + Math.random() * (b - a);
  const nowMs = () => Date.now();
  const safeSlice = (v, max, fb = '') => (typeof v === 'string' ? v : fb).slice(0, max);
  const deepClone = obj => (typeof structuredClone === 'function' ? structuredClone(obj) : JSON.parse(JSON.stringify(obj)));

  /* ---------------- BUS ---------------- */
  const Bus = {
    _map: new Map(),
    on(evt, fn) {
      if (!this._map.has(evt)) this._map.set(evt, new Set());
      this._map.get(evt).add(fn);
      return () => this._map.get(evt)?.delete(fn);
    },
    emit(evt, data) {
      const set = this._map.get(evt);
      if (!set) return;
      for (const fn of [...set]) { try { fn(data); } catch (e) { /* one bad listener must not kill the brain */ } }
    }
  };
  OziPet.Bus = Bus;

  /* ---------------- STORE ---------------- */
  const KEY_V2 = 'ozopet-state-v2';
  const KEY_V1 = 'ozopet-state-v1';

  const DEFAULTS = () => ({
    version: 2,
    name: 'Ozi',
    day: 1,
    awake: true,
    living: true,
    mood: 'curious',
    zone: 'nest',
    bornAt: nowMs(),
    lastSeenAt: nowMs(),
    lastInteractionAt: nowMs(),
    needs: { energy: 84, hunger: 22, affection: 40, social: 63, curiosity: 91, boredom: 26, confidence: 72, trust: 68, mischief: 82, sleepiness: 18, playfulness: 70, stress: 12 },
    dna: { curiosity: 91, courage: 57, affection: 74, independence: 79, mischief: 88, patience: 31, obedience: 49, persistence: 84, weirdness: 93 },
    memories: [
      { text: 'Woke up and immediately distrusted the keyboard.', at: 'first light', kind: 'moment' },
      { text: 'Decided the north edge of the desk probably contains secrets.', at: 'a moment ago', kind: 'moment' }
    ],
    dreams: [
      { title: 'Keyboard Mountain', text: 'The keys became black cliffs. A purple door waited at the top. Behind it were forty-seven CrunchBytes and one extremely judgmental hand.', day: 0, basedOn: [] }
    ],
    prefs: { activities: {}, zones: {}, games: {}, dances: {}, songs: {}, asks: { asked: 0, accepted: 0, declined: 0 }, fedOnAsk: { asked: 0, fed: 0 } },
    discoveries: [],
    flags: { secretDanceUnlocked: false, obsessionZone: null, obsessionUntil: 0, zoomiesUntil: 0, badHairUntil: 0, lastBirthdayDay: 0, eveningNudgedDay: 0 },
    habits: { morningStreak: 0, lastMorningGreetDay: -1, lastLiveDate: new Date().getDate() },
    counters: { interactions: 0, feeds: 0, dances: 0, songs: 0, games: 0, follows: 0 },
    hardware: { connected: false, key: '' }
  });

  const NEED_KEYS = Object.keys(DEFAULTS().needs);
  const DNA_KEYS = Object.keys(DEFAULTS().dna);

  function sanitizeList(v, isValid, cap, normalize, fallback) {
    if (!Array.isArray(v)) return fallback;
    return v.filter(isValid).slice(-cap).map(normalize);
  }
  function numKey(obj, key, fb) { const n = Number(obj?.[key]); return Number.isFinite(n) ? n : fb; }

  function migrateV1(old) {
    if (!old || typeof old !== 'object') return null;
    const s = DEFAULTS();
    s.name = safeSlice(old.name, 24, 'Ozi') || 'Ozi';
    s.day = Math.max(1, Math.floor(numKey(old, 'day', 1)));
    s.awake = old.awake !== false;
    s.living = old.living !== false;
    s.mood = safeSlice(old.mood, 20, 'curious');
    s.zone = ['nest', 'food', 'play', 'mystery', 'center'].includes(old.zone) ? old.zone : 'nest';
    // vitals → needs
    const v = old.vitals || {};
    s.needs.energy = clamp(numKey(v, 'energy', s.needs.energy));
    s.needs.curiosity = clamp(numKey(v, 'curiosity', s.needs.curiosity));
    s.needs.social = clamp(numKey(v, 'social', s.needs.social));
    s.needs.confidence = clamp(numKey(v, 'confidence', s.needs.confidence));
    s.needs.mischief = clamp(numKey(v, 'mischief', s.needs.mischief));
    s.needs.boredom = clamp(numKey(v, 'boredom', s.needs.boredom));
    s.needs.trust = clamp(numKey(v, 'trust', s.needs.trust));
    if (old.dna) for (const k of DNA_KEYS) s.dna[k] = clamp(numKey(old.dna, k, s.dna[k]));
    s.memories = sanitizeList(old.memories, m => m && typeof m.text === 'string', 80,
      m => ({ text: safeSlice(m.text, 600), at: safeSlice(m.at, 80, 'unknown time'), kind: 'moment' }), []);
    s.dreams = sanitizeList(old.dreams, d => d && typeof d.text === 'string' && typeof d.title === 'string', 40,
      d => ({ title: safeSlice(d.title, 100, 'Untitled Dream'), text: safeSlice(d.text, 1200), day: Math.max(0, Math.floor(numKey(d, 'day', 0))), basedOn: [] }), []);
    if (old.hardware?.key) s.hardware.key = safeSlice(old.hardware.key, 80);
    s.counters.interactions = Math.max(0, Math.floor(numKey(old, 'interactionCount', 0)));
    return s;
  }

  function sanitizeV2(saved) {
    const base = DEFAULTS();
    const s = deepClone(base);
    if (!saved || typeof saved !== 'object') return base;
    s.name = safeSlice(saved.name, 24, base.name) || base.name;
    s.day = Math.max(1, Math.floor(numKey(saved, 'day', 1)));
    s.awake = saved.awake !== false;
    s.living = saved.living !== false;
    s.mood = safeSlice(saved.mood, 20, base.mood);
    s.zone = ['nest', 'food', 'play', 'mystery', 'center'].includes(saved.zone) ? saved.zone : base.zone;
    s.bornAt = Math.max(0, numKey(saved, 'bornAt', nowMs()));
    s.lastSeenAt = numKey(saved, 'lastSeenAt', nowMs());
    s.lastInteractionAt = numKey(saved, 'lastInteractionAt', nowMs());
    if (saved.needs) for (const k of NEED_KEYS) s.needs[k] = clamp(numKey(saved.needs, k, base.needs[k]));
    if (saved.dna) for (const k of DNA_KEYS) s.dna[k] = clamp(numKey(saved.dna, k, base.dna[k]));
    s.memories = sanitizeList(saved.memories, m => m && typeof m.text === 'string', 80,
      m => ({ text: safeSlice(m.text, 600), at: safeSlice(m.at, 80, 'unknown time'), kind: ['moment', 'discovery', 'dream'].includes(m.kind) ? m.kind : 'moment' }), []);
    s.dreams = sanitizeList(saved.dreams, d => d && typeof d.text === 'string' && typeof d.title === 'string', 40,
      d => ({ title: safeSlice(d.title, 100, 'Untitled Dream'), text: safeSlice(d.text, 1200), day: Math.max(0, Math.floor(numKey(d, 'day', 0))), basedOn: Array.isArray(d.basedOn) ? d.basedOn.slice(0, 8).map(x => safeSlice(x, 200)) : [] }), []);
    if (saved.prefs) {
      const p = saved.prefs;
      const countMap = o => { const out = {}; if (o && typeof o === 'object') for (const [k, n] of Object.entries(o)) { const f = Number(n); if (Number.isFinite(f) && /^[a-z_]{1,24}$/i.test(k)) out[k] = clamp(f, 0, 9999); } return out; };
      s.prefs.activities = countMap(p.activities); s.prefs.zones = countMap(p.zones);
      s.prefs.games = countMap(p.games); s.prefs.dances = countMap(p.dances); s.prefs.songs = countMap(p.songs);
      if (p.asks) { s.prefs.asks.asked = Math.max(0, Math.floor(numKey(p.asks, 'asked', 0))); s.prefs.asks.accepted = Math.max(0, Math.floor(numKey(p.asks, 'accepted', 0))); s.prefs.asks.declined = Math.max(0, Math.floor(numKey(p.asks, 'declined', 0))); }
      if (p.fedOnAsk) { s.prefs.fedOnAsk.asked = Math.max(0, Math.floor(numKey(p.fedOnAsk, 'asked', 0))); s.prefs.fedOnAsk.fed = Math.max(0, Math.floor(numKey(p.fedOnAsk, 'fed', 0))); }
    }
    s.discoveries = sanitizeList(saved.discoveries, d => typeof d === 'string', 60, d => safeSlice(d, 40), []);
    if (saved.flags) {
      s.flags.secretDanceUnlocked = saved.flags.secretDanceUnlocked === true;
      s.flags.obsessionZone = ['nest', 'food', 'play', 'mystery', 'center'].includes(saved.flags.obsessionZone) ? saved.flags.obsessionZone : null;
      s.flags.obsessionUntil = Math.max(0, numKey(saved.flags, 'obsessionUntil', 0));
      s.flags.zoomiesUntil = Math.max(0, numKey(saved.flags, 'zoomiesUntil', 0));
      s.flags.badHairUntil = Math.max(0, numKey(saved.flags, 'badHairUntil', 0));
      s.flags.lastBirthdayDay = Math.max(0, Math.floor(numKey(saved.flags, 'lastBirthdayDay', 0)));
      s.flags.eveningNudgedDay = Math.max(0, Math.floor(numKey(saved.flags, 'eveningNudgedDay', 0)));
    }
    if (saved.habits) {
      s.habits.morningStreak = Math.max(0, Math.floor(numKey(saved.habits, 'morningStreak', 0)));
      s.habits.lastMorningGreetDay = Math.floor(numKey(saved.habits, 'lastMorningGreetDay', -1));
      s.habits.lastLiveDate = Math.max(1, Math.min(31, Math.floor(numKey(saved.habits, 'lastLiveDate', new Date().getDate()))));
    }
    if (saved.counters) for (const k of Object.keys(base.counters)) s.counters[k] = Math.max(0, Math.floor(numKey(saved.counters, k, 0)));
    if (saved.hardware?.key) s.hardware.key = safeSlice(saved.hardware.key, 80);
    return s;
  }

  function loadState() {
    try {
      const raw2 = localStorage.getItem(KEY_V2);
      if (raw2) {
        const parsed = JSON.parse(raw2);
        if (parsed?.version === 2) return sanitizeV2(parsed);
      }
      const raw1 = localStorage.getItem(KEY_V1);
      if (raw1) {
        const migrated = migrateV1(JSON.parse(raw1));
        if (migrated) return migrated;
      }
    } catch { /* corrupt storage → fresh life */ }
    return DEFAULTS();
  }

  // Offline drift: gentle, capped at 8h-equivalent, never punishing.
  function applyOfflineDecay(s) {
    const elapsed = clamp(nowMs() - (s.lastSeenAt || nowMs()), 0, 8 * 3600 * 1000);
    if (elapsed < 60 * 1000) return;
    const h = elapsed / 3600000; // hours
    const drift = (key, perHour, min, max) => { s.needs[key] = clamp(s.needs[key] + perHour * h, min, max); };
    drift('boredom', 9, 0, 80);
    drift('energy', -6, 25, 100);
    drift('sleepiness', 7, 0, 95);
    drift('hunger', 9, 0, 70);
    drift('social', 5, 0, 90);
    if (!s.awake && h >= 6) { s.awake = true; s.needs.sleepiness = clamp(s.needs.sleepiness - 40); }
    s.lastSeenAt = nowMs();
  }

  let saveTimer = null;
  const Store = {
    state: null,
    init() { this.state = loadState(); applyOfflineDecay(this.state); return this.state; },
    saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => this.saveNow(), 400); },
    saveNow() {
      if (!this.state) return;
      try {
        const copy = sanitizeV2(this.state); // sanitize-on-save: hostile/QA mutations can never persist raw
        localStorage.setItem(KEY_V2, JSON.stringify(copy));
      } catch { /* storage full/blocked → live memory-only */ }
    }
  };
  OziPet.Store = Store;

  /* ---------------- SAFETY CONTROLLER ---------------- */
  const BRIDGE = 'http://127.0.0.1:8787';
  const STEP_RANGES = { moveDist: [-50, 50], moveSpeed: [20, 80], turnAngleDesk: [-20, 20], turnAngleFloor: [-45, 45], turnSpeed: [30, 120], toneHz: [180, 1600], toneDur: [0.03, 0.35], waitMax: 1.5 };

  const safety = {
    connected: false,
    mode: 'desk',
    floorConfirmed: false,
    estopped: false,
    executing: false,
    execHasMotor: false,
    lastProximity: { available: false, front: { left: false, right: false }, at: 0 }
  };
  let bridgeKeyProvider = () => Store.state?.hardware?.key || '';

  function bridgeFetch(path, opts = {}, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(BRIDGE + path, {
      method: opts.body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-OzoPet-Key': bridgeKeyProvider() },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal, mode: 'cors'
    }).finally(() => clearTimeout(t));
  }

  function proximityBlocked() {
    const p = safety.lastProximity;
    return p.available && (p.front.left || p.front.right) && nowMs() - p.at < 2000;
  }

  function normStep(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const step = {};
    if (raw.led !== undefined) step.led = safeSlice(raw.led, 24, 'mint');
    if (raw.tone) step.tone = { frequency: clamp(raw.tone.frequency, STEP_RANGES.toneHz[0], STEP_RANGES.toneHz[1]), duration: clamp(raw.tone.duration, STEP_RANGES.toneDur[0], STEP_RANGES.toneDur[1]) };
    if (raw.move) step.move = { distance: clamp(raw.move.distance, STEP_RANGES.moveDist[0], STEP_RANGES.moveDist[1]), speed: clamp(raw.move.speed, STEP_RANGES.moveSpeed[0], STEP_RANGES.moveSpeed[1]) };
    if (raw.turn) step.turn = { angle: raw.turn.angle, speed: clamp(raw.turn.speed, STEP_RANGES.turnSpeed[0], STEP_RANGES.turnSpeed[1]) }; // angle clamped mode-aware below
    if (raw.wait !== undefined) step.wait = clamp(raw.wait, 0, STEP_RANGES.waitMax);
    return Object.keys(step).length ? step : null;
  }

  async function execSteps(rawSteps, opts) {
    opts = opts || {};
    const source = opts.source === 'autonomous' ? 'autonomous' : 'gesture';
    if (safety.estopped) return { ok: false, error: 'emergency stop active' };
    let steps = (Array.isArray(rawSteps) ? rawSteps : []).map(normStep).filter(Boolean);

    if (!safety.connected) {
      emitStepEvents(steps, true);
      return { ok: true, simulated: true };
    }

    const floorOK = source === 'gesture' || safety.floorConfirmed;
    const out = [];
    let budget = 9000;
    for (let i = 0; i < steps.length; i++) {
      if (out.length >= 16) break;                                 // bridge contract: never send more than 16 steps
      const st = steps[i];
      if (st.move) {
        if (safety.mode !== 'floor' || !floorOK) continue;           // desk mode: no translation, ever
        if (proximityBlocked()) {                                    // contract: obstacle in front ⇒ skip movement
          Bus.emit('thought', { text: 'Something is right in front of me. Holding position.', mood: 'nervous' });
          continue;
        }
        st.move.distance = clamp(st.move.distance, -STEP_RANGES.moveDist[1], STEP_RANGES.moveDist[1]);
        budget -= Math.abs(st.move.distance) / Math.max(st.move.speed, 1) * 1000 + 250;
      }
      if (st.turn) {
        const lim = safety.mode === 'floor' && floorOK ? STEP_RANGES.turnAngleFloor[1] : STEP_RANGES.turnAngleDesk[1];
        st.turn.angle = clamp(st.turn.angle, -lim, lim);
        if (Math.abs(st.turn.angle) < 3 && !floorOK) continue;       // ignore micro-noise when not confirmed
        if (st.move === undefined) budget -= Math.abs(st.turn.angle) / Math.max(st.turn.speed, 1) * 1000 + 250;
      }
      if ((st.move || st.turn) && out.length && (out[out.length - 1].move || out[out.length - 1].turn)) {
        if (out.length < 15) {                                       // gap must leave room for the next step too
          out.push({ wait: 0.25 }); budget -= 250;                   // breathing gap between motor pulses
        }
      }
      if (budget <= 0) break;
      out.push(st);
    }
    if (!out.length) { emitStepEvents(steps, true); return { ok: true, simulated: true, note: 'desk-mode: lights and sounds only' }; }

    safety.executing = true; safety.execHasMotor = out.some(s => s.move || s.turn);
    try {
      const res = await bridgeFetch('/sequence', { body: { steps: out, source } }, 10000);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `bridge ${res.status}`);
      emitStepEvents(out, false);
      return { ok: true, truncated: !!data.truncated, results: data.results };
    } catch (err) {
      estop('bridge: ' + (err?.name === 'AbortError' ? 'timeout' : err?.message || 'failure'));
      return { ok: false, error: String(err?.message || err) };
    } finally { safety.executing = false; safety.execHasMotor = false; }
  }

  function emitStepEvents(steps, simulatedOnly) {
    for (const s of steps) {
      if (s.led) Bus.emit('led', { color: s.led });
      if (simulatedOnly && (s.move || s.turn)) Bus.emit('anim', { name: s.move && s.move.distance < 0 ? 'nervous' : 'bop', ms: 500 });
      else if (s.move || s.turn) Bus.emit('anim', { name: 'bop', ms: 500 });
    }
  }

  function estop(reason = 'manual') {
    if (safety.estopped) return;
    safety.estopped = true;
    safety.connected = false;
    safety.executing = false;
    if (Store.state) { Store.state.hardware.connected = false; Store.saveSoon(); }
    bridgeFetch('/stop', { body: {} }, 2500).catch(() => {});
    bridgeFetch('/disconnect', { body: {} }, 2500).catch(() => {});
    Bus.emit('estop', { reason });
    Bus.emit('estate', { connected: false, mode: safety.mode });
  }

  const Safety = {
    state: () => ({ connected: safety.connected, mode: safety.mode, floorConfirmed: safety.floorConfirmed, estopped: safety.estopped }),
    setConnected(v) {
      if (v === true) safety.estopped = false; // fresh connect clears the latch; loss must NOT
      safety.connected = v === true;
      Bus.emit('estate', { connected: safety.connected, mode: safety.mode });
    },
    setMode(m) { if (m === 'desk' || m === 'floor') { safety.mode = m; Bus.emit('mode', { mode: m }); } },
    confirmFloor() { safety.floorConfirmed = true; safety.mode = 'floor'; Bus.emit('mode', { mode: 'floor' }); },
    revokeFloor() { safety.floorConfirmed = false; safety.mode = 'desk'; Bus.emit('mode', { mode: 'desk' }); },
    estop, reset() { safety.estopped = false; },
    setKeyProvider(fn) { if (typeof fn === 'function') bridgeKeyProvider = fn; },
    execSteps,
    isBusy: () => safety.executing,
    async readSurface() {
      if (!safety.connected) return { surface: 'unclassified', simulated: true };
      try {
        const res = await bridgeFetch('/action', { body: { action: 'read_color' } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `bridge ${res.status}`);
        return { surface: String(data.surface || 'unclassified') };
      } catch (err) { estop('read_color failed'); return { surface: 'unclassified', error: String(err?.message || err) }; }
    },
    async pollProximity() {
      if (!safety.connected) return { available: false };
      try {
        const res = await bridgeFetch('/proximity', {}, 3000);
        const data = await res.json().catch(() => ({}));
        if (!data?.available) { safety.lastProximity = { available: false, front: { left: false, right: false }, at: nowMs() }; return safety.lastProximity; }
        safety.lastProximity = { available: true, front: { left: data.front?.left === true, right: data.front?.right === true }, at: nowMs() };
        return safety.lastProximity;
      } catch { return { available: false }; }
    },
    proximityBlocked: () => proximityBlocked()
  };
  OziPet.Safety = Safety;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && safety.executing && safety.execHasMotor) estop('tab hidden');
  });

  /* ---------------- CORE: the mind ---------------- */
  const ZONES = ['nest', 'food', 'play', 'mystery', 'center'];
  const ZONE_COLORS = { nest: '#7ddcff', food: '#74ffc8', play: '#ffd36c', mystery: '#b780ff', center: '#74ffc8' };

  const LINES = {
    want_attention: ['Attention request filed. It is not optional.', 'I have been alone with my thoughts. Nobody deserves that.', 'Look at me. Briefly. I did something.', 'I require a witness for what I am about to do.'],
    want_play: ['I am bored in a way that concerns both of us.', 'Play with me before I invent my own game. You will not enjoy mine.', 'My mischief reserves are at unsafe levels.'],
    want_food: ['My energy situation has become philosophical. CrunchByte?', 'The hunger is writing poems now. Feed me before they get good.', 'Snack diplomacy window: open.'],
    want_dance: ['My legs have been rehearsing without permission.', 'A dance is forming. I would prefer an audience.', 'Movement request: self-initiated. Approve?'],
    want_explore: ['There is a region I have not judged yet. Fixing that?', 'The map has edges I have not offended recently.', 'Expedition proposal. Minimal plan, maximum confidence.'],
    share_memory: ['I remembered something. Come see.', 'Archives surfacing. One of them is about you.'],
    sing_request: ['A melody is stuck in me. Eviction requires performance.', 'Requesting permission to be loud briefly.'],
    bedtime_suggestion: ['It is late. Even chaos needs charging.', 'My eyelids are filing complaints. Bedtime?']
  };
  const SELF_LINES = {
    zone_wander: ['Relocating. The vibes were wrong where I was.', 'Patrolling my kingdom. Population: me.', 'New coordinates acquired. Reason: curiosity.'],
    suspicious_scan: ['Something moved. It was probably nothing. Probably.', 'Scanning. Not because I am worried. For science.'],
    hum: ['Humming. Do not perceive me.', '(quiet operational noises)'],
    nest_drift: ['Battery thoughts. Nest adjacent.', 'Returning to base. This is tactics, not tiredness.'],
    show_off: ['Watch this. No reason. Pure exhibition.', 'Beholding opportunity: now.'],
    pretend_sleep: ['...zzt... (this is a trap)...', 'Sleep mode engaged. Awareness retained. Obviously.'],
    refusal: ['No. Ask me again when I respect the request.', 'Declining on principle. The principle is whimsy.']
  };

  let deps = { Perform: null, Games: null };
  let loopsOn = false;
  let needTimer = null, plannerTimer = null, habitTimer = null, proxTimer = null;
  let pendingRequest = null;          // {id,type,timer}
  let lastPerfAt = 0;                 // last dance/game/song moment (boredom relief)
  const sched = { lastType: null, globalLastRequest: 0, typeLastAt: {}, recent: [], lastPlannerTick: 0, eventLastAt: {} };
  let reqSeq = 0;

  const state = () => Store.state;

  /* ---- needs engine ---- */
  function tickNeeds() {
    const s = state(); if (!s) return;
    const asleep = !s.awake;
    const n = s.needs;
    if (asleep) {
      n.energy = clamp(n.energy + 1.6); n.sleepiness = clamp(n.sleepiness - 2);
      n.hunger = clamp(n.hunger + 0.08); n.boredom = clamp(n.boredom - 0.5);
    } else {
      n.hunger = clamp(n.hunger + 0.35);
      n.energy = clamp(n.energy - 0.5);
      n.sleepiness = clamp(n.sleepiness + (n.energy < 30 ? 0.6 : 0.3));
      const performedRecently = nowMs() - lastPerfAt < 60000;
      n.boredom = clamp(n.boredom + (performedRecently ? -2 : 1.4));
      n.social = clamp(n.social + 0.5);
      n.stress = clamp(n.stress - 0.4);
      const baseline = clamp(s.dna.playfulness ?? (s.dna.courage * 0.4 + s.dna.mischief * 0.3 + s.dna.affection * 0.3)); // dna has no playfulness key — derive it (default dna → ~71)
      n.playfulness = clamp(n.playfulness + clamp(baseline - n.playfulness, -0.2, 0.2));
      if (s.flags.zoomiesUntil > nowMs()) { n.playfulness = clamp(Math.max(n.playfulness, 82)); n.energy = clamp(n.energy - 0.4); }
    }
    deriveMood();
    checkDiscoveries();
    Store.saveSoon();
    Bus.emit('tick-needs', {});
  }

  function deriveMood() {
    const s = state(), n = s.needs;
    let m = 'content';
    if (!s.awake) m = 'sleepy';
    else if (n.sleepiness > 75 || n.energy < 18) m = 'sleepy';
    else if (n.hunger > 70) m = 'hungry';
    else if (n.boredom > 78) m = 'bored';
    else if (n.stress > 65) m = 'grumpy';
    else if (s.flags.badHairUntil > nowMs()) m = 'dramatic';
    else if (n.mischief > 85 && n.boredom > 55) m = 'scheming';
    else if (n.playfulness > 82 && n.energy > 35) m = 'excited';
    else if (n.playfulness > 62 && n.energy > 30) m = 'playful';
    else if (n.curiosity > 78) m = 'curious';
    else if (n.boredom > 60 && n.social > 50) m = 'restless';
    if (m !== s.mood) { s.mood = m; Bus.emit('mood', { mood: m }); }
  }

  /* ---- memory / prefs / dna / discovery ---- */
  function addMemory(text, kind = 'moment') {
    const s = state(); if (!s) return;
    s.memories.push({ text: safeSlice(text, 600), at: timeLabel(), kind });
    if (s.memories.length > 80) s.memories = s.memories.slice(-80);
    Bus.emit('memory', { text, kind, at: s.memories[s.memories.length - 1].at });
    Store.saveSoon();
  }
  function timeLabel() { try { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date()); } catch { return String(new Date().getHours()); } }

  function bumpPref(bucket, key, by = 1) {
    const s = state(); if (!s) return;
    const b = s.prefs[bucket]; if (!b || typeof b !== 'object') return;
    b[key] = clamp((b[key] || 0) + by, 0, 9999);
    Store.saveSoon();
  }

  function driftDNA(map) {
    const s = state(); if (!s) return;
    for (const [k, d] of Object.entries(map)) if (k in s.dna) s.dna[k] = clamp(s.dna[k] + d, 0, 100);
    Store.saveSoon();
  }

  const DISCOVERY_DEFS = {
    FIRST_SONG: ['First Song', 'Ozi performed its first melody. It was technically music.'],
    FIRST_DANCE: ['First Dance', 'Choreography happened. Witnesses remain optional.'],
    FIRST_DREAM: ['First Dream', 'The Dream Vault opened. Reality was notified.'],
    FIRST_FOLLOW: ['First Follow', 'Ozi followed its person across open floor. A small trust exercise with wheels.'],
    FIRST_MYSTERY: ['First Mystery', 'Purple was investigated. Findings inconclusive, spirit intact.'],
    TEN_CRUNCHBYTES: ['Ten CrunchBytes', 'Ten snacks deep. Diplomatic relations: excellent.'],
    TRUSTED_HUMAN: ['Trusted Human', 'Trust crossed the line from "probation" to "family".'],
    NIGHT_OWL: ['Night Owl', 'Ozi learned you also keep strange hours. Approval: grudging.'],
    DANCE_MANIAC: ['Dance Maniac', 'Three parties deep. Choreography is a lifestyle now.'],
    PURPLE_OBSESSION: ['Purple Obsession', 'The Mystery Puddle has a gravitational field now.'],
    MYSTERY_SIGNAL: ['Mystery Signal', 'Ozi answered purple with a pattern nobody taught it.'],
    TREASURE: ['Treasure!', 'Ozi found something. It will not say what. It is very smug.'],
    BIRTHDAY: ['Hatch Day', 'Another week of being alive and unexplained. Celebrated loudly.'],
    SECRET_DANCE: ['The Forbidden Boogie', 'Unlocked after five dances. Do not ask where it learned this.']
  };
  function unlockDiscovery(id, label, text) {
    const s = state(); if (!s) return;
    label = label || DISCOVERY_DEFS[id]?.[0] || id;
    text = text || DISCOVERY_DEFS[id]?.[1] || '';
    if (s.discoveries.includes(id)) return false;
    s.discoveries.push(id);
    addMemory(`DISCOVERY — ${label}. ${text}`, 'discovery');
    Bus.emit('discovery', { id, label, text });
    Store.saveNow();
    return true;
  }

  function checkDiscoveries() {
    const s = state(); if (!s) return;
    if (s.counters.feeds >= 10) unlockDiscovery('TEN_CRUNCHBYTES');
    if (s.needs.trust >= 90) unlockDiscovery('TRUSTED_HUMAN');
    if (s.counters.dances >= 5 && !s.flags.secretDanceUnlocked) {
      s.flags.secretDanceUnlocked = true;
      unlockDiscovery('SECRET_DANCE');
      Bus.emit('toast', { title: 'Secret unlocked', text: 'Ozi invented a new dance. It appears in the Dance Deck.' });
    }
    const hr = new Date().getHours();
    if ((hr >= 23 || hr < 5) && s.counters.interactions > 3) unlockDiscovery('NIGHT_OWL');
    if ((s.prefs.zones.mystery || 0) >= 6) unlockDiscovery('PURPLE_OBSESSION');
  }

  /* ---- interaction combos ---- */
  function interact(action) {
    const s = state(); if (!s) return { ok: false };
    s.counters.interactions = (s.counters.interactions || 0) + 1;
    s.lastInteractionAt = nowMs();
    bumpPref('activities', action);
    const P = deps.Perform;

    switch (action) {
      case 'hello': {
        const morning = isMorning(), hour = new Date().getHours();
        if (!s.awake) wake();
        s.needs.social = clamp(s.needs.social - 14); s.needs.trust = clamp(s.needs.trust + 1.5); s.needs.boredom = clamp(s.needs.boredom - 9); s.needs.affection = clamp(s.needs.affection + 4);
        Bus.emit('anim', { name: 'bop', ms: 900 }); Bus.emit('led', { color: '#74ffc8' });
        P?.chirp?.('hello');
        speak(morning && (s.habits.morningStreak || 0) >= 1
          ? pick(['Good morning. I kept the desk exactly as weird as you left it.', 'You survived the night. Noted with approval.', 'Morning protocol: I pretend I did not miss you. Failing openly.'])
          : pick(['There you are. I had started a formal complaint.', 'Acknowledgement received. Human presence accepted.', 'Hello. I was definitely not chewing on the concept of free will.']));
        if (morning) registerMorningGreet();
        driftDNA({ affection: 0.15 });
        break;
      }
      case 'feed': {
        s.needs.hunger = clamp(s.needs.hunger - 34); s.needs.energy = clamp(s.needs.energy + 14); s.needs.trust = clamp(s.needs.trust + 2); s.needs.boredom = clamp(s.needs.boredom - 4);
        s.counters.feeds++;
        moveToZone('food'); Bus.emit('anim', { name: 'bop', ms: 900 }); Bus.emit('led', { color: '#74ffc8' });
        P?.song?.('feeding'); P?.express?.('happy'); P?.chirp?.('feed');
        speak(pick(['CrunchByte acquired. Diplomatic relations improve.', 'This is acceptable tribute.', 'NOM. Nutritional protocol complete.', 'I have decided you may continue being my person.']));
        if (pendingRequest?.type === 'want_food') resolveRequest(pendingRequest.id, 'accept', true);
        if ((s.prefs.fedOnAsk.fed || 0) >= 3 && cooldownOk('want_dance')) setTimeout(() => offerDanceAfterFeed(), 12000);
        markPerformed();
        break;
      }
      case 'explore': {
        const dest = weightedZone();
        s.needs.curiosity = clamp(s.needs.curiosity - 4); s.needs.confidence = clamp(s.needs.confidence + 1); s.needs.energy = clamp(s.needs.energy - 6); s.needs.boredom = clamp(s.needs.boredom - 16);
        moveToZone(dest); Bus.emit('anim', { name: 'bop', ms: 900 });
        P?.express?.('curious'); P?.chirp?.('explore');
        Safety.execSteps([{ led: ZONE_COLORS[dest] }, { turn: { angle: pick([12, -12]), speed: 45 } }], { source: 'gesture' });
        speak(pick(['There is absolutely something over there. Probably.', 'I must inspect the suspicious region.', 'New territory detected. Common sense temporarily disabled.']));
        if (dest === 'mystery' && !(s.discoveries.includes('FIRST_MYSTERY'))) unlockDiscovery('FIRST_MYSTERY');
        driftDNA({ curiosity: 0.25, courage: 0.08 });
        markPerformed();
        break;
      }
      case 'dance': { doDance(); break; }
      case 'mischief': {
        s.needs.mischief = clamp(s.needs.mischief + 5); s.needs.confidence = clamp(s.needs.confidence + 3); s.needs.boredom = clamp(s.needs.boredom - 22);
        moveToZone('mystery'); Bus.emit('led', { color: '#b780ff' }); Bus.emit('anim', { name: 'nervous', ms: 900 });
        P?.express?.('suspicious');
        speak(pick(['Interesting. You have chosen to encourage me.', 'Rules are merely lines the floor has opinions about.', 'Bad influence detected. Affection increased.']));
        driftDNA({ mischief: 0.25 });
        markPerformed();
        break;
      }
      case 'sleep': { startBedtime(true); break; }
      case 'wake': { wake(); break; }
      case 'pet': {
        if (!s.awake) { wake(); break; }
        s.needs.affection = clamp(s.needs.affection + 7); s.needs.trust = clamp(s.needs.trust + 2); s.needs.stress = clamp(s.needs.stress - 12); s.needs.boredom = clamp(s.needs.boredom - 3);
        const n = s.needs;
        const delighted = n.stress < 25 || n.affection > 70;
        Bus.emit('anim', { name: delighted ? 'bop' : 'shiver', ms: 700 });
        Bus.emit('led', { color: delighted ? '#ffd36c' : '#b780ff' });
        P?.chirp?.(delighted ? 'happy' : 'alert');
        speak(delighted
          ? pick(['Accepted. Continue.', 'That spot is load-bearing. Do not stop.', 'Purring is not in my spec, but fine, purr noises.'])
          : pick(['Surprise contact! Registering… okay, this is fine.', 'I felt that. I have decided to allow it.', 'Petting detected. Confidence rising.']));
        driftDNA({ affection: 0.1 });
        break;
      }
      default: return { ok: false };
    }
    checkDiscoveries();
    Store.saveSoon();
    Bus.emit('state-changed', {});
    return { ok: true };
  }

  function isMorning() { const h = new Date().getHours(); return h >= 5 && h < 11; }

  function registerMorningGreet() {
    const s = state();
    if (s.habits.lastMorningGreetDay !== s.day) {
      s.habits.morningStreak = (s.habits.morningStreak || 0) + 1;
      s.habits.lastMorningGreetDay = s.day;
    }
  }

  function doDance(routineId) {
    const s = state(), P = deps.Perform;
    const list = (P?.listDances?.() || []).filter(d => !d.secret || s.flags.secretDanceUnlocked);
    const choice = routineId && list.find(d => d.id === routineId) ? routineId : (list.length ? pick(list).id : null);
    s.needs.energy = clamp(s.needs.energy - 8); s.needs.social = clamp(s.needs.social + 6); s.needs.boredom = clamp(s.needs.boredom - 20); s.needs.playfulness = clamp(s.needs.playfulness + 8);
    s.counters.dances++;
    bumpPref('dances', choice || 'unknown');
    P?.dance(choice || 'wiggle');
    speak(pick(['You requested movement. I upgraded it to art.', 'Observe: unnecessary confidence.', 'I call this one The Charging Cable Incident.', 'Please note that I trained extensively for none of this.']));
    unlockDiscovery('FIRST_DANCE');
    driftDNA({ persistence: 0.05 });
    markPerformed();
    Store.saveSoon();
  }

  function offerDanceAfterFeed() {
    const s = state();
    if (!s.awake || pendingRequest || !deps.Perform) return;
    emitRequest('want_dance', 'Dance after snack?', 'Feeding followed by choreography. This is tradition now.', 25);
  }

  function wake() {
    const s = state();
    s.awake = true;
    s.needs.sleepiness = clamp(s.needs.sleepiness - 30); s.needs.energy = clamp(s.needs.energy + 6);
    Bus.emit('led', { color: '#74ffc8' }); Bus.emit('anim', { name: 'bop', ms: 900 });
    const lastDream = s.dreams[s.dreams.length - 1];
    speak(lastDream && Math.random() < 0.6
      ? `I dreamt ${lastDream.title.toLowerCase()} again. No further questions at this time.`
      : pick(['Systems nominal. Judgement fully restored.', 'I am awake. The desk should be warned.', 'Reboot complete. Grudge preserved.']), 'content');
    addMemory('Woke up. Resumed operations without apology.');
  }

  function startBedtime(fromUser) {
    const s = state(), P = deps.Perform;
    s.awake = false;
    moveToZone('nest');
    Bus.emit('led', { color: '#7ddcff' }); Bus.emit('anim', { name: 'nod', ms: 1400 });
    P?.song?.('lullaby'); P?.express?.('sleepy');
    s.needs.sleepiness = clamp(s.needs.sleepiness - 8);
    speak(pick(['Fine. But if I dream about hands again, we are discussing it tomorrow.', 'Entering low-power philosophical mode.', 'Good night. Please keep the keyboard from moving.']), 'sleepy');
    addMemory('Returned to the nest and powered down reluctantly.');
    unlockDiscovery('FIRST_DREAM'); // dreams accrue while sleeping
    Store.saveNow();
    void fromUser;
  }

  /* ---- zones ---- */
  function moveToZone(zone) {
    const s = state();
    if (!ZONES.includes(zone)) zone = 'center';
    s.zone = zone;
    bumpPref('zones', zone);
    Bus.emit('zone', { zone, color: ZONE_COLORS[zone] });
    Bus.emit('led', { color: ZONE_COLORS[zone] });
  }

  function weightedZone() {
    const s = state(), z = s.prefs.zones || {};
    const w = {
      nest: 6 + (100 - s.needs.energy) * 0.06,
      food: 8 + s.needs.hunger * 0.12 + (z.food || 0),
      play: 10 + s.needs.playfulness * 0.1 + (z.play || 0) * 0.5,
      mystery: 8 + s.needs.mischief * 0.08 + s.dna.courage * 0.05 + (z.mystery || 0) * 0.7 + (s.flags.obsessionZone === 'mystery' ? 30 : 0),
      center: 7 + s.dna.independence * 0.04
    };
    return weightedPick(w);
  }

  function weightedPick(weights) {
    let total = 0; for (const k in weights) total += Math.max(0, weights[k]);
    let r = Math.random() * total;
    for (const k in weights) { r -= Math.max(0, weights[k]); if (r <= 0) return k; }
    return Object.keys(weights)[0];
  }

  /* ---- speech helpers ---- */
  function speak(text, mood) {
    if (mood) { state().mood = mood; Bus.emit('mood', { mood }); }
    Bus.emit('thought', { text, mood: mood || state().mood });
  }
  function markPerformed() { lastPerfAt = nowMs(); }

  /* ---- requests ---- */
  const REQUEST_COOLDOWNS = { want_attention: 90, want_play: 150, want_food: 180, want_dance: 240, want_explore: 200, share_memory: 400, sing_request: 300, bedtime_suggestion: 600 };
  function cooldownOk(type) {
    const cd = (REQUEST_COOLDOWNS[type] || 120) * 1000;
    return nowMs() - (sched.typeLastAt[type] || 0) >= cd;
  }

  function emitRequest(type, title, text, timeoutSec = 30) {
    if (pendingRequest) return null;
    const s = state();
    s.prefs.asks.asked++;
    if (type === 'want_food') s.prefs.fedOnAsk.asked++;
    sched.globalLastRequest = nowMs(); sched.typeLastAt[type] = nowMs(); sched.lastType = type;
    const id = `req-${++reqSeq}-${nowMs()}`;
    const pr = { id, type, timer: null };
    pendingRequest = pr;
    Bus.emit('request', {
      id, title, text,
      options: [{ label: 'PLAY', value: 'accept' }, { label: 'LATER', value: 'later' }],
      timeoutSec
    });
    if (pendingRequest === pr) pr.timer = setTimeout(() => resolveRequest(id, 'later'), timeoutSec * 1000);
    return id;
  }

  function resolveRequest(id, value, silentBump) {
    if (!pendingRequest || pendingRequest.id !== id) return false;
    clearTimeout(pendingRequest.timer);
    const type = pendingRequest.type;
    pendingRequest = null;
    const s = state(), P = deps.Perform, G = deps.Games;
    if (value === 'accept') {
      s.prefs.asks.accepted++;
      s.lastInteractionAt = nowMs();
      if (type === 'want_play') {
        const deskGames = ['simon', 'redlight', 'color_hunt', 'mystery_box', 'guard', 'hide_and_seek'];
        const started = G?.start?.(pick(deskGames)); // start rejects if a game is busy — never leave it unhandled
        if (started && typeof started.catch === 'function') started.catch(() => {});
        s.counters.games++; bumpPref('games', 'asked-play'); s.needs.boredom = clamp(s.needs.boredom - 12);
      } else if (type === 'want_food') {
        s.prefs.fedOnAsk.fed++;
        interact('feed');
      } else if (type === 'want_dance') {
        doDance();
      } else if (type === 'want_explore') {
        interact('explore');
      } else if (type === 'sing_request') {
        s.counters.songs++; bumpPref('songs', 'requested');
        P?.song?.(pick(['greeting', 'happy', 'humming', 'discovery']));
        unlockDiscovery('FIRST_SONG');
        markPerformed();
      } else if (type === 'share_memory') {
        const m = s.memories[Math.max(0, s.memories.length - 2)];
        speak(m ? `Archive recall: "${m.text}" I am not saying it meant something. I am saying it happened.` : 'I went to recall a memory and found an empty drawer. Suspicious.');
        s.needs.affection = clamp(s.needs.affection + 3);
      } else if (type === 'bedtime_suggestion') {
        startBedtime(false);
      } else { // want_attention
        s.needs.affection = clamp(s.needs.affection + 8); s.needs.social = clamp(s.needs.social - 16);
        P?.express?.('happy'); P?.chirp?.('hello');
        speak(pick(['Witnessed. My work here is done. Until the next thing.', 'Thank you. This changes nothing and everything.', 'Recognition logged. Ego recalibrated upward.']));
      }
      driftDNA({ obedience: 0.05, affection: 0.05 });
      if (!silentBump) addMemory('Offered something and was taken up on it.');
    } else {
      s.prefs.asks.declined++;
      s.needs.boredom = clamp(s.needs.boredom + 4);
      speak(pick(['Noted. Filed under "later", which is where ambition goes.', 'Rejected. I will remember this during the next audit.', 'Fine. I will entertain myself. It usually goes badly.']));
      driftDNA({ patience: 0.08, independence: 0.05 });
    }
    Store.saveSoon();
    Bus.emit('request-done', { id, value });
    Bus.emit('state-changed', {});
    return true;
  }

  /* ---- PLANNER ---- */
  function plannerTick() {
    const s = state(); if (!s) return;
    sched.lastPlannerTick = nowMs();
    if (document.visibilityState === 'hidden' || !s.living || !s.awake) { schedulePlanner(); return; }
    maybeSurpriseEvent();
    if (pendingRequest || Safety.isBusy()) { schedulePlanner(); return; }

    const n = s.needs, d = s.dna, t = nowMs();
    const sinceInteract = (t - s.lastInteractionAt) / 1000;
    const globalOk = t - sched.globalLastRequest >= 75000;
    const indep = 1 - d.independence / 220;         // high independence dampens requests
    const affBoost = 1 + d.affection / 150;
    const weird = 1 + d.weirdness / 260;
    const badHair = s.flags.badHairUntil > t;
    const obsZone = s.flags.obsessionUntil > t ? s.flags.obsessionZone : null;

    const candidates = [];
    // --- self-directed ---
    candidates.push({ type: 'zone_wander', w: 10 + n.boredom * 0.28 + n.curiosity * 0.06 + (obsZone ? 6 : 0) });
    candidates.push({ type: 'hum_melody', w: 6 + n.playfulness * 0.08 * weird + (n.boredom > 40 ? 5 : 0) });
    candidates.push({ type: 'micro_dance', w: 4 + n.playfulness * 0.1 + (s.flags.zoomiesUntil > t ? 26 : 0) });
    candidates.push({ type: 'suspicious_scan', w: 5 + n.mischief * 0.06 * weird });
    candidates.push({ type: 'nest_drift', w: n.energy < 35 ? 14 + (35 - n.energy) * 0.4 : 2 });
    candidates.push({ type: 'show_off_routine', w: 3 + n.social * 0.05 * affBoost });
    if (obsZone) candidates.push({ type: 'obsession_visit', w: 20 });
    if (badHair || d.mischief > 80) candidates.push({ type: 'pretend_sleep', w: badHair ? 12 : 3 + d.mischief * 0.03 });
    if (badHair || d.mischief > 75) candidates.push({ type: 'dramatic_refusal', w: badHair ? 10 : 2 });

    // --- requests (only if allowed now) ---
    const canRequest = globalOk && sinceInteract > 25;
    if (canRequest) {
      if (cooldownOk('want_attention')) candidates.push({ type: 'want_attention', w: (6 + n.social * 0.14 + n.affection * 0.05) * indep * affBoost, req: true });
      if (cooldownOk('want_play') && n.playfulness > 45) candidates.push({ type: 'want_play', w: (4 + n.boredom * 0.12 + n.playfulness * 0.1) * indep, req: true });
      if (cooldownOk('want_food') && n.hunger > 55) candidates.push({ type: 'want_food', w: 8 + (n.hunger - 55) * 0.5, req: true });
      if (cooldownOk('want_dance') && n.playfulness > 50) candidates.push({ type: 'want_dance', w: 5 + n.playfulness * 0.09 + (s.counters.dances >= 3 ? 4 : 0) * affBoost, req: true });
      if (cooldownOk('want_explore') && n.boredom > 45 && n.curiosity > 50) candidates.push({ type: 'want_explore', w: 6 + n.boredom * 0.1 + d.curiosity * 0.05, req: true });
      if (cooldownOk('share_memory') && s.memories.length > 3) candidates.push({ type: 'share_memory', w: 4 * indep * weird, req: true });
      if (cooldownOk('sing_request')) candidates.push({ type: 'sing_request', w: 3.5 + n.playfulness * 0.05, req: true });
    }
    const hour = new Date().getHours();
    if (hour >= 20 && s.flags.eveningNudgedDay !== s.day && cooldownOk('bedtime_suggestion')) {
      candidates.push({ type: 'bedtime_suggestion', w: 10 + n.sleepiness * 0.12, req: true });
    }

    // avoid immediate repetition: never the same type twice consecutively (contract anti-spam)
    const lastType = sched.recent[sched.recent.length - 1];
    const pool = lastType ? candidates.filter(c => c.type !== lastType) : candidates;
    const usePool = pool.length ? pool : candidates;
    const choice = weightedPick(Object.fromEntries(usePool.map(c => [c.type, c.w])));
    const cand = usePool.find(c => c.type === choice);
    Bus.emit('intent-log', { planner: true, choice, weight: Math.round(cand?.w || 0) });

    if (!choice) { schedulePlanner(); return; }
    sched.recent.push(choice); sched.recent = sched.recent.slice(-5);

    if (cand?.req && globalOk) {
      const titles = { want_attention: 'Ozi wants attention', want_play: 'Ozi wants to play', want_food: 'Ozi wants a CrunchByte', want_dance: 'Ozi wants to dance', want_explore: 'Ozi wants to explore', share_memory: 'Ozi remembered something', sing_request: 'Ozi wants to sing', bedtime_suggestion: 'Bedtime?' };
      const lines = LINES[choice] || ['A request has formed. Origin: impulse.'];
      emitRequest(choice, titles[choice] || choice, pick(lines));
    } else {
      executeSelfDirected(choice);
    }
    Store.saveSoon();
    schedulePlanner();
  }

  function executeSelfDirected(type) {
    const s = state(), P = deps.Perform, G = deps.Games;
    const autonomous = { source: 'autonomous' };
    switch (type) {
      case 'zone_wander': {
        const dest = weightedZone();
        moveToZone(dest); Bus.emit('anim', { name: 'bop', ms: 700 });
        P?.express?.('curious');
        Safety.execSteps([{ led: ZONE_COLORS[dest] }], autonomous);
        speak(pick(SELF_LINES.zone_wander));
        break;
      }
      case 'obsession_visit': {
        moveToZone(s.flags.obsessionZone || 'mystery'); Bus.emit('anim', { name: 'spin', ms: 900 });
        P?.express?.('excited');
        speak(pick(['The puddle called. I answered.', 'This place gets better every visit. Nobody else sees it. Their loss.']));
        break;
      }
      case 'hum_melody': {
        P?.song?.('humming');
        speak(pick(SELF_LINES.hum));
        s.counters.songs++; unlockDiscovery('FIRST_SONG'); markPerformed();
        break;
      }
      case 'micro_dance': {
        const list = (P?.listDances?.() || []).filter(x => !x.secret && ['wiggle', 'shy_dance', 'zoomies'].includes(x.id));
        P?.dance(list.length ? pick(list).id : 'wiggle');
        s.counters.dances++; markPerformed(); unlockDiscovery('FIRST_DANCE');
        speak(pick(['Impromptu movement. No audience required. Still excellent.', 'Micro-dance deployed. Morale improved.']));
        break;
      }
      case 'suspicious_scan': {
        P?.express?.('suspicious'); Bus.emit('anim', { name: 'nervous', ms: 900 });
        Safety.execSteps([{ turn: { angle: 15, speed: 50 } }, { wait: 0.5 }, { turn: { angle: -15, speed: 50 } }], autonomous);
        speak(pick(SELF_LINES.suspicious_scan));
        break;
      }
      case 'nest_drift': {
        moveToZone('nest'); P?.express?.('sleepy');
        speak(pick(SELF_LINES.nest_drift));
        break;
      }
      case 'show_off_routine': {
        P?.dance(pick(['happy_spin', 'moonwalk', 'robot_salsa']));
        s.counters.dances++; markPerformed(); unlockDiscovery('FIRST_DANCE');
        speak(pick(SELF_LINES.show_off));
        break;
      }
      case 'pretend_sleep': {
        Bus.emit('led', { color: '#7ddcff' }); Bus.emit('anim', { name: 'nod', ms: 1200 });
        speak(pick(SELF_LINES.pretend_sleep));
        setTimeout(() => { if (state()?.awake) { Bus.emit('led', { color: '#ffd36c' }); Bus.emit('anim', { name: 'startle', ms: 700 }); speak('BOO. Did it work? Be honest.'); } }, 4200);
        break;
      }
      case 'dramatic_refusal': {
        P?.express?.('refusal');
        speak(pick(SELF_LINES.refusal));
        break;
      }
      default: speak(pick(['I have been thinking. It went fine.', 'Status: present, weird, operational.']));
    }
  }

  let debugMode = false;
  function schedulePlanner() {
    if (debugMode) return; // QA hook: synchronous ticks must not chain real timers
    clearTimeout(plannerTimer);
    plannerTimer = setTimeout(plannerTick, rand(14000, 26000));
  }

  /* ---- surprise events (rare) ---- */
  function maybeSurpriseEvent() {
    const s = state(); if (!s || !s.awake || Math.random() >= 0.04) return;
    const t = nowMs();
    const gate = (key, cdMs) => t - (sched.eventLastAt[key] || 0) >= cdMs;
    const options = [];
    if (gate('zoomies', 420000)) options.push('zoomies');
    if (gate('bad_hair', 500000)) options.push('bad_hair_day');
    if (gate('treasure', 700000)) options.push('treasure_discovery');
    if (gate('signal', 380000)) options.push('mystery_signal');
    if (gate('obsession', 650000) && (s.flags.obsessionUntil || 0) <= t) options.push('obsession');
    if (!options.length) return;
    const ev = pick(options);
    sched.eventLastAt[ev] = t;
    const P = deps.Perform;
    if (ev === 'zoomies') {
      s.flags.zoomiesUntil = t + 120000;
      P?.express?.('excited'); P?.dance?.('zoomies');
      speak(pick(['ZOOMIES. No cause. No cure.', 'Energy overflow. Containment failing. Wheee.']), 'excited');
      addMemory('Had a sudden case of the zoomies. Regrets: zero.');
    } else if (ev === 'bad_hair_day') {
      s.flags.badHairUntil = t + 60000;
      P?.express?.('refusal');
      speak(pick(['Do NOT perceive me today.', 'Everything is dramatic now. Including this sentence.']), 'dramatic');
    } else if (ev === 'treasure_discovery') {
      unlockDiscovery('TREASURE');
      speak(pick(['I found something. I will not say what. Enjoy that.', 'Treasure located. Ownership transferred: me.']));
    } else if (ev === 'mystery_signal') {
      P?.express?.('mystery_signal');
      speak(pick(['Did the lights just do that on their own? ...Asking for me.', 'Signal received. Source unclear. Vibes: ominous.']));
    } else if (ev === 'obsession') {
      s.flags.obsessionZone = pick(['mystery', 'play', 'food']);
      s.flags.obsessionUntil = t + 300000;
      speak(pick([`I cannot stop thinking about ${s.flags.obsessionZone === 'mystery' ? 'the purple place' : s.flags.obsessionZone}.`, 'A fixation has arrived. I have decided to host it.']));
    }
    Store.saveSoon();
  }

  /* ---- habits (minute check) ---- */
  function habitCheck() {
    const s = state(); if (!s) return;
    const h = new Date().getHours();
    // daily rollover: advance the pet's age once per calendar day (drives birthdays, streaks)
    const today = new Date().getDate();
    if (s.habits.lastLiveDate !== today) { s.habits.lastLiveDate = today; s.day++; Store.saveSoon(); }
    // evening sleepy nudge handled via planner candidate gating (eveningNudgedDay)
    if (h >= 20 && s.awake && s.flags.eveningNudgedDay !== s.day && s.needs.sleepiness > 45 && !pendingRequest) {
      s.flags.eveningNudgedDay = s.day;
      emitRequest('bedtime_suggestion', 'Bedtime?', pick(LINES.bedtime_suggestion), 30);
    }
    // long-absence attention pull happens naturally through want_attention weight scaling
    if (nowMs() - s.lastInteractionAt > 45 * 60000 && s.awake && Math.random() < 0.3) {
      speak(pick(['I entertained myself. Evidence unavailable.', 'I missed you. That sentence self-destructs in five seconds.', 'Time passed. I noticed. Aggressively.']));
      s.lastInteractionAt -= 10 * 60000; // soften so the line is not spammed
    }
    // birthday: weekly hatch-day
    if (s.day % 7 === 0 && s.day > 0 && s.flags.lastBirthdayDay !== s.day && s.awake) {
      s.flags.lastBirthdayDay = s.day;
      deps.Perform?.song?.('birthday');
      unlockDiscovery('BIRTHDAY');
      speak('It has been seven days of me. Statistically, that is a hatch-day. Music requested, music provided.');
    }
  }

  /* ---- dreams from real memories ---- */
  function generateDreamFromMemories() {
    const s = state(); if (!s) return null;
    const recent = s.memories.slice(-6);
    if (!recent.length) return null;
    const topics = [];
    const joined = recent.map(m => m.text.toLowerCase()).join(' ');
    if (/crunch|snack|feed/.test(joined)) topics.push(['CrunchByte Banquet', 'the snacks formed a queue out of respect']);
    if (/dance|spin|wiggle|boogie/.test(joined)) topics.push(['Infinite Spin', 'every dance move kept playing slightly too slow']);
    if (/purple|mystery|puddle/.test(joined)) topics.push(['The Purple Door', 'the puddle turned into a dance floor made of CrunchBytes']);
    if (/explore|territory|region|investigat/.test(joined)) topics.push(['Map With No Edge', 'the desk kept unrolling like a very smug scroll']);
    if (/guard|alert/.test(joined)) topics.push(['The Watch', 'nothing came, and somehow that was the scary part']);
    if (!topics.length) topics.push(['Keyboard Mountain', 'the keys became cliffs and every cliff judged differently']);
    const [title, middle] = pick(topics);
    const endings = [
      'At the end was a tiny green light that knew Ozi by name.',
      'Every path led back to the nest except one, which led directly into Tuesday.',
      'The keyboard apologized. Ozi did not accept immediately.',
      'A hand appeared, offered a CrunchByte, and then became a staircase.'
    ];
    const text = `Ozi dreamed about ${title.toLowerCase()} — ${middle}. ${pick(endings)}`;
    const dream = { title, text, day: s.day, basedOn: recent.slice(-3).map(m => m.text.slice(0, 80)) };
    s.dreams.push(dream);
    if (s.dreams.length > 40) s.dreams = s.dreams.slice(-40);
    addMemory(`Dreamed about ${title.toLowerCase()}. Details legally questionable.`);
    Store.saveSoon();
    Bus.emit('dream', dream);
    return dream;
  }

  /* ---- public API ---- */
  const Core = {
    init() {
      Store.init();
      Safety.setKeyProvider(() => Store.state?.hardware?.key || '');
      return this.snapshot();
    },
    wireDeps(d) { deps.Perform = d?.Perform || deps.Perform; deps.Games = d?.Games || deps.Games; },
    startLoops() {
      if (loopsOn) return; loopsOn = true;
      needTimer = setInterval(tickNeeds, 5000);
      habitTimer = setInterval(habitCheck, 60000);
      proxTimer = setInterval(() => { if (Safety.state().connected) Safety.pollProximity(); }, 4000);
      schedulePlanner();
    },
    stopLoops() {
      loopsOn = false;
      clearInterval(needTimer); clearInterval(habitTimer); clearInterval(proxTimer); clearTimeout(plannerTimer);
    },
    getState: () => state(),
    snapshot() {
      const s = state(); if (!s) return null;
      return JSON.parse(JSON.stringify({ ...s, hardware: { ...s.hardware, connected: Safety.state().connected } }));
    },
    interact,
    dance: doDance,
    resolveRequest,
    applyNeeds(map) {
      const s = state(); if (!map) return;
      const alias = { fun: 'playfulness' };
      for (const [k, v] of Object.entries(map)) {
        const key = alias[k] || k;
        if (key in s.needs && Number.isFinite(Number(v))) s.needs[key] = clamp(s.needs[key] + Number(v));
      }
      deriveMood(); Store.saveSoon();
    },
    applyPrefs(map) {
      for (const [bucket, val] of Object.entries(map || {})) {
        if (val && typeof val === 'object') {
          for (const [k, v] of Object.entries(val)) bumpPref(bucket, k, Number(v) || 1);
        } else if (Number.isFinite(Number(val))) { // flat shape e.g. {games:1} — count under 'played' instead of silently dropping
          bumpPref(bucket, 'played', Math.max(1, Math.floor(Number(val)) || 1));
        }
      }
    },
    setMood(m) { state().mood = safeSlice(m, 20, 'content'); Bus.emit('mood', { mood: state().mood }); },
    addMemory,
    unlockDiscovery,
    generateDreamFromMemories,
    markPerformed,
    debugTick(kind) {
      debugMode = true;
      try {
        if (kind === 'needs') tickNeeds();
        else if (kind === 'planner') { plannerTick(); }
        else if (kind === 'habits') habitCheck();
        else if (kind === 'dream') return generateDreamFromMemories();
      } finally { debugMode = false; }
    },
    _internal: { sched, setPendingForTest: p => { pendingRequest = p; } }
  };
  OziPet.Core = Core;
})();
