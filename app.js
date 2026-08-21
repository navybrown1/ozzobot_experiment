(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const clamp = (n, min = 0, max = 100) => Math.min(max, Math.max(min, n));
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const nowStamp = () => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date());

  const DEFAULT_STATE = {
    version: 1,
    name: 'Ozi',
    day: 1,
    awake: true,
    living: true,
    mood: 'curious',
    zone: 'nest',
    vitals: { energy: 84, curiosity: 91, social: 63, confidence: 72, mischief: 82, boredom: 26, trust: 68 },
    dna: { curiosity: 91, courage: 57, affection: 74, independence: 79, mischief: 88, patience: 31, obedience: 49, persistence: 84, weirdness: 93 },
    memories: [
      { text: 'Woke up and immediately distrusted the keyboard.', at: 'first light' },
      { text: 'Decided the north edge of the desk probably contains secrets.', at: 'a moment ago' }
    ],
    dreams: [
      { title: 'Keyboard Mountain', text: 'The keys became black cliffs. A purple door waited at the top. Behind it were forty-seven CrunchBytes and one extremely judgmental hand.', day: 0 }
    ],
    hardware: { connected: false, key: '' },
    interactionCount: 0
  };

  const memoryKey = 'ozopet-state-v1';
  let state = loadState();
  let autoTimer = null;
  let position = { x: 50, y: 52 };

  const zones = {
    nest: { x: 20, y: 72, color: '#7ddcff', surface: 'blue/home' },
    food: { x: 23, y: 30, color: '#74ffc8', surface: 'green/snack' },
    play: { x: 76, y: 28, color: '#ffd36c', surface: 'yellow/play' },
    mystery: { x: 76, y: 70, color: '#b780ff', surface: 'purple/unknown' },
    center: { x: 50, y: 52, color: '#74ffc8', surface: 'unclassified' }
  };

  const thoughts = {
    hello: [
      'There you are. I had started a formal complaint.',
      'Acknowledgement received. Human presence accepted.',
      'Hello. I was definitely not chewing on the concept of free will.',
      'You came back. Good. The desk has been weird without supervision.'
    ],
    feed: [
      'CrunchByte acquired. Diplomatic relations improve.',
      'This is acceptable tribute.',
      'NOM. I mean... nutritional protocol complete.',
      'I have decided you may continue being my person.'
    ],
    explore: [
      'There is absolutely something over there. Probably.',
      'I must inspect the suspicious region.',
      'New territory detected. Common sense temporarily disabled.',
      'If this goes badly, I will document it as science.'
    ],
    dance: [
      'You requested movement. I upgraded it to art.',
      'Observe: unnecessary confidence.',
      'I call this one The Charging Cable Incident.',
      'Please note that I trained extensively for none of this.'
    ],
    mischief: [
      'Interesting. You have chosen to encourage me.',
      'Rules are merely lines the floor has opinions about.',
      'I have identified a forbidden region. Naturally, I am interested.',
      'Bad influence detected. Affection increased.'
    ],
    sleep: [
      'Fine. But if I dream about hands again, we are discussing it tomorrow.',
      'Entering low-power philosophical mode.',
      'Good night. Please keep the keyboard from moving.',
      'I will sleep. The desk remains under suspicion.'
    ],
    autonomous: [
      'I have been thinking about the purple place again.',
      'Nothing has happened for several minutes. This seems unacceptable.',
      'I heard nothing. I am investigating anyway.',
      'I have elected to entertain myself.',
      'The desk has changed by at least zero percent. Concerning.',
      'I would like it noted that boredom was not my idea.'
    ]
  };

  const memoryTemplates = {
    hello: ['You said hello. Ozi pretended this was not a big deal.', 'Ozi rolled closer when acknowledged.', 'Human contact logged as suspiciously pleasant.'],
    feed: ['Received a CrunchByte and immediately forgave several imaginary offenses.', 'Snack ritual completed. Trust rose slightly.', 'Green zone produced food. Ozi will remember this.'],
    explore: ['Investigated a new patch of desk without permission.', 'Curiosity won another argument.', 'Explored beyond the comfortable route and returned intact.'],
    dance: ['Performed a dance with zero tactical value.', 'Spun dramatically and acted like it was planned.', 'Converted stored energy into nonsense.'],
    mischief: ['Was encouraged to make a questionable decision.', 'Entered a region mostly because it looked forbidden.', 'Mischief received positive reinforcement. This may be a mistake.'],
    sleep: ['Returned to the nest and powered down reluctantly.', 'Bedtime occurred after minor negotiations.', 'Went to sleep while maintaining a grudge against the keyboard.']
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(memoryKey));
      if (!saved || saved.version !== 1) return structuredClone(DEFAULT_STATE);
      return { ...structuredClone(DEFAULT_STATE), ...saved, vitals: { ...DEFAULT_STATE.vitals, ...(saved.vitals || {}) }, dna: { ...DEFAULT_STATE.dna, ...(saved.dna || {}) }, hardware: { ...DEFAULT_STATE.hardware, ...(saved.hardware || {}), connected: false } };
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  function saveState() {
    const safeState = structuredClone(state);
    safeState.hardware.connected = false;
    localStorage.setItem(memoryKey, JSON.stringify(safeState));
  }

  function renderAll() {
    $('#dayCount').textContent = String(state.day).padStart(3, '0');
    $('#petName').textContent = state.name.toUpperCase();
    $('#moodWord').textContent = state.mood;
    $('#livingLabel').textContent = state.living ? 'living mode' : 'quiet mode';
    $('.pulse-dot').style.opacity = state.living ? '1' : '.28';
    $('#trustScore').textContent = Math.round(state.vitals.trust);
    $('#bondRing').style.setProperty('--bond', `${state.vitals.trust}%`);
    $('#bondLabel').textContent = bondLabel(state.vitals.trust);
    $('#relationshipThought').textContent = relationshipThought();
    $('#archetype').textContent = archetype();
    $('#dnaTag').textContent = `DNA // ${dnaCode()}`;
    $('#habitatWeather').textContent = habitatWeather();
    $('#mindText').textContent = mindThought();
    $('#zoneReadout').textContent = zoneLabel(state.zone);
    $('#bodyReadout').textContent = state.hardware.connected ? 'real Evo' : 'simulation';
    $('#hardwareLabel').textContent = state.hardware.connected ? 'evo body attached' : 'simulated body';
    $('#hardwareDot').classList.toggle('connected', state.hardware.connected);
    $('#footerStatus').textContent = state.hardware.connected ? 'hardware bridge connected // safe command mode' : 'simulation awake // no hardware commands sent';
    renderMeters();
    renderMemories();
    renderTags();
    renderDNA();
    renderDreams();
    renderConnection();
  }

  function renderMeters() {
    const visible = ['energy','curiosity','social','confidence','mischief','boredom'];
    $('#meterList').innerHTML = visible.map(key => `
      <div class="meter-row">
        <label>${key}</label>
        <div class="meter-track"><div class="meter-fill" style="width:${state.vitals[key]}%"></div></div>
        <output>${Math.round(state.vitals[key])}</output>
      </div>`).join('');
  }

  function renderMemories() {
    const items = state.memories.slice(-8).reverse();
    $('#memoryFeed').innerHTML = items.length ? items.map((m, i) => `
      <div class="memory-item">
        <div class="memory-index">${String(state.memories.length - i).padStart(2,'0')}</div>
        <div><p>${escapeHTML(m.text)}</p><time>${escapeHTML(m.at)}</time></div>
      </div>`).join('') : '<div class="memory-item"><div class="memory-index">--</div><div><p>No memories. This is either peaceful or alarming.</p></div></div>';
  }

  function renderTags() {
    const tags = [state.mood, state.zone, state.vitals.boredom > 65 ? 'restless' : 'occupied', state.vitals.mischief > 75 ? 'bad ideas' : 'mostly lawful'];
    $('#mindTags').innerHTML = tags.map(t => `<span>${escapeHTML(t)}</span>`).join('');
  }

  function renderDNA() {
    const explain = {
      curiosity:'pull toward novelty', courage:'approach unknown things', affection:'seek friendly contact', independence:'act without asking', mischief:'prefer interesting mistakes', patience:'wait before acting', obedience:'follow direct requests', persistence:'try again after failure', weirdness:'choose delightfully odd options'
    };
    $('#dnaGrid').innerHTML = Object.entries(state.dna).map(([k,v]) => `
      <div class="dna-item"><div class="dna-item-head"><span>${k}</span><strong>${v}</strong></div><div class="meter-track"><div class="meter-fill" style="width:${v}%"></div></div><p>${explain[k]}</p></div>`).join('');
    $('#traitCombo').innerHTML = `<b>${archetype().toUpperCase()}</b><br>${traitSentence()}`;
  }

  function renderDreams() {
    const dreams = state.dreams.length ? state.dreams : [{ title:'No dreams yet', text:'Put Ozi to bed, then come back here.', day:state.day }];
    const latest = dreams[dreams.length - 1];
    $('#dreamFeature').innerHTML = `<h3>${escapeHTML(latest.title)}</h3><p>${escapeHTML(latest.text)}</p>`;
    $('#dreamList').innerHTML = dreams.slice().reverse().map((d,i) => `<button class="dream-thumb" data-dream-index="${state.dreams.length - 1 - i}"><b>DAY ${String(d.day || 0).padStart(3,'0')} // ${escapeHTML(d.title)}</b><small>${escapeHTML(d.text.slice(0,70))}${d.text.length>70?'…':''}</small></button>`).join('');
    $$('[data-dream-index]').forEach(btn => btn.addEventListener('click', () => {
      const d = state.dreams[Number(btn.dataset.dreamIndex)];
      if (d) $('#dreamFeature').innerHTML = `<h3>${escapeHTML(d.title)}</h3><p>${escapeHTML(d.text)}</p>`;
    }));
  }

  function renderConnection() {
    const connected = state.hardware.connected;
    $('#connectionOrb').classList.toggle('connected', connected);
    $('#connectionTitle').textContent = connected ? 'Real Evo body attached' : 'No body attached';
    $('#connectionDetail').textContent = connected ? 'The local bridge answered. Safe movement, LED, tone and surface-color tests are enabled.' : 'Start the bridge, paste its one-time key, then connect.';
    if (state.hardware.key && !$('#bridgeKey').value) $('#bridgeKey').value = state.hardware.key;
  }

  function archetype() {
    const d = state.dna;
    if (d.mischief > 82 && d.curiosity > 80) return 'curious trickster';
    if (d.affection > 82 && d.courage > 70) return 'loyal guardian';
    if (d.independence > 82 && d.curiosity > 75) return 'wild explorer';
    if (d.persistence > 80 && d.patience > 65) return 'patient scout';
    return 'odd little companion';
  }

  function dnaCode() {
    const nums = [state.dna.curiosity, state.dna.mischief, state.dna.weirdness];
    return nums.map(n => Math.round(n).toString(16).toUpperCase().padStart(2,'0')).join('-');
  }

  function bondLabel(n) {
    if (n >= 92) return 'trusted person';
    if (n >= 82) return 'chosen human';
    if (n >= 70) return 'growing bond';
    if (n >= 55) return 'new friend';
    return 'under review';
  }

  function relationshipThought() {
    const t = state.vitals.trust;
    if (t > 90) return 'Ozi expects you to return, bring interesting things, and prevent obviously bad desk decisions.';
    if (t > 78) return 'Ozi trusts you enough to be annoying on purpose.';
    if (t > 65) return 'Ozi is beginning to associate you with snacks, safety and entertainment.';
    return 'Ozi is still deciding what kind of human you are.';
  }

  function habitatWeather() {
    if (!state.awake) return 'dreaming quietly';
    if (state.vitals.boredom > 70) return 'dangerously bored';
    if (state.vitals.mischief > 88) return 'bad idea pressure';
    if (state.vitals.energy < 30) return 'sleepy static';
    return pick(['softly curious','mossy and alert','mildly suspicious','pleasantly weird']);
  }

  function mindThought() {
    if (!state.awake) return 'The desk is gone. There is only Keyboard Mountain now.';
    if (state.vitals.boredom > 70) return 'I require stimulation before I invent something worse.';
    if (state.vitals.energy < 30) return 'I am awake in the technical sense only.';
    if (state.zone === 'mystery') return 'Purple means unknown. Unknown means investigate. This logic is flawless.';
    if (state.zone === 'food') return 'Green has a statistically meaningful relationship with CrunchBytes.';
    if (state.zone === 'play') return 'This region appears legally distinct from responsibility.';
    return pick(['You returned. I had not finished judging the keyboard.','I am considering a small journey with unreasonable confidence.','The desk is quiet. I do not trust this.']);
  }

  function traitSentence() {
    const d = state.dna;
    return `High curiosity (${d.curiosity}) and mischief (${d.mischief}) make Ozi investigate things that look forbidden. Low patience (${d.patience}) means waiting usually loses to action. Weirdness (${d.weirdness}) gives harmless odd behavior extra weight.`;
  }

  function zoneLabel(z) {
    return ({nest:'nest edge', food:'crunchbyte grove', play:'play halo', mystery:'mystery puddle', center:'open desk'})[z] || z;
  }

  function modify(key, delta) {
    state.vitals[key] = clamp(state.vitals[key] + delta);
  }

  function addMemory(text) {
    state.memories.push({ text, at: nowStamp() });
    if (state.memories.length > 80) state.memories = state.memories.slice(-80);
  }

  function speak(text, mood = null) {
    $('#ambientText').textContent = text;
    $('#mindText').textContent = text;
    if (mood) state.mood = mood;
    const pop = $('#thoughtPop');
    pop.textContent = pick(['?','!','✦','…','♥']);
    pop.classList.add('show');
    setTimeout(() => pop.classList.remove('show'), 1100);
  }

  function setLed(color) {
    $('#ozi').style.setProperty('--led', color);
    $('#habitatMoodDot').style.background = color;
    $('#habitatMoodDot').style.boxShadow = `0 0 10px ${color}`;
  }

  function animate(cls, duration = 900) {
    const el = $('#ozi');
    el.classList.remove('bop','spin','nervous');
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), duration);
  }

  function moveTo(zoneName, hardware = false) {
    const z = zones[zoneName] || zones.center;
    state.zone = zoneName;
    position = { x:z.x, y:z.y };
    $('#ozi').style.left = `${z.x}%`;
    $('#ozi').style.top = `${z.y}%`;
    $('#petShadow').style.left = `${z.x}%`;
    $('#petShadow').style.top = `${z.y + 9}%`;
    $('#zoneReadout').textContent = zoneLabel(zoneName);
    $('#surfaceReadout').textContent = z.surface;
    setLed(z.color);
    leaveTrail(z.x, z.y);
    if (hardware && state.hardware.connected) safeHardwareZoneCue(zoneName);
  }

  function leaveTrail(x,y) {
    for (let i=0;i<6;i++) {
      const dot = document.createElement('i');
      dot.style.left = `${clamp(x + (Math.random()-.5)*10,4,96)}%`;
      dot.style.top = `${clamp(y + (Math.random()-.5)*8,4,94)}%`;
      $('#trail').appendChild(dot);
      setTimeout(() => dot.remove(), 3100);
    }
  }

  async function perform(action) {
    if (!state.awake && action !== 'hello') {
      speak('I am asleep. This feels like a boundary issue.', 'sleepy');
      toast('Ozi is asleep', 'Say hello first if you want to wake the little menace.');
      return;
    }

    state.interactionCount++;
    switch(action) {
      case 'hello':
        state.awake = true; modify('social', 5); modify('trust', 1.5); modify('boredom', -9); setLed('#74ffc8'); animate('bop'); chirp('hello'); speak(pick(thoughts.hello), 'warm');
        if (state.hardware.connected) hardwareAction('hello').catch(hardwareSoftFail);
        break;
      case 'feed':
        modify('energy', 12); modify('trust', 2); modify('social', 2); modify('boredom', -4); moveTo('food'); animate('bop'); chirp('feed'); speak(pick(thoughts.feed), 'pleased');
        if (state.hardware.connected) hardwareAction('led', { color:'mint' }).catch(hardwareSoftFail);
        break;
      case 'explore': {
        const destination = pick(['play','mystery','center','food']);
        modify('curiosity', -4); modify('confidence', 1); modify('energy', -7); modify('boredom', -15); moveTo(destination, true); animate('bop'); chirp('explore'); speak(pick(thoughts.explore), 'curious');
        if (state.hardware.connected) hardwareAction('move', { distance:60, speed:55 }).catch(hardwareSoftFail);
        break;
      }
      case 'dance':
        modify('energy', -9); modify('social', 6); modify('boredom', -18); modify('mischief', 2); setLed('#ffd36c'); animate('spin'); chirp('dance'); speak(pick(thoughts.dance), 'delighted');
        if (state.hardware.connected) hardwareAction('dance').catch(hardwareSoftFail);
        break;
      case 'mischief':
        modify('mischief', 5); modify('trust', 1); modify('confidence', 3); modify('boredom', -22); moveTo('mystery', true); setLed('#b780ff'); animate('nervous'); chirp('mischief'); speak(pick(thoughts.mischief), 'scheming');
        if (state.hardware.connected) hardwareAction('turn', { angle:45, speed:70 }).catch(hardwareSoftFail);
        break;
      case 'sleep':
        state.awake = false; modify('energy', 14); modify('boredom', -5); moveTo('nest'); setLed('#7ddcff'); chirp('sleep'); speak(pick(thoughts.sleep), 'sleepy');
        if (state.hardware.connected) hardwareAction('led', { color:'blue' }).catch(hardwareSoftFail);
        break;
    }
    addMemory(pick(memoryTemplates[action] || [`Ozi did ${action}.`]));
    driftDNA(action);
    saveState(); renderAll();
  }

  function driftDNA(action) {
    const delta = .25;
    if (action === 'explore') state.dna.curiosity = clamp(state.dna.curiosity + delta);
    if (action === 'mischief') state.dna.mischief = clamp(state.dna.mischief + delta);
    if (action === 'hello') state.dna.affection = clamp(state.dna.affection + delta/2);
    if (action === 'sleep') state.dna.patience = clamp(state.dna.patience + delta/3);
  }

  function autonomousTick() {
    if (!state.living || !state.awake) return scheduleAuto();
    modify('boredom', 3 + Math.random()*4);
    modify('energy', -1.2);
    const curiosityPressure = state.dna.curiosity + state.vitals.boredom + state.dna.independence;
    const mischiefPressure = state.dna.mischief + state.vitals.boredom;
    if (mischiefPressure > 160 && Math.random() < .52) {
      moveTo('mystery', state.hardware.connected);
      setLed('#b780ff'); animate('nervous');
      const line = pick(['I found a region with poor supervision.','I have become interested in the least responsible direction.','This looks forbidden enough to be educational.']);
      speak(line, 'scheming'); addMemory('Ozi initiated a small unauthorized expedition.');
      if (state.hardware.connected) hardwareAction('turn', { angle:30, speed:60 }).catch(hardwareSoftFail);
    } else if (curiosityPressure > 180 && Math.random() < .62) {
      moveTo(pick(['play','food','center']), state.hardware.connected); animate('bop'); speak(pick(thoughts.autonomous), 'curious');
      if (state.hardware.connected) hardwareAction('move', { distance:40, speed:45 }).catch(hardwareSoftFail);
    } else {
      speak(pick(thoughts.autonomous), state.mood);
    }
    saveState(); renderAll(); scheduleAuto();
  }

  function scheduleAuto() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(autonomousTick, 18000 + Math.random()*19000);
  }

  function chirp(kind='hello') {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const seq = ({hello:[[660,.06],[880,.08]],feed:[[520,.05],[760,.05],[980,.07]],explore:[[440,.06],[610,.06]],dance:[[523,.07],[659,.07],[784,.09]],mischief:[[330,.08],[495,.05],[370,.07]],sleep:[[523,.08],[392,.1],[262,.14]]})[kind] || [[600,.08]];
      let t = ctx.currentTime;
      seq.forEach(([freq,dur]) => {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(.045,t); gain.gain.exponentialRampToValueAtTime(.001,t+dur);
        osc.connect(gain).connect(ctx.destination); osc.start(t); osc.stop(t+dur+.01); t += dur+.025;
      });
      setTimeout(() => ctx.close(), 700);
    } catch {}
  }

  function generateDream() {
    const recent = state.memories.slice(-5).map(m => m.text.toLowerCase()).join(' ');
    const subjects = [];
    if (recent.includes('snack') || recent.includes('crunch')) subjects.push('CrunchByte');
    if (recent.includes('purple') || recent.includes('forbidden') || recent.includes('unauthorized')) subjects.push('Purple Door');
    if (recent.includes('dance') || recent.includes('spin')) subjects.push('Infinite Spin');
    if (recent.includes('explor')) subjects.push('Map With No Edge');
    const subject = subjects.length ? pick(subjects) : pick(['Keyboard Mountain','The Giant Hand','Blue Ocean','Charging Cable Forest','The Quiet Desk']);
    const endings = [
      'At the end was a tiny green light that knew Ozi by name.',
      'Every path led back to the nest except one, which led directly into Tuesday.',
      'The keyboard apologized. Ozi did not accept immediately.',
      'A hand appeared, offered a CrunchByte, and then became a staircase.',
      'The whole desk folded into a paper map and drifted away.'
    ];
    const text = `Ozi dreamed about ${subject.toLowerCase()}. ${pick(['The desk was enormous and gravity had become optional.','All the colored zones had traded places overnight.','Every object was softly glowing and slightly suspicious.','The floor kept whispering directions that contradicted each other.'])} ${pick(endings)}`;
    state.dreams.push({ title: subject, text, day: state.day });
    if (state.dreams.length > 40) state.dreams = state.dreams.slice(-40);
    addMemory(`Dreamed about ${subject}. The details remain legally questionable.`);
    saveState(); renderAll(); toast('Dream archived', subject);
  }

  async function hardwareRequest(path, body = null) {
    const key = ($('#bridgeKey').value || state.hardware.key || '').trim();
    const headers = { 'Content-Type':'application/json', 'X-OzoPet-Key': key };
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(`http://127.0.0.1:8787${path}`, { method: body ? 'POST':'GET', headers, body: body ? JSON.stringify(body) : undefined, signal:ctrl.signal, mode:'cors' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `bridge returned ${res.status}`);
      return data;
    } finally { clearTimeout(timeout); }
  }

  async function connectBridge() {
    const key = $('#bridgeKey').value.trim();
    if (!key) return toast('Bridge key missing','Run bridge/ozopet_bridge.py and paste the key it prints.');
    state.hardware.key = key;
    try {
      const health = await hardwareRequest('/health');
      if (!health.ok) throw new Error('bridge health check failed');
      const result = await hardwareRequest('/connect', {});
      state.hardware.connected = !!result.connected;
      $('#surfaceReadout').textContent = result.surface || 'waiting';
      saveState(); renderAll();
      toast('Evo body attached', result.robot || 'Ozobot bridge connected.');
      if (state.hardware.connected) {
        await hardwareAction('led', { color:'mint' });
        await hardwareAction('tone', { frequency:660, duration:.08 });
      }
    } catch (err) {
      state.hardware.connected = false; renderAll();
      toast('Bridge did not connect', humanError(err));
    }
  }

  async function disconnectBridge() {
    try { if (state.hardware.connected) await hardwareRequest('/disconnect', {}); } catch {}
    state.hardware.connected = false; saveState(); renderAll(); toast('Hardware detached','Ozi is back in simulation-only mode.');
  }

  async function hardwareAction(action, payload = {}) {
    if (!state.hardware.connected) throw new Error('hardware not connected');
    return hardwareRequest('/action', { action, ...payload });
  }

  function hardwareSoftFail(err) {
    state.hardware.connected = false; saveState(); renderAll();
    toast('Hardware went quiet', humanError(err));
  }

  async function safeHardwareZoneCue(zoneName) {
    const map = { food:'mint', play:'amber', mystery:'violet', nest:'blue', center:'mint' };
    try { await hardwareAction('led', { color: map[zoneName] || 'mint' }); } catch (e) { hardwareSoftFail(e); }
  }

  function humanError(err) {
    if (err?.name === 'AbortError') return 'The local bridge did not answer in time.';
    if (/fetch/i.test(err?.message || '')) return 'Could not reach http://127.0.0.1:8787. Start the local bridge on the PC running the browser.';
    return err?.message || 'Unknown bridge error.';
  }

  function openModal(id) {
    $('#modalLayer').classList.add('open');
    $('#modalLayer').setAttribute('aria-hidden','false');
    $$('.modal').forEach(m => m.classList.toggle('active', m.id === id));
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    $('#modalLayer').classList.remove('open');
    $('#modalLayer').setAttribute('aria-hidden','true');
    $$('.modal').forEach(m => m.classList.remove('active'));
    document.body.style.overflow = '';
  }

  function toast(title, text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<b>${escapeHTML(title)}</b><p>${escapeHTML(text)}</p>`;
    $('#toastStack').appendChild(el);
    setTimeout(() => { el.style.opacity='0'; el.style.transform='translateX(12px)'; }, 3600);
    setTimeout(() => el.remove(), 4100);
  }

  function escapeHTML(str='') {
    return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }

  function createDust() {
    const root = $('#dust');
    for (let i=0;i<34;i++) {
      const dot = document.createElement('i');
      dot.style.left = `${Math.random()*100}%`; dot.style.top = `${Math.random()*100}%`;
      dot.style.setProperty('--d', `${6+Math.random()*10}s`); dot.style.animationDelay = `${-Math.random()*10}s`;
      root.appendChild(dot);
    }
  }

  async function hwButtonAction(btn) {
    if (!state.hardware.connected) return toast('No real body yet','Open Hardware Lab and connect the local bridge first.');
    const a = btn.dataset.hw;
    const commands = {
      forward:['move',{distance:50,speed:50}], back:['move',{distance:-40,speed:45}], left:['turn',{angle:35,speed:70}], right:['turn',{angle:-35,speed:70}], tone:['tone',{frequency:740,duration:.08}]
    };
    const cmd = commands[a];
    if (!cmd) return;
    try { await hardwareAction(cmd[0], cmd[1]); toast('Body command sent', a); }
    catch(e){ hardwareSoftFail(e); }
  }

  function bindEvents() {
    $$('[data-action]').forEach(btn => btn.addEventListener('click', () => perform(btn.dataset.action)));
    $$('[data-zone]').forEach(btn => btn.addEventListener('click', () => {
      const z = btn.dataset.zone;
      moveTo(z, true); modify('curiosity', -2); modify('boredom', -5); speak(`You pointed at ${zoneLabel(z)}. I am choosing to interpret this as permission.`, 'curious'); addMemory(`Was directed toward ${zoneLabel(z)}.`); saveState(); renderAll();
    }));
    $$('[data-modal]').forEach(btn => btn.addEventListener('click', () => openModal(btn.dataset.modal)));
    $$('[data-close-modal]').forEach(el => el.addEventListener('click', closeModal));
    $('#hardwareButton').addEventListener('click', () => openModal('hardwareModal'));
    $('#livingToggle').addEventListener('click', () => { state.living = !state.living; saveState(); renderAll(); toast(state.living?'Living mode on':'Quiet mode on', state.living?'Ozi may initiate small interactions.':'Ozi will wait for you.'); scheduleAuto(); });
    $('#resetDayButton').addEventListener('click', () => { state.day++; state.awake = true; modify('energy',12); modify('boredom',-10); addMemory(`Day ${state.day} began. Ozi resumed the investigation.`); saveState(); renderAll(); speak('New day. Same desk. New allegations.', 'curious'); });
    $('#clearMemories').addEventListener('click', () => { state.memories=[]; saveState(); renderAll(); toast('Memory feed cleared','Dreams and personality were left intact.'); });
    $('#connectBridge').addEventListener('click', connectBridge);
    $('#disconnectBridge').addEventListener('click', disconnectBridge);
    $$('[data-hw]').forEach(btn => btn.addEventListener('click', () => hwButtonAction(btn)));
    $$('[data-led]').forEach(btn => btn.addEventListener('click', async () => {
      if (!state.hardware.connected) return toast('No real body yet','Connect the bridge before testing LEDs.');
      try { await hardwareAction('led',{color:btn.dataset.led}); setLed(getColor(btn.dataset.led)); }
      catch(e){ hardwareSoftFail(e); }
    }));
    $('#readColorButton').addEventListener('click', async () => {
      if (!state.hardware.connected) return toast('No real body yet','Connect the bridge first.');
      try { const r = await hardwareAction('read_color'); $('#surfaceReadout').textContent = r.surface || 'unclassified'; toast('Surface read', r.surface || 'unclassified'); }
      catch(e){ hardwareSoftFail(e); }
    });
    $('#generateDream').addEventListener('click', generateDream);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    window.addEventListener('beforeunload', saveState);
  }

  function getColor(name) {
    return ({mint:'#74ffc8',violet:'#b780ff',amber:'#ffd36c',red:'#ff667c',blue:'#7ddcff'})[name] || '#74ffc8';
  }

  createDust();
  bindEvents();
  moveTo(state.zone || 'nest');
  renderAll();
  scheduleAuto();
  setTimeout(() => { animate('bop'); speak(state.awake ? 'You came back. Good. I had concerns.' : '...zzzt... keyboard mountain...'); }, 700);
})();
