/* OzoPet app glue — wires the behavior engine (pet/*.js) into the zine UI.
   The engine owns state, needs, planner, memories, safety and hardware.
   This file owns DOM: rendering, modals, request cards, arcade stage,
   dance deck, songbook, floor-adventure panel, emergency stop. */
(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const clamp = (n, min = 0, max = 100) => Math.min(max, Math.max(min, n));
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const escapeHTML = (str = '') => String(str).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

  const OP = window.OziPet || {};
  const ENGINE = !!(OP.Bus && OP.Core && OP.Safety);
  const Bus = OP.Bus;
  let snap = null;

  const zones = {
    nest: { x: 20, y: 72, color: '#7ddcff', surface: 'blue/home' },
    food: { x: 23, y: 30, color: '#74ffc8', surface: 'green/snack' },
    play: { x: 76, y: 28, color: '#ffd36c', surface: 'yellow/play' },
    mystery: { x: 76, y: 70, color: '#b780ff', surface: 'purple/unknown' },
    center: { x: 50, y: 52, color: '#74ffc8', surface: 'unclassified' }
  };
  const zoneLabel = z => ({ nest: 'nest edge', food: 'crunchbyte grove', play: 'play halo', mystery: 'mystery puddle', center: 'open desk' })[z] || z;
  const getColor = name => ({ mint: '#74ffc8', violet: '#b780ff', amber: '#ffd36c', red: '#ff667c', blue: '#7ddcff', cyan: '#4bd69d' })[name] || '#74ffc8';

  /* ================= toasts ================= */
  function toast(title, text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<b>${escapeHTML(title)}</b><p>${escapeHTML(text)}</p>`;
    $('#toastStack').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(12px)'; }, 3600);
    setTimeout(() => el.remove(), 4100);
  }

  /* ================= creature visuals ================= */
  let popTimer = null;
  let recentThought = null;
  function showThought(text) {
    if (!$('#ambientText')) return;
    recentThought = text;
    $('#ambientText').textContent = text;
    $('#mindText').textContent = text;
    const pop = $('#thoughtPop');
    pop.textContent = pick(['?', '!', '✦', '…', '♥']);
    pop.classList.add('show');
    clearTimeout(popTimer);
    popTimer = setTimeout(() => pop.classList.remove('show'), 1100);
  }
  function setLed(color) {
    $('#ozi').style.setProperty('--led', color);
    $('#habitatMoodDot').style.background = color;
    $('#habitatMoodDot').style.boxShadow = `0 0 10px ${color}`;
  }
  const animTimers = {};
  const ANIM_CLASS = { bop: 'bop', spin: 'spin', nervous: 'nervous', wiggle: 'ozi-wiggle', shiver: 'ozi-shiver', nod: 'ozi-nod', startle: 'ozi-startle' };
  function animate(name, duration = 900) {
    const cls = ANIM_CLASS[name] || 'bop';
    const el = $('#ozi');
    clearTimeout(animTimers[cls]);
    el.classList.remove('bop', 'spin', 'nervous', 'ozi-wiggle', 'ozi-shiver', 'ozi-nod', 'ozi-startle');
    void el.offsetWidth;
    el.classList.add(cls);
    animTimers[cls] = setTimeout(() => el.classList.remove(cls), duration);
  }
  function moveVisuals(zoneName) {
    const z = zones[zoneName] || zones.center;
    $('#ozi').style.left = `${z.x}%`;
    $('#ozi').style.top = `${z.y}%`;
    $('#petShadow').style.left = `${z.x}%`;
    $('#petShadow').style.top = `${z.y + 9}%`;
    $('#zoneReadout').textContent = zoneLabel(zoneName);
    $('#surfaceReadout').textContent = z.surface;
    for (let i = 0; i < 6; i++) {
      const dot = document.createElement('i');
      dot.style.left = `${clamp(z.x + (Math.random() - .5) * 10, 4, 96)}%`;
      dot.style.top = `${clamp(z.y + (Math.random() - .5) * 8, 4, 94)}%`;
      $('#trail').appendChild(dot);
      setTimeout(() => dot.remove(), 3100);
    }
  }

  /* ================= rendering from engine snapshot ================= */
  const bondLabel = n => n >= 92 ? 'trusted person' : n >= 82 ? 'chosen human' : n >= 70 ? 'growing bond' : n >= 55 ? 'new friend' : 'under review';
  const relationshipThought = t => t > 90 ? 'Ozi expects you to return, bring interesting things, and prevent obviously bad desk decisions.'
    : t > 78 ? 'Ozi trusts you enough to be annoying on purpose.'
    : t > 65 ? 'Ozi is beginning to associate you with snacks, safety and entertainment.'
    : 'Ozi is still deciding what kind of human you are.';
  const archetype = d => d.mischief > 82 && d.curiosity > 80 ? 'curious trickster'
    : d.affection > 82 && d.courage > 70 ? 'loyal guardian'
    : d.independence > 82 && d.curiosity > 75 ? 'wild explorer'
    : d.persistence > 80 && d.patience > 65 ? 'patient scout'
    : 'odd little companion';
  const dnaCode = d => [d.curiosity, d.mischief, d.weirdness].map(n => Math.round(n).toString(16).toUpperCase().padStart(2, '0')).join('-');
  const NEED_KEYS = ['energy', 'hunger', 'affection', 'social', 'curiosity', 'boredom', 'confidence', 'trust', 'mischief', 'sleepiness', 'playfulness', 'stress'];

  let weatherCache = { key: null, value: '' };
  function habitatWeather(s) {
    const key = !s.awake ? 'asleep' : `${s.mood}:${s.needs.boredom > 70}:${s.needs.energy < 30}`;
    if (weatherCache.key !== key) {
      weatherCache = { key, value: !s.awake ? pick(['dreaming quietly']) : s.needs.boredom > 70 ? ['dangerously bored'] : s.needs.energy < 30 ? ['sleepy static'] : pick(['softly curious', 'mossy and alert', 'mildly suspicious', 'pleasantly weird']) };
    }
    return weatherCache.value;
  }

  function renderAll() {
    snap = ENGINE ? OP.Core.snapshot() : null;
    if (!snap) return;
    $('#dayCount').textContent = String(snap.day).padStart(3, '0');
    $('#petName').textContent = snap.name.toUpperCase();
    $('#moodWord').textContent = snap.mood;
    $('#livingLabel').textContent = snap.living ? 'living mode' : 'quiet mode';
    $('.pulse-dot').style.opacity = snap.living ? '1' : '.28';
    $('#trustScore').textContent = Math.round(snap.needs.trust);
    $('#bondRing').style.setProperty('--bond', `${snap.needs.trust}%`);
    $('#bondLabel').textContent = bondLabel(snap.needs.trust);
    $('#relationshipThought').textContent = relationshipThought(snap.needs.trust);
    $('#archetype').textContent = archetype(snap.dna);
    $('#dnaTag').textContent = `DNA // ${dnaCode(snap.dna)}`;
    $('#habitatWeather').textContent = habitatWeather(snap);
    if (!recentThought) $('#mindText').textContent = defaultMindLine(snap);
    $('#zoneReadout').textContent = zoneLabel(snap.zone);
    $('#bodyReadout').textContent = connected ? 'real Evo' : 'simulation';
    $('#hardwareLabel').textContent = connected ? 'evo body attached' : 'simulated body';
    $('#hardwareDot').classList.toggle('connected', connected);
    renderFooter();
    renderMeters();
    renderMemories();
    renderTags();
    renderDNA();
    renderDreams();
    renderConnection();
    renderFloorPanel();
  }

  function defaultMindLine(s) {
    if (!s.awake) return 'The desk is gone. There is only Keyboard Mountain now.';
    if (s.needs.boredom > 70) return 'I require stimulation before I invent something worse.';
    if (s.needs.hunger > 70) return 'The hunger has started filing paperwork.';
    if (s.needs.sleepiness > 75) return 'I am awake in the technical sense only.';
    return pick(['I am considering a small journey with unreasonable confidence.', 'The desk is quiet. I do not trust this.', 'Status: present, weird, operational.']);
  }

  function renderFooter() {
    const mode = OP.Safety?.state?.().mode || 'desk';
    const suffix = connected
      ? (mode === 'floor' ? '// FLOOR ADVENTURE // supervised' : '// desk mode // motors locked')
      : '// no hardware commands sent';
    $('#footerStatus').textContent = (snap.awake ? 'awake ' : 'asleep ') + (connected ? 'hardware bridge connected ' : 'simulation ') + suffix;
  }

  function renderMeters() {
    $('#meterList').innerHTML = NEED_KEYS.map(key => `
      <div class="meter-row">
        <label>${key}</label>
        <div class="meter-track"><div class="meter-fill" style="width:${snap.needs[key]}%"></div></div>
        <output>${Math.round(snap.needs[key])}</output>
      </div>`).join('');
  }

  function renderMemories() {
    const items = snap.memories.slice(-8).reverse();
    $('#memoryFeed').innerHTML = items.length ? items.map((m, i) => `
      <div class="memory-item kind-${escapeHTML(m.kind || 'moment')}">
        <div class="memory-index">${String(snap.memories.length - i).padStart(2, '0')}</div>
        <div><p>${escapeHTML(m.text)}</p><time>${escapeHTML(m.at)}</time></div>
      </div>`).join('') : '<div class="memory-item"><div class="memory-index">--</div><div><p>No memories. This is either peaceful or alarming.</p></div></div>';
  }

  function renderTags() {
    const tags = [snap.mood, zoneLabel(snap.zone), snap.needs.boredom > 65 ? 'restless' : 'occupied', snap.needs.mischief > 78 ? 'bad ideas' : 'mostly lawful'];
    $('#mindTags').innerHTML = tags.map(t => `<span>${escapeHTML(t)}</span>`).join('');
  }

  function renderDNA() {
    const explain = { curiosity: 'pull toward novelty', courage: 'approach unknown things', affection: 'seek friendly contact', independence: 'act without asking', mischief: 'prefer interesting mistakes', patience: 'wait before acting', obedience: 'follow direct requests', persistence: 'try again after failure', weirdness: 'choose delightfully odd options' };
    $('#dnaGrid').innerHTML = Object.entries(snap.dna)
      .filter(([k]) => Object.prototype.hasOwnProperty.call(explain, k))
      .map(([k, v]) => {
        const shown = clamp(Math.round(Number(v)));
        return `<div class="dna-item"><div class="dna-item-head"><span>${escapeHTML(k)}</span><strong>${shown}</strong></div><div class="meter-track"><div class="meter-fill" style="width:${shown}%"></div></div><p>${explain[k]}</p></div>`;
      }).join('');
    const d = snap.dna;
    $('#traitCombo').innerHTML = `<b>${escapeHTML(archetype(d).toUpperCase())}</b><br>High curiosity (${Math.round(d.curiosity)}) and mischief (${Math.round(d.mischief)}) steer choices. Courage (${Math.round(d.courage)}) decides whether unknown zones get visited. Weirdness (${Math.round(d.weirdness)}) keeps odd behavior in rotation.`;
  }

  function renderDreams() {
    const dreams = snap.dreams.length ? snap.dreams : [{ title: 'No dreams yet', text: 'Put Ozi to bed, then come back here.', day: snap.day }];
    const latest = dreams[dreams.length - 1];
    $('#dreamFeature').innerHTML = `<h3>${escapeHTML(latest.title)}</h3><p>${escapeHTML(latest.text)}</p>`;
    $('#dreamList').innerHTML = dreams.slice().reverse().map((d, i) =>
      `<button class="dream-thumb" data-dream-index="${dreams.length - 1 - i}"><b>DAY ${String(d.day || 0).padStart(3, '0')} // ${escapeHTML(d.title)}</b><small>${escapeHTML(d.text.slice(0, 70))}${d.text.length > 70 ? '…' : ''}</small></button>`).join('');
    $$('[data-dream-index]').forEach(btn => btn.addEventListener('click', () => {
      const d = snap.dreams[Number(btn.dataset.dreamIndex)];
      if (d) $('#dreamFeature').innerHTML = `<h3>${escapeHTML(d.title)}</h3><p>${escapeHTML(d.text)}</p>`;
    }));
  }

  function renderConnection() {
    $('#connectionOrb').classList.toggle('connected', connected);
    $('#connectionTitle').textContent = connected ? 'Real Evo body attached' : 'No body attached';
    $('#connectionDetail').textContent = connected ? 'The local bridge answered. Safe movement, LED, tone and surface-color tests are enabled.' : 'Start the bridge, paste its one-time key, then connect.';
    if (snap.hardware.key && !$('#bridgeKey').value) $('#bridgeKey').value = snap.hardware.key;
  }

  /* ================= request cards ================= */
  let requestHideTimer = null;
  function showRequestCard(r) {
    const card = $('#oziRequestCard');
    card.innerHTML = '';
    const b = document.createElement('b'); b.textContent = r.title || 'Ozi wants something';
    const p = document.createElement('p'); p.textContent = r.text || '';
    const row = document.createElement('div'); row.className = 'request-actions';
    (r.options || [{ label: 'PLAY', value: 'accept' }, { label: 'LATER', value: 'later' }]).forEach(opt => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'request-btn'; btn.dataset.value = opt.value; btn.textContent = opt.label;
      btn.addEventListener('click', () => hideRequestCard() || OP.Core.resolveRequest(r.id, opt.value));
      row.appendChild(btn);
    });
    card.append(b, p, row);
    card.hidden = false; card.classList.add('show');
    clearTimeout(requestHideTimer);
    requestHideTimer = setTimeout(hideRequestCard, (r.timeoutSec || 30) * 1000 + 500);
  }
  function hideRequestCard() {
    clearTimeout(requestHideTimer);
    const card = $('#oziRequestCard');
    card.classList.remove('show'); card.hidden = true; card.innerHTML = '';
  }

  /* ================= emergency stop ================= */
  function kidStopReason(reason) {
    const r = String(reason || '').toLowerCase();
    if (!r || r === 'manual') return 'The big red button was pressed.';
    if (r.includes('tab hidden')) return 'Ozi paused because the page was hidden.';
    if (r.includes('timeout') || r.includes('bridge') || r.includes('discover') || r.includes('bluetooth') || r.includes('service')) return 'Ozi lost its robot body connection.';
    if (r.includes('read_color') || r.includes('fail') || r.includes('error')) return 'The robot body had a problem, so Ozi stopped to stay safe.';
    return 'Ozi stopped moving to stay safe.';
  }

  function onEstop(data) {
    OP.Follow?.stop?.();
    stopPreview();
    $('#oziEStop').hidden = true;
    $('#oziEstopBanner').hidden = false;
    $('#oziEstopReason').textContent = data?.reason ? `— ${kidStopReason(data.reason)}` : '— Ozi stopped moving to stay safe.';
    setConnectedUI(false);
    toast('ALL STOPPED', 'Ozi stopped moving. Press START AGAIN when you are ready.');
  }

  /* ================= hardware lab (legacy flow + safety) ================= */
  let connected = false;
  function setConnectedUI(v) {
    connected = v === true;
    if (ENGINE) OP.Safety.setConnected(connected);
    if (snap) { renderAll(); } else { $('#connectionOrb')?.classList.toggle('connected', connected); }
  }

  async function hardwareRequest(path, body = null) {
    const key = ($('#bridgeKey').value || '').trim();
    const headers = { 'Content-Type': 'application/json', 'X-OzoPet-Key': key };
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(`http://127.0.0.1:8787${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, mode: 'cors' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `bridge returned ${res.status}`);
      return data;
    } finally { clearTimeout(timeout); }
  }

  let connectingBridge = false;
  async function connectBridge() {
    if (connectingBridge) return;
    const key = $('#bridgeKey').value.trim();
    if (!key) return toast('Bridge key missing', 'Run bridge/ozopet_bridge.py and paste the key it prints.');
    connectingBridge = true;
    try {
      const health = await hardwareRequest('/health');
      if (!health.ok) throw new Error('bridge health check failed');
      const result = await hardwareRequest('/connect', {});
      setConnectedUI(!!result.connected);
      $('#surfaceReadout').textContent = result.surface || 'waiting';
      toast('Evo body attached', result.robot || 'Ozobot bridge connected.');
      if (connected) {
        await hardwareAction('led', { color: 'mint' }).catch(() => {});
        await hardwareAction('tone', { frequency: 660, duration: .08 }).catch(() => {});
        $('#oziEStop').hidden = false;
      }
    } catch (err) {
      setConnectedUI(false);
      toast('Bridge did not connect', humanError(err));
    } finally { connectingBridge = false; }
  }

  async function disconnectBridge() {
    try { if (connected) await hardwareRequest('/disconnect', {}); } catch {}
    setConnectedUI(false);
    $('#oziEStop').hidden = true;
    toast('Hardware detached', 'Ozi is back in simulation-only mode.');
  }

  async function hardwareAction(action, payload = {}) {
    if (!connected) throw new Error('hardware not connected');
    return hardwareRequest('/action', { action, ...payload });
  }

  function hardwareSoftFail(err) {
    if (!connected) return;
    setConnectedUI(false);
    $('#oziEStop').hidden = true;
    toast('Hardware went quiet', humanError(err));
  }

  function humanError(err) {
    if (err?.name === 'AbortError') return 'The local bridge did not answer in time.';
    if (/fetch/i.test(err?.message || '')) return 'Could not reach http://127.0.0.1:8787. Start the local bridge on this computer first.';
    return err?.message || 'Unknown bridge error.';
  }

  /* ================= floor adventure panel ================= */
  let previewStream = null;
  let followTarget = null;
  try {
    const savedTarget = JSON.parse(localStorage.getItem('ozi-follow-target'));
    if (savedTarget && Number.isFinite(savedTarget.h)) followTarget = savedTarget;
  } catch {}

  function floorState() { return ENGINE ? OP.Safety.state() : { connected: false, mode: 'desk', floorConfirmed: false }; }

  function renderFloorPanel() {
    const st = floorState();
    $('#oziModeDesk').classList.toggle('active', st.mode !== 'floor');
    $('#oziModeFloor').classList.toggle('active', st.mode === 'floor');
    $('#oziFloorConfirm').checked = st.floorConfirmed;
    const armed = st.floorConfirmed && !!OP.Follow?.available?.();
    $$('.follow-btn').forEach(b => b.disabled = !armed);
    $('#oziFollowStatus').textContent = followStatusText(st);
  }

  function followStatusText(st) {
    if (!OP.Follow?.available?.()) return 'camera unavailable in this browser // follow modes disabled';
    if (st.mode !== 'floor' || !st.floorConfirmed) return 'idle // switch to FLOOR and confirm the clear-floor area to arm follow modes.';
    if (followTarget) return `armed // target h≈${Math.round(followTarget.h)}° — start a mode below. STOP button always works.`;
    return 'armed // tap the camera preview on your color card to calibrate, then start a mode below.';
  }

  async function startPreview() {
    if (!navigator.mediaDevices?.getUserMedia) return toast('No camera API', 'This browser cannot provide a camera preview.');
    try {
      stopPreview();
      previewStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 320 } }, audio: false });
      const video = $('#oziCamVideo');
      video.srcObject = previewStream;
      await video.play().catch(() => {});
      $('#oziFollowStatus').textContent = 'preview live // tap the video on the color card you want Ozi to chase.';
    } catch (err) {
      toast('Camera refused', err?.name === 'NotAllowedError' ? 'Permission denied. Allow camera access to use Follow modes.' : 'No usable camera found.');
    }
  }

  function stopPreview() {
    if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); previewStream = null; }
    const video = $('#oziCamVideo');
    if (video) video.srcObject = null;
  }

  function bindCalibrate(el) {
    el.addEventListener('click', ev => {
      const video = $('#oziCamVideo'), canvas = $('#oziCamCanvas');
      if (!video || video.readyState < 2) return toast('No picture yet', 'Click PREVIEW CAMERA and allow access first.');
      const rect = el.getBoundingClientRect();
      const scaleX = (el.videoWidth || canvas.width) / rect.width;
      const scaleY = (el.videoHeight || canvas.height) / rect.height;
      const x = (ev.clientX - rect.left) * scaleX;
      const y = (ev.clientY - rect.top) * scaleY;
      Promise.resolve(OP.Follow.calibrate({ video, canvas, x, y })).then(res => {
        if (res && Number.isFinite(res.h)) {
          followTarget = { h: res.h, s: res.s ?? .8, v: res.v ?? .5 };
          try { localStorage.setItem('ozi-follow-target', JSON.stringify(followTarget)); } catch {}
          $('#oziFollowStatus').textContent = `CALIBRATED // hue ≈ ${res.h}° (${res.count} px sampled). Start a mode below.`;
          toast('Color locked', `Ozi will chase hue ${res.h}°.`);
        } else {
          $('#oziFollowStatus').textContent = 'CALIBRATION FAILED // low-signal region — try a brighter, more saturated card.';
        }
        renderFloorPanel();
      });
    });
  }

  async function startFollowMode(modeName) {
    const st = floorState();
    if (!st.connected) return toast('No real body', 'Connect the bridge before Floor Adventure.');
    if (!OP.Follow.available()) return toast('No camera', 'Follow modes need webcam access.');
    if (!st.floorConfirmed) return toast('Floor not confirmed', 'Switch to FLOOR and tick the clear-floor confirmation first.');
    stopPreview();
    const ok = await OP.Follow.start(modeName, { video: $('#oziCamVideo'), canvas: $('#oziCamCanvas'), targetColor: followTarget });
    if (ok !== false) {
      $('#oziFollowStatus').textContent = `${modeName.toUpperCase()} ACTIVE // huge red STOP button is always live.`;
      try { const s = OP.Core.getState(); s.counters.follows++; if (s.counters.follows === 1) OP.Core.unlockDiscovery('FIRST_FOLLOW'); OP.Store.saveSoon(); } catch {}
    }
  }

  /* ================= dance deck / songbook / arcade ================= */
  const HEARD_KEY = 'ozi-heard-songs';
  function heardSongs() {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(HEARD_KEY)); } catch {}
    if (!Array.isArray(arr)) arr = [];
    const out = arr.filter(x => typeof x === 'string').slice(0, 40);
    for (const d of ['humming', 'greeting']) if (!out.includes(d)) out.push(d);
    return out;
  }
  function markHeard(id) {
    if (!id) return;
    const list = heardSongs();
    if (!list.includes(id)) { list.push(id); try { localStorage.setItem(HEARD_KEY, JSON.stringify(list.slice(-40))); } catch {} }
  }

  function renderDanceDeck() {
    const host = $('#danceDeck');
    if (!host) return;
    const unlocked = !!snap?.flags?.secretDanceUnlocked;
    const dances = (OP.Perform.listDances() || []).filter(d => !d.secret || unlocked);
    host.innerHTML = dances.map(d => `
      <div class="cassette-row" data-dance="${escapeHTML(d.id)}">
        <div class="row-glyph">♪</div>
        <div><span class="row-title">${escapeHTML(d.title)}${d.secret ? ' <small>SECRET</small>' : ''}</span><p class="row-desc">${escapeHTML(d.desc || '')}</p></div>
        <button class="row-play" data-play-dance="${escapeHTML(d.id)}">PLAY</button>
      </div>`).join('');
    $$('[data-play-dance]').forEach(btn => btn.addEventListener('click', () => {
      OP.Core.dance(btn.dataset.playDance);
      $$('.cassette-row').forEach(r => r.classList.toggle('now-playing', r.dataset.dance === btn.dataset.playDance));
    }));
  }

  function renderSongbook() {
    const host = $('#songList');
    if (!host) return;
    const heard = heardSongs();
    host.innerHTML = (OP.Perform.listSongs() || []).map(s => {
      const isHeard = heard.includes(s.id);
      return `<div class="song-row ${isHeard ? 'heard' : 'locked'}" data-song="${escapeHTML(s.id)}">
        <div class="row-glyph">♫</div>
        <div><span class="row-title">${isHeard ? escapeHTML(s.title) : '??? — unheard'}</span><p class="row-desc">${isHeard ? escapeHTML(s.mood || 'original melody') : 'Hear it from Ozi first.'}</p></div>
        ${isHeard ? `<button class="row-play" data-play-song="${escapeHTML(s.id)}">PLAY</button>` : '<span></span>'}
      </div>`;
    }).join('');
    $$('[data-play-song]').forEach(btn => btn.addEventListener('click', () => {
      OP.Perform.song(btn.dataset.playSong);
      markHeard(btn.dataset.playSong);
      $$('.song-row').forEach(r => r.classList.toggle('playing', r.dataset.song === btn.dataset.playSong));
    }));
  }

  function renderArcade() {
    const grid = $('#missionGrid');
    if (!grid) return;
    grid.innerHTML = (OP.Games.listMissions() || []).map(m => `
      <div class="mission-card">
        ${m.needsFloor ? '<span class="floor-stamp">BEST ON FLOOR</span>' : ''}
        <div class="mission-head"><span class="mission-glyph">${escapeHTML(m.glyph || '◆')}</span><b>${escapeHTML(m.title)}</b></div>
        <p>${escapeHTML(m.desc || '')}</p>
        <button class="mission-start" data-mission="${escapeHTML(m.id)}">START</button>
      </div>`).join('');
    $$('[data-mission]').forEach(btn => btn.addEventListener('click', () => launchMission(btn.dataset.mission)));
  }

  function stage(html) { const s = $('#gameStage'); if (s) s.innerHTML = html; }
  const stageLine = (text, cls = '') => `<p class="stage-line ${cls}">${escapeHTML(text)}</p>`;

  function simonGlyph(entry) {
    const colorHex = getColor(entry.color);
    return `<span class="simon-glyph" style="--swatch:${colorHex}">${entry.direction === 'left' ? '◀' : entry.direction === 'right' ? '▶' : '●'}</span>`;
  }

  let padBound = false;
  function showInputPad(round) {
    if (!padBound) {
      $$('.pad-btn').forEach(b => b.addEventListener('click', () => {
        OP.Games.input('simon', b.dataset.pad);
      }));
      padBound = true;
    }
    stage(`<p class="stage-line big">YOUR TURN — round ${round}</p><div class="input-pad">
      <button class="pad-btn" data-pad="mint" style="--swatch:#74ffc8">M</button>
      <button class="pad-btn" data-pad="violet" style="--swatch:#b780ff">V</button>
      <button class="pad-btn" data-pad="amber" style="--swatch:#ffd36c">A</button>
      <button class="pad-btn" data-pad="blue" style="--swatch:#7ddcff">B</button>
      <button class="pad-btn" data-pad="left">◀</button>
      <button class="pad-btn" data-pad="right">▶</button>
    </div>`);
  }

  function renderGamePhase(p) {
    if (!p || typeof p !== 'object') return;
    switch (p.phase) {
      case 'start': stage(stageLine(`MISSION STARTED // ${p.game}`, 'big')); break;
      case 'watch': stage(stageLine(`WATCH THE PATTERN — round ${p.round}/${p.totalRounds || 3}`, 'big') + `<div class="simon-seq">${(p.seq || []).map(simonGlyph).join('')}</div>`); break;
      case 'input': showInputPad(p.round); break;
      case 'result': stage(stageLine(p.won ? `FLAWLESS — round ${p.round} cleared.` : `Pattern collapsed at round ${p.round}. Ozi is being gracious about it. Probably.`, p.won ? 'win' : 'bad')); break;
      case 'state': stage(`<div class="lamp ${p.light}"></div>` + stageLine(p.light === 'green' ? 'GREEN — Ozi wiggles.' : 'RED — freeze!', 'big')); break;
      case 'end': stage(stageLine(p.caught ? `Caught mid-wiggle ${p.caughtTimes || ''}time(s). Confidence shaken, comedy intact.` : `Clean rounds won: ${p.wins}. Suspicious discipline.`)); break;
      case 'party': stage(stageLine(`NOW PLAYING: ${p.track}`, 'violet')); break;
      case 'seek': stage(stageLine(`FIND: ${p.label} — place Evo on the ${p.color} card`, 'big') + (p.retry ? stageLine('not it. suspicious. try again.') : '')); break;
      case 'found': stage(stageLine(p.msg || (p.matched ? `FOUND IT — surface reads ${p.surface}.` : `Surface reads ${p.surface}. Not the one.`))); break;
      case 'summary': stage(stageLine(`Hunt complete: ${p.matched}/${p.total} colors confirmed.`)); break;
      case 'box': stage(stageLine(`MYSTERY BOX: ${p.surface} → ${p.outcome}`, 'violet')); break;
      case 'patrol': stage(stageLine(`GUARDING — ${p.sec}s left on shift.`)); break;
      case 'alert': stage(stageLine(`PROXIMITY ALERT — something at ${p.side}. Guarding works.`, 'bad')); break;
      case 'countdown': stage(stageLine(p.n > 0 ? `HIDING IN… ${p.n}` : 'READY OR NOT…', 'big')); break;
      case 'found2': case 'found-seek': break;
      case 'stopped': stage(stageLine('Mission aborted. No further questions.')); break;
      case 'error': stage(stageLine(`Mission error: ${p.detail || 'unknown'}`, 'bad')); break;
      case 'msg': stage(stageLine(p.msg || '')); break;
      default:
        if (p.msg) stage(stageLine(p.msg));
    }
  }

  async function launchMission(id) {
    if (OP.Games.busy()) return toast('Already playing', 'One mission at a time — abort the current one first.');
    try {
      const result = await OP.Games.start(id);
      if (result && result.ok === false) stage(stageLine(`Mission declined by the engine: ${result.error || 'unknown'}`, 'bad'));
      renderAll();
    } catch (err) {
      stage(stageLine(String(err?.message || err), 'bad'));
    }
  }

  /* ================= modals ================= */
  let lastFocused = null;
  function openModal(id) {
    lastFocused = document.activeElement;
    $('#modalLayer').classList.add('open');
    $('#modalLayer').setAttribute('aria-hidden', 'false');
    $$('.modal').forEach(m => m.classList.toggle('active', m.id === id));
    document.body.style.overflow = 'hidden';
    const modal = document.getElementById(id);
    if (id === 'danceModal') renderDanceDeck();
    if (id === 'arcadeModal') renderArcade();
    if (id === 'songbookModal') renderSongbook();
    (modal?.querySelector('.modal-close') || modal)?.focus();
  }
  function closeModal() {
    if (!$('#modalLayer').classList.contains('open')) return;
    $('#modalLayer').classList.remove('open');
    $('#modalLayer').setAttribute('aria-hidden', 'true');
    $$('.modal').forEach(m => m.classList.remove('active'));
    document.body.style.overflow = '';
    if (lastFocused && document.contains(lastFocused) && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
  }

  /* ================= event bindings ================= */
  function bindEvents() {
    const unlockAudio = () => {
      try { OP.Perform?.unlockAudio?.(); } catch {}
    };
    window.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
    window.addEventListener('keydown', unlockAudio, { once: true, capture: true });

    $$('[data-action]').forEach(btn => btn.addEventListener('click', () => {
      if (!ENGINE) return toast('Engine offline', 'Refresh the page — the pet brain failed to load.');
      OP.Core.interact(btn.dataset.action);
    }));

    $$('[data-zone]').forEach(btn => btn.addEventListener('click', () => {
      if (snap && !snap.awake) return toast('Ozi is asleep', 'Say hello first if you want to wake the little menace.');
      const z = btn.dataset.zone;
      moveVisuals(z); setLed((zones[z] || zones.center).color);
      if (ENGINE) {
        OP.Core.applyNeeds({ curiosity: -2, boredom: -5 });
        OP.Core.addMemory(`Was directed toward ${zoneLabel(z)}.`);
      }
      showThought(`You pointed at ${zoneLabel(z)}. I am choosing to interpret this as permission.`);
      if (ENGINE) OP.Store.saveSoon();
    }));

    $$('[data-modal]').forEach(btn => btn.addEventListener('click', () => openModal(btn.dataset.modal)));
    $$('[data-close-modal]').forEach(el => el.addEventListener('click', closeModal));
    $('#hardwareButton').addEventListener('click', () => openModal('hardwareModal'));

    $('#livingToggle').addEventListener('click', () => {
      if (!ENGINE) return;
      const s = OP.Core.getState();
      s.living = !s.living;
      OP.Store.saveSoon();
      renderAll();
      toast(s.living ? 'Living mode on' : 'Quiet mode on', s.living ? 'Ozi may initiate small interactions.' : 'Ozi will wait for you.');
    });

    $('#resetDayButton').addEventListener('click', () => {
      if (!ENGINE) return;
      const s = OP.Core.getState();
      s.day++;
      s.awake = true;
      OP.Core.applyNeeds({ energy: 12, boredom: -10 });
      OP.Core.addMemory(`Day ${s.day} began. Ozi resumed the investigation.`);
      renderAll();
      Bus.emit('thought', { text: 'New day. Same desk. New allegations.' });
    });

    // runtime-guard.js provides the two-click CONFIRM arm/disarm in capture
    // phase — by the time this fires, the user has confirmed.
    $('#clearMemories').addEventListener('click', () => {
      if (!ENGINE) return;
      const s = OP.Core.getState();
      s.memories.length = 0;
      OP.Store.saveSoon();
      renderAll();
      toast('Memory feed cleared', 'Dreams and personality were left intact.');
    });

    $('#connectBridge').addEventListener('click', connectBridge);
    $('#disconnectBridge').addEventListener('click', disconnectBridge);

    $$('[data-hw]').forEach(btn => btn.addEventListener('click', async () => {
      if (!connected) return toast('No real body yet', 'Open Hardware Lab and connect the local bridge first.');
      const commands = {
        forward: ['move', { distance: 50, speed: 50 }], back: ['move', { distance: -40, speed: 45 }],
        left: ['turn', { angle: 35, speed: 70 }], right: ['turn', { angle: -35, speed: 70 }], tone: ['tone', { frequency: 740, duration: .08 }]
      };
      const cmd = commands[btn.dataset.hw];
      if (!cmd) return;
      try { await hardwareAction(cmd[0], cmd[1]); toast('Body command sent', btn.dataset.hw); animate('bop', 500); }
      catch (e) { hardwareSoftFail(e); }
    }));

    $$('[data-led]').forEach(btn => btn.addEventListener('click', async () => {
      if (!connected) return toast('No real body yet', 'Connect the bridge before testing LEDs.');
      try { await hardwareAction('led', { color: btn.dataset.led }); setLed(getColor(btn.dataset.led)); }
      catch (e) { hardwareSoftFail(e); }
    }));

    $('#readColorButton').addEventListener('click', async () => {
      if (!ENGINE) return;
      if (!connected) return toast('No real body yet', 'Connect the bridge first.');
      const r = await OP.Safety.readSurface();
      $('#surfaceReadout').textContent = r.surface || 'unclassified';
      if (r.error) hardwareSoftFail(new Error(r.error));
      else toast('Surface read', r.surface || 'unclassified');
    });

    $('#generateDream').addEventListener('click', () => {
      if (!ENGINE) return;
      const d = OP.Core.generateDreamFromMemories();
      if (d) { renderAll(); toast('Dream archived', d.title); }
      else toast('Nothing to dream about yet', 'Ozi needs a few memories first. Go make some.');
    });

    // floor adventure
    $('#oziModeDesk').addEventListener('click', () => { if (!ENGINE) return; OP.Safety.setMode('desk'); renderFloorPanel(); renderFooter(); });
    $('#oziModeFloor').addEventListener('click', () => {
      if (!ENGINE) return;
      OP.Safety.setMode('floor');
      if ($('#oziFloorConfirm').checked) OP.Safety.confirmFloor();
      renderFloorPanel(); renderFooter();
    });
    $('#oziFloorConfirm').addEventListener('change', ev => {
      if (!ENGINE) return;
      if (ev.target.checked) OP.Safety.confirmFloor(); else OP.Safety.revokeFloor();
      renderFloorPanel();
    });
    $('#oziCamPreview').addEventListener('click', startPreview);
    bindCalibrate($('#oziCamVideo'));
    bindCalibrate($('#oziCamCanvas'));
    $('#oziFollowStart').addEventListener('click', () => startFollowMode('follow'));
    $('#oziComeHere').addEventListener('click', () => startFollowMode('come'));
    $('#oziHandMode').addEventListener('click', () => startFollowMode('hand'));

    $('#oziEStop').addEventListener('click', () => { if (!ENGINE) return; OP.Safety.estop('manual STOP pressed'); });
    $('#oziEstopReset').addEventListener('click', async () => {
      OP.Safety.reset();
      $('#oziEstopBanner').hidden = true;
      const hasKey = !!$('#bridgeKey').value.trim();
      if (hasKey && !connected) {
        toast('Waking Ozi up…', 'Starting the body again.');
        for (let i = 0; i < 3 && !connected && !OP.Safety.state().estopped; i++) {
          try { await connectBridge(); } catch {}
          if (!connected) await new Promise(r => setTimeout(r, 3500));
        }
        if (connected) $('#oziEstopBanner').hidden = true;
      } else {
        toast('Ozi is ready!', 'Press any button to play.');
      }
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeModal(); return; }
      if (e.key !== 'Tab' || !$('#modalLayer').classList.contains('open')) return;
      const focusables = $$('.modal.active button, .modal.active input').filter(el => el.offsetParent !== null && !el.disabled);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    window.addEventListener('beforeunload', () => { ENGINE && OP.Store.saveNow(); stopPreview(); });
    window.addEventListener('pagehide', () => { ENGINE && OP.Store.saveNow(); stopPreview(); });
  }

  /* ================= bus wiring ================= */
  function wireBus() {
    Bus.on('thought', d => d?.text && showThought(d.text));
    Bus.on('mood', () => renderAll());
    Bus.on('anim', d => d?.name && animate(d.name, d.ms || 900));
    Bus.on('led', d => d?.color && setLed(d.color));
    Bus.on('zone', d => d?.zone && moveVisuals(d.zone));
    Bus.on('memory', () => renderAll());
    Bus.on('discovery', d => d && toast(`DISCOVERY — ${d.label}`, d.text || ''));
    Bus.on('request', r => r && showRequestCard(r));
    Bus.on('request-done', hideRequestCard);
    Bus.on('toast', t => t && toast(t.title || '', t.text || ''));
    Bus.on('song', d => { markHeard(d?.name); if ($('#songList')?.children.length) renderSongbook(); });
    Bus.on('dance', () => renderAll());
    Bus.on('game', p => renderGamePhase(p));
    Bus.on('estate', d => {
      setConnectedUI(d?.connected);
      $('#oziEStop').hidden = !d?.connected;
      if (d?.connected) $('#connectionOrb')?.classList.add('connected');
      renderFooter();
    });
    Bus.on('mode', () => { renderFloorPanel(); renderFooter(); });
    Bus.on('estop', onEstop);
    Bus.on('follow', d => {
      const st = d?.state;
      const detail = d?.detail ? ` (${d.detail})` : '';
      if (st === 'tracking') $('#oziFollowStatus').textContent = `TRACKING${detail}`;
      else if (st === 'lost') $('#oziFollowStatus').textContent = `TARGET LOST${detail} — pulses stopped, waiting…`;
      else if (st === 'starting') $('#oziFollowStatus').textContent = 'STARTING CAMERA…';
      else if (st === 'stopped') { $('#oziFollowStatus').textContent = `STOPPED${detail}`; renderFloorPanel(); }
      else if (st === 'error') { $('#oziFollowStatus').textContent = `ERROR${detail}`; renderFloorPanel(); }
    });
    Bus.on('tick-needs', () => renderAll());
    Bus.on('state-changed', () => renderAll());
    Bus.on('dream', () => renderAll());
  }

  /* ================= dust + boot ================= */
  function createDust() {
    const root = $('#dust');
    for (let i = 0; i < 34; i++) {
      const dot = document.createElement('i');
      dot.style.left = `${Math.random() * 100}%`; dot.style.top = `${Math.random() * 100}%`;
      dot.style.setProperty('--d', `${6 + Math.random() * 10}s`); dot.style.animationDelay = `${-Math.random() * 10}s`;
      root.appendChild(dot);
    }
  }

  function boot() {
    createDust();
    bindEvents();
    if (!ENGINE) {
      toast('Engine failed to load', 'The pet modules did not start. Check the console and refresh.');
      return;
    }
    OP.Core.init();
    OP.Core.wireDeps({ Perform: OP.Perform, Games: OP.Games });
    OP.Safety.setKeyProvider(() => ($('#bridgeKey').value || '').trim());
    OP.Core.startLoops();
    wireBus();
    snap = OP.Core.snapshot();
    moveVisuals(snap.zone || 'nest');
    renderAll();
    renderDanceDeck();
    renderSongbook();
    renderArcade();
    setTimeout(() => {
      animate('bop');
      if (!snap.awake) showThought('...zzzt... keyboard mountain...');
      else showThought('You came back. Good. I had concerns. Also: I can dance now. Just saying.');
    }, 700);
  }

  boot();
})();
