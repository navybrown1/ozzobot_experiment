/* OziPet.Follow — webcam color-card tracker (AGENT-FOLLOW scope, see ozi-contract.md FOLLOW API).
 * Pure canvas pixel math (RGB→HSV + hue-window centroid), no ML libs, no eval, no external calls
 * except the contract's GET /proximity fallback. Requires OziPet.Bus + OziPet.Safety; if either is
 * missing this file self-disables into a safe no-op stub. UI passes in video/canvas elements; we
 * never touch the DOM beyond drawImage/getImageData on those refs and never append anything.
 * Pipeline: getUserMedia(environment,320w) → rAF downsample ≤96x72 → _analyze() centroid of pixels
 * within ±25° hue window + sat/val floors → at most ONE Safety.execSteps(source:'autonomous') per
 * ≥900ms: |err|>0.18→turn(≤25°), else approach (come always / follow when far), else arrived/close.
 * Hard safety: lost>1.2s, tab hidden/blur, Bus estop, camera track ended, user stop — all halt
 * motors + camera; stop() idempotent; NEVER auto-starts. Floor-mode enforcement stays in Safety;
 * on refusal Follow stops and emits follow {state:'error',detail:'floor mode required'}.
 * Turn sign convention matches app.js hardware buttons: positive angle = left = CCW.
 */
