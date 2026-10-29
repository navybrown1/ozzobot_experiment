/* Ozi Play Club: user-started games, a single cancellable activity, honest status. */
(() => {
  'use strict';
  const N = window.OziClub, $ = id => document.getElementById(id);
  const STORE = 'ozi-play-club-v4';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE)) || {}; } catch {}
  const prefs = {
    name: typeof saved.name === 'string' ? saved.name.slice(0, 24) : 'Ozi',
    sound: saved.sound === true, scores: saved.scores && typeof saved.scores === 'object' ? saved.scores : {},
    badges: Array.isArray(saved.badges) ? saved.badges.filter(x => typeof x === 'string') : [],
    plays: Number.isSafeInteger(saved.plays) && saved.plays >= 0 ? saved.plays : 0,
    recipe: Array.isArray(saved.recipe) ? saved.recipe.filter(x => N.MOVES[x]).slice(0, 8) : []
  };
  // Legacy pet and memory saves are intentionally untouched.
  function save() { try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch { toast('This browser could not save progress. You can still play.'); } }
  const clock = new N.Clock(), scene = new N.Scene($('playground'), clock), sound = new N.Sound(), bridge = new N.Bridge();
  sound.enabled = prefs.sound;
  let view = 'play', moveMode = 'drive', solo = null, runNumber = 0, toastTimer = null, lastFrame = performance.now(), advancing = false, currentGame = null;
  const BADGES = [
    { id: 'first', icon: '✦', title: 'Play pal', description: 'Finish your first game.' },
    { id: 'freeze', icon: '♪', title: 'Freeze master', description: 'Finish three freeze rounds.' },
    { id: 'copycat', icon: '✧', title: 'Memory magic', description: 'Match all five patterns.' },
    { id: 'explorer', icon: '⌖', title: 'Little explorer', description: 'Win Color Quest or Treasure Trail.' },
    { id: 'maker', icon: '〰', title: 'Move maker', description: 'Perform your own routine.' }
  ];
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, cls, fn) => { const n = el('button', text, cls); n.type = 'button'; n.addEventListener('click', fn); return n; };
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
  function award(id) { if (!prefs.badges.includes(id)) { prefs.badges.push(id); renderBadges(); } }
  function busy() { return !!solo || activities.busy(); }
  function refreshBusy() {
    const active = busy();
    $('stopDock').hidden = !active && !bridge.floor;
    $('stopDock').classList.toggle('compact', !active);
    $('stopLabel').textContent = active ? (solo?.title || 'Game in progress') : 'Floor play is enabled';
    document.querySelectorAll('.start-game,[data-trick]').forEach(b => { b.disabled = active || bridge.status === 'connecting'; });
    $('helloButton').disabled = active || bridge.status === 'connecting';
    $('movePalette').querySelectorAll('button').forEach(b => { b.disabled = active || bridge.status === 'connecting' || !!bridge.stopPending; });
    $('driveMode').disabled = $('buildMode').disabled = active;
    $('runRecipe').disabled = active || !prefs.recipe.length || !!bridge.stopPending;
    $('armFloor').disabled = !bridge.connected || !$('floorConsent').checked || active || bridge.protocol < 4 || !!bridge.stopPending;
    $('deskMode').disabled = !bridge.connected || active;
  }
  async function perform(steps, signal) {
    if (signal.aborted) throw N.abortError();
    const ctl = new AbortController(), abort = () => ctl.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      // Neither animation nor game progress can claim a failed physical command.
      const [, result] = await Promise.all([scene.play(steps, ctl.signal, sound), bridge.perform(steps, ctl.signal)]);
      return result;
    } catch (error) { ctl.abort(); scene.tween = null; if (bridge.connected && error.name !== 'AbortError') bridge.stop().catch(() => {}); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  }
  const activities = N.createActivities({
    perform, sleep: (ms, signal) => clock.sleep(ms, signal), now: () => clock.now(),
    update: renderGame, isHardware: () => bridge.connected && !bridge.simulator,
    readColor: signal => bridge.readColor(signal),
    onComplete: result => {
      prefs.plays++; award('first');
      prefs.scores[result.kind] = Math.max(Number(prefs.scores[result.kind]) || 0, result.score);
      if (result.won) { if (['freeze', 'copycat'].includes(result.kind)) award(result.kind); else award('explorer'); scene.celebrate(); sound.win(); }
      save(); renderBadges(); refreshBusy();
    }
  });
  function renderGame(data) {
    currentGame = data;
    $('introPanel').hidden = !!data.kind; $('activityPanel').hidden = !data.kind;
    $('activityEyebrow').textContent = data.kind ? ({ freeze: 'MOVE. WAIT. FREEZE.', copycat: 'A LITTLE MEMORY MAGIC', color: 'PUT YOUR DETECTIVE HAT ON', trail: 'YOU’RE THE NAVIGATOR' }[data.kind]) : 'LET’S PLAY';
    $('activityTitle').textContent = data.title;
    $('activityInstruction').textContent = data.instruction;
    $('gameScore').textContent = data.score;
    $('gameBest').textContent = prefs.scores[data.kind] ? 'Best: ' + prefs.scores[data.kind] : 'Your first high score is waiting.';
    $('roundTrack').replaceChildren(...Array.from({ length: data.total }, (_, i) => el('span', '', i < data.round ? 'done' : '')));
    $('roundTrack').setAttribute('aria-label', 'Round ' + data.round + ' of ' + data.total);
    const focus = document.activeElement?.dataset?.input;
    const controls = [];
    if (data.input === 'freeze') { const b = button(data.phase === 'freeze' ? 'FREEZE!' : 'Wait for FREEZE…', 'freeze-button' + (data.phase === 'freeze' ? ' ready' : ''), () => activities.input('freeze')); b.dataset.input = 'freeze'; controls.push(b); }
    else if (data.input === 'colors') {
      const icons = ['●', '◆', '▲', '■'];
      data.choices.forEach((choice, i) => { const b = button('', 'color-pad', () => activities.input(choice.id)); b.style.background = choice.color; b.dataset.input = choice.id; b.setAttribute('aria-label', choice.label + ' (' + (i + 1) + ')'); b.append(el('span', icons[i]), el('small', choice.label)); controls.push(b); });
    } else if (data.input === 'readColor') { controls.push(button('Read this color ↗', 'button coral', () => activities.input('read'))); }
    else if (data.input === 'drive') {
      const group = el('div', undefined, 'drive-control');
      [['left', '↶', 'Left'], ['forward', '↑', 'Forward'], ['right', '↷', 'Right']].forEach(([id, icon, title]) => { const b = button(icon, '', () => activities.input(id)); b.dataset.input = id; b.setAttribute('aria-label', title); b.append(el('small', title)); group.append(b); }); controls.push(group);
    } else if (['complete', 'stopped', 'error'].includes(data.phase)) {
      controls.push(button('Play again ↗', 'button coral', () => startGame(data.kind)), button('Pick another game', 'text-button', exitGame));
    } else controls.push(el('span', 'Watch Ozi… your turn is coming.', 'game-status'));
    $('gameControls').replaceChildren(...controls);
    if (focus) [...$('gameControls').querySelectorAll('[data-input]')].find(b => b.dataset.input === focus)?.focus({ preventScroll: true });
    scene.setGame(data);
    $('robotStage').classList.toggle('game-active', !!data.kind);
    $('robotStage').classList.toggle('trail-active', data.kind === 'trail');
    $('robotStage').classList.toggle('is-flashing', !!data.flash);
    $('robotStage').style.setProperty('--flash-color', data.flash || 'transparent');
    $('speechBubble').textContent = data.phase === 'complete' ? (data.result?.won ? 'That’s my play pal!' : 'We’ll get it next time.') : data.phase === 'freeze' ? 'FREEZE! Quick, tap!' : data.kind === 'trail' ? 'You lead. I follow.' : data.kind === 'copycat' ? (data.input ? 'Your turn, superstar.' : 'Eyes on my lights.') : data.kind === 'color' ? data.title : 'Time to wiggle!';
    $('sceneCaption').textContent = data.kind === 'trail' ? 'A game map, not a map of your room.' : data.kind === 'freeze' ? 'Your tap is timed, not your body movement.' : 'Little steps. Big fun.';
    $('playground').setAttribute('aria-label', data.board ? `Treasure map: Ozi at column ${data.board.x + 1}, row ${data.board.y + 1}; facing ${['north', 'east', 'south', 'west'][data.board.heading]}. Star at column ${data.board.goal.x + 1}, row ${data.board.goal.y + 1}.` : data.title + '. ' + data.instruction);
    refreshBusy();
  }
  async function startGame(kind) {
    if (busy() || bridge.stopPending || bridge.status === 'connecting') { toast('Finish or stop this activity first.'); return; }
    if (bridge.status === 'offline') { showConnection(); return; }
    sound.unlock(); scene.reset(); setView('play', false);
    const game = activities.start(kind); refreshBusy();
    document.querySelector('.playroom').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await game; refreshBusy();
  }
  function stopAll(reason = 'Stopped. Ready when you are.', sendStop = true) {
    runNumber++; solo?.controller.abort(); solo = null; activities.stop(); sound.stop(); scene.reset();
    if (sendStop) bridge.stop().catch(() => toast('Stop could not be confirmed. Turn off the Evo if it is still moving.'));
    if (currentGame?.kind) { const stopped = { ...activities.snapshot(), phase: 'stopped', title: 'Let’s take a breather.', instruction: reason, input: null, board: null, flash: null }; renderGame(stopped); }
    $('floorConsent').checked = false; refreshBusy();
  }
  function exitGame() { if (busy()) stopAll(); currentGame = null; scene.reset(); $('activityPanel').hidden = true; $('introPanel').hidden = false; $('robotStage').classList.remove('game-active', 'trail-active', 'is-flashing'); $('speechBubble').textContent = 'What shall we do next?'; $('sceneCaption').textContent = 'A little hello goes a long way.'; refreshBusy(); }
  function setView(next, cancel = true) {
    if (cancel && (busy() || currentGame)) exitGame();
    view = next;
    for (const id of ['play', 'create', 'badges']) $(id + 'View').hidden = id !== next;
    document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('selected', b.dataset.view === next); if (b.dataset.view === next) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  }
  async function runSolo(title, steps, quip, isRecipe = false) {
    if (busy() || bridge.stopPending || bridge.status === 'connecting') return false;
    if (bridge.status === 'offline') { showConnection(); return false; }
    sound.unlock(); exitGame(); const id = ++runNumber, controller = new AbortController(); solo = { id, controller, title }; refreshBusy();
    $('speechBubble').textContent = quip || 'Your moves. My tiny wheels.'; $('sceneCaption').textContent = title + (bridge.connected && !bridge.floor ? ' · Lights only on the real Evo.' : ' · Let’s do this.');
    try {
      await perform(steps, controller.signal);
      if (id !== runNumber || controller.signal.aborted) return false;
      if (isRecipe) { award('maker'); save(); $('builderNote').textContent = 'Masterpiece performed! Mix it up and make another.'; }
      scene.celebrate(); sound.win(); $('speechBubble').textContent = 'Again? I could do this all day.';
      return true;
    } catch (error) { if (error.name !== 'AbortError') { toast(error.message); $('builderNote').textContent = error.message; } return false; }
    finally { if (solo?.id === id) solo = null; refreshBusy(); }
  }
  function recipeSteps(recipe = prefs.recipe) { return recipe.flatMap(id => N.MOVES[id]?.steps || []); }
  function recipeDuration(recipe = prefs.recipe) { return recipeSteps(recipe).reduce((sum, step) => sum + N.stepTime(step), 0); }
  function renderRecipe() {
    $('recipeDuration').textContent = recipeDuration().toFixed(1) + ' / 7 seconds';
    $('recipeList').replaceChildren(...prefs.recipe.map((id, index) => { const item = el('li'); item.append(el('span', String(index + 1)), el('b', N.MOVES[id].icon + ' ' + N.MOVES[id].title)); const remove = button('×', '', () => { if (busy()) return; prefs.recipe.splice(index, 1); save(); renderRecipe(); }); remove.setAttribute('aria-label', 'Remove move ' + (index + 1) + ': ' + N.MOVES[id].title); item.append(remove); return item; }));
    $('emptyRecipe').hidden = prefs.recipe.length > 0; $('undoMove').disabled = $('clearRecipe').disabled = !prefs.recipe.length; refreshBusy();
  }
  function canAddMove(id) {
    if (busy()) { toast('Stop the current activity before changing your routine.'); return; }
    const next = [...prefs.recipe, id];
    if (next.length > 8 || recipeSteps(next).length > 16 || recipeDuration(next) > 7) { $('builderNote').textContent = 'That’s a full little routine! Remove a move to make room.'; return false; }
    return true;
  }
  function addMove(id) {
    if (!canAddMove(id)) return;
    const next = [...prefs.recipe, id];
    prefs.recipe = next; $('builderNote').textContent = N.MOVES[id].title + ' added. What comes next?'; save(); renderRecipe();
  }
  function renderBadges() {
    $('badgeCount').textContent = BADGES.filter(b => prefs.badges.includes(b.id)).length;
    $('gamesPlayed').textContent = prefs.plays ? prefs.plays + (prefs.plays === 1 ? ' game played. A great beginning.' : ' games played. Look at you go!') : 'Your first adventure is waiting.';
    $('badgeShelf').replaceChildren(...BADGES.map(b => { const earned = prefs.badges.includes(b.id), card = el('article', undefined, 'badge' + (earned ? ' earned' : '')); const icon = el('div', b.icon, 'badge-icon'); icon.setAttribute('aria-hidden', 'true'); card.append(icon, el('h3', b.title), el('p', b.description), el('small', earned ? 'YOU EARNED IT' : 'WAITING FOR YOU')); return card; }));
  }
  function showConnection() { if (busy()) { toast('Stop the current activity before changing robot setup.'); return; } $('connectionDialog').showModal(); renderConnection(); }
  function renderConnection() {
    const s = bridge.state();
    $('connectionLabel').textContent = s.status === 'connecting' ? 'Connecting…' : s.connected ? (s.simulator ? 'Sim bridge' : prefs.name + ' is here') : s.status === 'offline' ? 'Reconnect Ozi' : 'Connect Ozi';
    $('connectButton').classList.toggle('connected', s.connected);
    $('stageMode').textContent = s.connected ? (s.simulator ? 'BRIDGE SIMULATION' : s.floor ? 'REAL EVO · FLOOR PLAY' : 'REAL EVO · LIGHTS ONLY') : s.status === 'offline' ? 'ROBOT LINK LOST' : s.status === 'connecting' ? 'CONNECTING…' : 'SCREEN PLAY';
    $('floorButton').textContent = s.floor ? 'Floor play enabled ✓' : 'Set up floor play ↗';
    $('floorButton').classList.toggle('armed', s.floor);
    $('playModeNote').textContent = s.connected ? (s.simulator ? 'Simulator bridge only. No physical robot is connected.' : s.floor ? 'Ozi’s wheels are ready. Pick a game or trick to start moving.' : 'Ozi’s lights are ready. Set up floor play to unlock scoots and spins.') : s.status === 'offline' ? 'The robot link is unavailable. Reconnect or choose screen play.' : 'Screen play is ready. Connect your Evo to play together.';
    $('footerMode').textContent = s.connected ? (s.simulator ? 'Bridge simulation · No physical robot' : s.floor ? 'Supervised floor play · STOP locks the wheels' : 'Lights-only play · Wheels locked') : s.status === 'offline' ? 'Robot disconnected · No automatic reconnect' : 'Screen play · No robot connected';
    $('pairButton').disabled = s.status === 'connecting' || s.connected; $('pairButton').textContent = s.status === 'connecting' ? 'Finding Ozi…' : 'Connect my Evo ↗';
    $('disconnectButton').hidden = !s.connected && s.status !== 'connecting';
    $('connectionMessage').textContent = s.message || 'Screen play works right away, even without a robot.';
    $('connectionMessage').className = 'setup-status' + (s.status === 'offline' ? ' error' : s.connected ? ' success' : '');
    $('bridgeVersion').textContent = s.protocol ? 'Connected bridge protocol: ' + s.protocol + '. Floor play requires version 4.' : 'This playroom needs bridge version 4 for floor play.';
    if (!s.floor) $('floorConsent').checked = false;
    refreshBusy();
  }
  bridge.addEventListener('state', renderConnection);
  bridge.addEventListener('lost', () => { stopAll(bridge.message, false); toast(bridge.message); });
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('.start-game').forEach(b => b.addEventListener('click', () => startGame(b.dataset.game)));
  document.querySelectorAll('[data-trick]').forEach(b => b.addEventListener('click', () => { const t = N.TRICKS[b.dataset.trick]; runSolo(t.title, t.steps, t.quip); }));
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); setView('play'); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('helloButton').addEventListener('click', () => runSolo('A little hello', [{ led: '#7ce0bd', wait: .35 }, { led: '#ffb0cd', wait: .3 }, { led: '#7ce0bd', wait: .3 }], 'Hi! I’m ' + prefs.name + '. Your turn to smile.'));
  $('exitActivity').addEventListener('click', exitGame);
  $('stopButton').addEventListener('click', () => stopAll('Stopped. Pick another game when you’re ready.'));
  $('connectButton').addEventListener('click', showConnection); $('floorButton').addEventListener('click', showConnection);
  $('floorConsent').addEventListener('change', refreshBusy);
  $('connectForm').addEventListener('submit', async event => { event.preventDefault(); if (busy()) return; try { await bridge.connect($('bridgeKey').value); } catch (e) { toast(e.message); } });
  $('disconnectButton').addEventListener('click', async () => { stopAll('Robot disconnected.', false); await bridge.disconnect(); renderConnection(); });
  $('armFloor').addEventListener('click', async () => {
    if (!$('floorConsent').checked || busy()) return;
    $('armFloor').disabled = true;
    try { await bridge.setFloor(true); $('connectionDialog').close(); toast('Wheels ready! Choose a game or trick to start.'); } catch (e) { toast(e.message); } finally { refreshBusy(); }
  });
  $('deskMode').addEventListener('click', async () => { try { await bridge.setFloor(false); $('connectionDialog').close(); toast('Lights only. Wheels are locked.'); } catch (e) { toast(e.message); } });
  $('screenPlay').addEventListener('click', async () => { stopAll('Switching to screen play.', false); $('screenPlay').disabled = true; await bridge.disconnect(true); $('screenPlay').disabled = false; $('connectionDialog').close(); exitGame(); });
  $('settingsButton').addEventListener('click', () => { if (busy()) stopAll('Paused for grown-up settings.'); $('petName').value = prefs.name; $('settingsDialog').showModal(); });
  $('openConnectionFromSettings').addEventListener('click', () => { $('settingsDialog').close(); showConnection(); });
  $('nameForm').addEventListener('submit', event => { event.preventDefault(); prefs.name = $('petName').value.trim().slice(0, 24) || 'Ozi'; save(); $('settingsDialog').close(); renderConnection(); $('speechBubble').textContent = 'Hi! I’m ' + prefs.name + '.'; });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $(b.dataset.close).close()));
  function renderSound() { $('soundButton').setAttribute('aria-pressed', String(sound.enabled)); $('soundButton').setAttribute('aria-label', 'Turn sound ' + (sound.enabled ? 'off' : 'on')); }
  $('soundButton').addEventListener('click', async () => { sound.enabled = !sound.enabled; prefs.sound = sound.enabled; save(); renderSound(); if (sound.enabled) { await sound.unlock(); sound.note(); } else sound.stop(); });
  function setMoveMode(mode) {
    moveMode = mode;
    $('driveMode').setAttribute('aria-pressed', String(mode === 'drive'));
    $('buildMode').setAttribute('aria-pressed', String(mode === 'build'));
    $('moveModeHelp').textContent = mode === 'drive' ? 'Tap a move and Ozi does it now.' : 'Each tap previews the move and adds it to your routine.';
    $('moveHint').textContent = mode === 'drive' ? 'Tap a button to play that move. For real wheels, enable floor play.' : 'Each tap makes Ozi try the move, then adds it. Up to 8 moves and 7 seconds.';
  }
  $('driveMode').addEventListener('click', () => setMoveMode('drive'));
  $('buildMode').addEventListener('click', () => setMoveMode('build'));
  $('movePalette').replaceChildren(...Object.entries(N.MOVES).map(([id, move]) => { const b = button('', '', async () => {
    const building = moveMode === 'build';
    if (building && !canAddMove(id)) return;
    if (bridge.connected && !bridge.floor && move.steps.some(step => step.move || step.turn)) { toast('Wheels are locked. Enable floor play to preview this move on the real Evo.'); return; }
    const completed = await runSolo(move.title, move.steps, 'Here comes ' + move.title.toLowerCase() + '!');
    if (building && completed) addMove(id);
  }); b.dataset.move = id; b.append(el('span', move.icon), el('small', move.title)); return b; }));
  $('undoMove').addEventListener('click', () => { if (busy()) return; prefs.recipe.pop(); save(); renderRecipe(); });
  $('clearRecipe').addEventListener('click', () => { if (busy()) return; prefs.recipe = []; save(); renderRecipe(); });
  $('runRecipe').addEventListener('click', () => runSolo('Your masterpiece', recipeSteps(), 'Your moves. My tiny wheels.', true));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (busy() || bridge.floor) stopAll('Stopped with Escape.'); return; }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || document.querySelector('dialog[open]')) return;
    let answer = null;
    if (currentGame?.input === 'freeze' && event.code === 'Space' && event.target.tagName !== 'BUTTON') answer = 'freeze';
    if (currentGame?.input === 'colors' && /^[1-4]$/.test(event.key)) answer = currentGame.choices[Number(event.key) - 1]?.id;
    if (currentGame?.input === 'drive') answer = ({ ArrowUp: 'forward', ArrowLeft: 'left', ArrowRight: 'right' })[event.key];
    if (answer) { event.preventDefault(); activities.input(answer); }
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); if (document.fullscreenElement) document.exitFullscreen?.(); else $('main').requestFullscreen?.().catch(() => {}); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && (busy() || bridge.floor)) stopAll('Paused because this tab was hidden. Start again when you’re ready.'); lastFrame = performance.now(); });
  window.addEventListener('pagehide', () => {
    if (bridge.key && bridge.connected) fetch('http://127.0.0.1:8787/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OzoPet-Key': bridge.key }, body: '{}', keepalive: true }).catch(() => {});
  });
  function renderScene() { scene.render(); if (view === 'create') $('movePreview').getContext('2d').drawImage($('playground'), 0, 0, 280, 212); }
  function frame(at) { if (!advancing) clock.tick(Math.min(100, Math.max(0, at - lastFrame))); lastFrame = at; renderScene(); requestAnimationFrame(frame); }
  window.render_game_to_text = () => JSON.stringify({ view, busy: busy(), game: currentGame, robot: bridge.state(), recipe: prefs.recipe, recipeSeconds: recipeDuration(), scores: prefs.scores, badges: prefs.badges, scene: { ...scene.currentPose(), color: scene.color, coordinateSystem: 'Canvas origin top-left. x increases right; y increases down. Trail cells are a plan, not real robot location.' } });
  window.advanceTime = async ms => {
    // Deterministic screen tests must never accelerate commands to a real robot.
    if (bridge.connected) throw new Error('Deterministic time is available only in screen play.');
    advancing = true;
    try { for (let elapsed = 0; elapsed < Math.min(ms, 120000); elapsed += 20) { clock.tick(Math.min(20, ms - elapsed)); for (let i = 0; i < 8; i++) await Promise.resolve(); } renderScene(); }
    finally { advancing = false; lastFrame = performance.now(); }
  };
  // Reject an invalid saved routine instead of relying on server truncation.
  while (prefs.recipe.length && (recipeDuration() > 7 || recipeSteps().length > 16)) prefs.recipe.pop();
  renderBadges(); renderRecipe(); renderSound(); renderConnection(); scene.render(); requestAnimationFrame(frame);
  setInterval(() => bridge.poll(), 8000);
})();