(() => {
  'use strict';

  const G = typeof window !== 'undefined' ? window : globalThis;
  G.OziPet = G.OziPet || {};
  const root = G.OziPet;

  const CFG = {
    W: 96, H: 72,
    HUE_TOL: 25,
    MIN_PX: 25,
    FAR_SIZE: 0.05,
    CLOSE_SIZE: 0.10,
    ERR_TH: 0.18,
    TURN_GAIN: -60,
    MAX_TURN: 25,
    TURN_SPEED: 60,
    MOVE_MIN: 35,
    MOVE_MAX: 40,
    MOVE_SPEED: 35,
    PULSE_MS: 900,
    LOST_MS: 1200,
    SAMPLE_MS: 66,
    PROX_MS: 1000,
    HEART_MS: 3000
  };

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: mx === 0 ? 0 : d / mx, v: mx };
  }

  function analyzeImpl(px, w, h, target) {
    const total = Math.max(0, w | 0) * Math.max(0, h | 0);
    const out = { found: false, count: 0, total, err: null, size: 0, cx: null, cy: null };
    if (!px || !total || px.length < total * 4 || !target) return out;
    const tH = ((Number.isFinite(target.h) ? target.h : 0) % 360 + 360) % 360;
    const tS = Number.isFinite(target.s) ? target.s : 0.5;
    const tV = Number.isFinite(target.v) ? target.v : 0.5;
    const sFloor = Math.max(0.18, Math.min(0.85, tS * 0.55));
    const vFloor = Math.max(0.12, tV * 0.45);
    let count = 0, sx = 0, sy = 0;
    for (let i = 0; i < total; i++) {
      const o = i * 4;
      if (px[o] + px[o + 1] + px[o + 2] < 30) continue;
      const c = rgbToHsv(px[o], px[o + 1], px[o + 2]);
      if (c.s < sFloor || c.v < vFloor) continue;
      let dh = Math.abs(c.h - tH);
      if (dh > 180) dh = 360 - dh;
      if (dh <= CFG.HUE_TOL) {
        count++;
        sx += (i % w) + 0.5;
        sy += ((i / w) | 0) + 0.5;
      }
    }
    out.count = count;
    out.size = count / total;
    if (count < CFG.MIN_PX) return out;
    out.found = true;
    out.cx = sx / count;
    out.cy = sy / count;
    out.err = (out.cx - w / 2) / w;
    return out;
  }

  function normalizeTarget(input) {
    if (!input) return null;
    if (typeof input === 'string') {
      const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
      if (!m) return null;
      let hex = m[1];
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
      return rgbToHsv(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
    }
    if (Number.isFinite(input.h)) {
      return {
        h: ((input.h % 360) + 360) % 360,
        s: Number.isFinite(input.s) ? input.s : 0.5,
        v: Number.isFinite(input.v) ? input.v : 0.5
      };
    }
    if ([input.r, input.g, input.b].every(Number.isFinite)) return rgbToHsv(input.r, input.g, input.b);
    return null;
  }

  const hasBus = !!(root.Bus && typeof root.Bus.on === 'function' && typeof root.Bus.emit === 'function');
  const hasSafety = !!(root.Safety && typeof root.Safety.execSteps === 'function');

  if (!hasBus || !hasSafety) {
    root.Follow = {
      available: () => false,
      calibrate: async () => null,
      start: async () => false,
      stop: () => {},
      state: () => ({ active: false, disabled: true }),
      _analyze: analyzeImpl,
      _cfg: CFG
    };
    return;
  }

  const Bus = root.Bus;

  let active = false, startingLock = false, mode = null;
  let stream = null, track = null, videoEl = null, canvasEl = null, ctx = null;
  let rafId = 0, proxTimer = 0;
  let target = null;
  let lastSampleTs = 0, lastPulseTs = 0, firstMissingTs = 0;
  let lostFlag = false, acquiredOnce = false, arrivedAnnounced = false;
  let obstacleFront = false, lastResults = null;
  let offEstop = null, lastKey = '', lastKeyAt = 0, lastExpressAt = 0;
  let gen = 0;

  function emit(state, detail, force) {
    const key = state + '|' + (detail == null ? '' : detail);
    const t = Date.now();
    if (!force && key === lastKey && t - lastKeyAt < CFG.HEART_MS) return;
    lastKey = key; lastKeyAt = t;
    try { Bus.emit('follow', detail == null ? { state } : { state, detail }); } catch (e) {}
  }

  function performExpress(name, fallbackAnim) {
    const P = root.Perform;
    try {
      if (P && typeof P.express === 'function') { P.express(name); return; }
    } catch (e) {}
    try { Bus.emit('anim', { name: fallbackAnim }); } catch (e) {}
  }

  function performChirp(kind) {
    const P = root.Perform;
    try { if (P && typeof P.chirp === 'function') P.chirp(kind); } catch (e) {}
  }

  function sizeCanvas(canvas, video) {
    const vw = (video && video.videoWidth) || 320;
    const vh = (video && video.videoHeight) || 240;
    canvas.width = CFG.W;
    const ratio = vw > 0 ? vh / vw : 0.75;
    canvas.height = Math.max(48, Math.min(CFG.H, Math.round(CFG.W * ratio) || CFG.H));
  }

  async function calibrate(opts) {
    opts = opts || {};
    const video = opts.video, canvas = opts.canvas;
    if (!video || !canvas || typeof canvas.getContext !== 'function' || video.readyState < 2) return null;
    try {
      sizeCanvas(canvas, video);
      const c2d = canvas.getContext('2d', { willReadFrequently: true });
      if (!c2d) return null;
      c2d.drawImage(video, 0, 0, canvas.width, canvas.height);
      const nx = opts.x > 1 ? opts.x / canvas.width : (+opts.x || 0);
      const ny = opts.y > 1 ? opts.y / canvas.height : (+opts.y || 0);
      const cxp = Math.round(Math.max(0, Math.min(1, nx)) * (canvas.width - 1));
      const cyp = Math.round(Math.max(0, Math.min(1, ny)) * (canvas.height - 1));
      const half = 4;
      const img = c2d.getImageData(
        Math.max(0, cxp - half), Math.max(0, cyp - half),
        Math.min(canvas.width, cxp + half + 1) - Math.max(0, cxp - half),
        Math.min(canvas.height, cyp + half + 1) - Math.max(0, cyp - half)
      );
      let sxc = 0, syc = 0, sSum = 0, vSum = 0, n = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const c = rgbToHsv(img.data[i], img.data[i + 1], img.data[i + 2]);
        if (c.s < 0.12 || c.v < 0.12) continue;
        const rad = c.h * Math.PI / 180;
        sxc += Math.cos(rad) * c.s;
        syc += Math.sin(rad) * c.s;
        sSum += c.s; vSum += c.v; n++;
      }
      if (n < 4) return { h: null, s: null, v: null, count: n, error: 'low-signal region' };
      let hDeg = Math.atan2(syc / n, sxc / n) * 180 / Math.PI;
      if (hDeg < 0) hDeg += 360;
      const ref = { h: hDeg, s: sSum / n, v: vSum / n };
      target = ref;
      return { h: Math.round(hDeg), s: +(sSum / n).toFixed(3), v: +(vSum / n).toFixed(3), count: n };
    } catch (e) {
      return null;
    }
  }

  function safetySnapshot() {
    try { return (typeof root.Safety.state === 'function' && root.Safety.state()) || {}; }
    catch (e) { return {}; }
  }

  function failFloor(detail) {
    emit('error', detail || 'floor mode required', true);
    halt(detail || 'floor mode required');
  }

  async function sendPulse(steps) {
    const st = safetySnapshot();
    if (st.estopped) { halt('estop'); return; }
    if (st.connected && (st.mode !== 'floor' || !st.floorConfirmed)) { failFloor(); return; }
    let out = null;
    try {
      out = await root.Safety.execSteps(steps, { source: 'autonomous', label: 'follow:' + (mode || '') });
    } catch (err) {
      out = { ok: false, refused: true, error: String((err && err.message) || err) };
    }
    const blob = JSON.stringify(out || {}).slice(0, 600);
    if (out && (out.refused || out.rejected || out.blocked || /floor/i.test(String(out.reason || out.error || '') + (/floor/i.test(blob) && out.ok === false ? ' floor' : '')))) {
      failFloor();
      return;
    }
    lastPulseTs = Date.now();
  }

  function handleTracking(res, frameTs) {
    const now = frameTs;
    if (!res.found) {
      if (!firstMissingTs) firstMissingTs = now;
      else if (!lostFlag && now - firstMissingTs >= CFG.LOST_MS) {
        lostFlag = true;
        emit('lost', 'target lost', true);
        if (Date.now() - lastExpressAt > 2500) {
          lastExpressAt = Date.now();
          performExpress('suspicious', 'shiver');
        }
      }
      return;
    }
    firstMissingTs = 0;
    if (lostFlag) { lostFlag = false; emit('tracking', 'reacquired'); }
    if (!acquiredOnce) { acquiredOnce = true; emit('tracking', 'acquired'); }
    if (lostFlag || now - lastPulseTs < CFG.PULSE_MS) return;

    const errAbs = Math.abs(res.err);
    if (errAbs > CFG.ERR_TH) {
      const angle = Math.max(-CFG.MAX_TURN, Math.min(CFG.MAX_TURN, Math.round(res.err * CFG.TURN_GAIN)));
      sendPulse([{ turn: { angle, speed: CFG.TURN_SPEED } }]);
      return;
    }
    const wantsApproach = mode !== 'hand' && (mode === 'come' || res.size < CFG.FAR_SIZE);
    if (wantsApproach) {
      if (obstacleFront) {
        emit('tracking', 'obstacle');
        return;
      }
      const farness = Math.max(0, Math.min(1, (CFG.FAR_SIZE - res.size) / CFG.FAR_SIZE));
      const dist = Math.round(CFG.MOVE_MIN + (CFG.MOVE_MAX - CFG.MOVE_MIN) * farness);
      sendPulse([{ move: { distance: dist, speed: CFG.MOVE_SPEED } }]);
      return;
    }
    const closeHappy = mode === 'hand'
      ? res.size >= CFG.CLOSE_SIZE
      : errAbs <= CFG.ERR_TH && res.size >= CFG.FAR_SIZE;
    if (closeHappy) {
      if (!arrivedAnnounced) {
        arrivedAnnounced = true;
        performExpress('happy', 'bop');
        performChirp('hello');
      }
      emit('tracking', mode === 'hand' ? 'close' : 'arrived');
    } else {
      arrivedAnnounced = false;
    }
  }

  function frame(ts) {
    if (!active) return;
    rafId = requestAnimationFrame(frame);
    if (!videoEl || !canvasEl || !ctx || videoEl.readyState < 2) return;
    if (ts - lastSampleTs < CFG.SAMPLE_MS) return;
    lastSampleTs = ts;
    let res = { found: false, count: 0, total: 0, err: null, size: 0, cx: null, cy: null };
    try {
      ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
      const img = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
      res = target ? analyzeImpl(img.data, canvasEl.width, canvasEl.height, target)
                   : Object.assign(res, { total: canvasEl.width * canvasEl.height });
    } catch (e) {}
    lastResults = res;
    try { handleTracking(res, ts); } catch (e) {}
  }

  async function pollProximity() {
    if (!active) return;
    try {
      const S = root.Safety;
      let out = null;
      if (typeof S.pollProximity === 'function') {
        out = await S.pollProximity(); // authenticated + updates Safety's own guard state
      } else if (typeof fetch === 'function') {
        let key = '';
        try {
          key = (((root.Store && root.Store.state) ? root.Store.state : {}).hardware || {}).key || '';
        } catch (e) {}
        const resp = await fetch('http://127.0.0.1:8787/proximity', { headers: key ? { 'X-OzoPet-Key': key } : undefined });
        out = await resp.json();
      } else {
        return;
      }
      const front = out && out.front;
      const hit = !!(front && (front.left || front.right));
      if (hit && !obstacleFront) emit('tracking', 'obstacle');
      obstacleFront = hit;
    } catch (e) {}
  }

  function teardown() {
    gen++;
    active = false; startingLock = false;
    if (rafId) { try { cancelAnimationFrame(rafId); } catch (e) {} rafId = 0; }
    if (proxTimer) { try { clearInterval(proxTimer); } catch (e) {} proxTimer = 0; }
    try { document.removeEventListener('visibilitychange', onVisibility); } catch (e) {}
    try { if (G.removeEventListener) G.removeEventListener('blur', onBlur); } catch (e) {}
    if (offEstop) { try { offEstop(); } catch (e) {} offEstop = null; }
    if (track) { try { track.removeEventListener('ended', onTrackEnded); } catch (e) {} }
    try { if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); } catch (e) {}
    if (track) { try { track.stop(); } catch (e) {} }
    track = null; stream = null; videoEl = null; canvasEl = null; ctx = null;
    lastResults = null;
  }

  function halt(reason) {
    const wasActive = active || !!stream;
    teardown();
    if (wasActive) emit('stopped', reason, true);
  }

  function onVisibility() {
    const hidden = (typeof document !== 'undefined') &&
      (document.visibilityState === 'hidden' || document.hidden === true);
    if (hidden) halt('tab hidden');
  }
  function onBlur() { halt('window blurred'); }
  function onTrackEnded() { halt('camera ended'); }
  function onEstop() { halt('estop'); }

  async function start(modeName, opts) {
    opts = opts || {};
    if (active || startingLock) { emit('error', 'already running', true); return false; }
    if (['follow', 'come', 'hand'].indexOf(modeName) < 0) { emit('error', 'unknown mode', true); return false; }
    const video = opts.video, canvas = opts.canvas;
    if (!video || !canvas || typeof canvas.getContext !== 'function') {
      emit('error', 'missing video/canvas', true);
      return false;
    }
    const t = normalizeTarget(opts.targetColor) || target;
    if (!t) { emit('error', 'no calibrated target', true); return false; }
    if (!available()) { emit('error', 'camera unavailable', true); return false; }
    startingLock = true;
    const myGen = ++gen;
    emit('starting', modeName, true);
    let str = null;
    try {
      str = await G.navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 320 } },
        audio: false
      });
    } catch (e) {
      startingLock = false;
      emit('error', 'camera unavailable', true);
      return false;
    }
    if (myGen !== gen) {
      try { str.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); } catch (e) {}
      emit('stopped', 'cancelled', true);
      return false;
    }
    stream = str;
    track = (str.getTracks()[0]) || null;
    if (track && typeof track.addEventListener === 'function') {
      track.addEventListener('ended', onTrackEnded);
    }
    videoEl = video; canvasEl = canvas;
    sizeCanvas(canvas, video);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) { startingLock = false; halt('canvas unavailable'); return false; }
    mode = modeName; target = t;
    active = true; startingLock = false;
    lastSampleTs = 0; lastPulseTs = 0; firstMissingTs = 0;
    lostFlag = false; acquiredOnce = false; arrivedAnnounced = false;
    obstacleFront = false; lastResults = null;
    try { document.addEventListener('visibilitychange', onVisibility); } catch (e) {}
    try { if (G.addEventListener) G.addEventListener('blur', onBlur); } catch (e) {}
    try { offEstop = Bus.on('estop', onEstop); } catch (e) { offEstop = null; }
    proxTimer = setInterval(pollProximity, CFG.PROX_MS);
    rafId = requestAnimationFrame(frame);
    return true;
  }

  function available() {
    return !!(G.navigator && G.navigator.mediaDevices && typeof G.navigator.mediaDevices.getUserMedia === 'function');
  }

  root.Follow = {
    available,
    calibrate,
    start,
    stop: () => halt('stopped by user'),
    state: () => ({
      active,
      mode,
      tracking: !!(active && lastResults && lastResults.found && !lostFlag),
      lost: lostFlag,
      obstacle: obstacleFront,
      lastError: lastResults ? { err: lastResults.err, size: +lastResults.size.toFixed(4), count: lastResults.count } : null,
      target: target ? { h: Math.round(target.h), s: +target.s.toFixed(3), v: +target.v.toFixed(3) } : null
    }),
    _analyze: analyzeImpl,
    _cfg: CFG
  };
})();
