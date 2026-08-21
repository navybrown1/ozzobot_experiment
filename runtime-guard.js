(() => {
  'use strict';

  const STORAGE_KEY = 'ozopet-state-v1';
  const MOTOR_ACTIONS = new Set(['move', 'turn', 'dance']);
  const ALLOWED_ZONES = new Set(['nest', 'food', 'play', 'mystery', 'center']);
  const GESTURE_WINDOW_MS = 1500;
  let lastTrustedGestureAt = 0;

  function clampNumber(value, fallback, min = 0, max = 100) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function readStoredState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function sanitizeStoredState() {
    try {
      const state = readStoredState();
      if (!state || typeof state !== 'object' || state.version !== 1) return;

      state.day = Math.max(1, Math.floor(clampNumber(state.day, 1, 1, 999999)));
      state.awake = typeof state.awake === 'boolean' ? state.awake : true;
      state.living = typeof state.living === 'boolean' ? state.living : true;
      state.zone = ALLOWED_ZONES.has(state.zone) ? state.zone : 'nest';
      state.memories = Array.isArray(state.memories) ? state.memories.slice(-80) : [];
      state.dreams = Array.isArray(state.dreams) ? state.dreams.slice(-40) : [];
      state.vitals = state.vitals && typeof state.vitals === 'object' ? state.vitals : {};
      state.dna = state.dna && typeof state.dna === 'object' ? state.dna : {};

      for (const key of ['energy', 'curiosity', 'social', 'confidence', 'mischief', 'boredom', 'trust']) {
        state.vitals[key] = clampNumber(state.vitals[key], 50);
      }
      for (const key of ['curiosity', 'courage', 'affection', 'independence', 'mischief', 'patience', 'obedience', 'persistence', 'weirdness']) {
        state.dna[key] = clampNumber(state.dna[key], 50);
      }

      // The bridge key is a short-lived local secret. Never carry it between browser sessions.
      state.hardware = state.hardware && typeof state.hardware === 'object' ? state.hardware : {};
      state.hardware.connected = false;
      state.hardware.key = '';

      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The main app already has a no-state fallback. Do not make startup depend on storage.
    }
  }

  function noteTrustedGesture(event) {
    if (event.isTrusted) lastTrustedGestureAt = Date.now();
  }

  function hasFreshTrustedGesture() {
    return Date.now() - lastTrustedGestureAt <= GESTURE_WINDOW_MS;
  }

  function installMotorSafetyGuard() {
    const nativeFetch = window.fetch.bind(window);

    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url;
      const isBridgeAction = typeof url === 'string' && /^http:\/\/127\.0\.0\.1:8787\/action(?:$|[?#])/.test(url);

      if (isBridgeAction && String(init.method || 'GET').toUpperCase() === 'POST') {
        try {
          const payload = typeof init.body === 'string' ? JSON.parse(init.body) : null;
          if (payload && MOTOR_ACTIONS.has(payload.action) && !hasFreshTrustedGesture()) {
            return new Response(JSON.stringify({
              ok: true,
              action: payload.action,
              blocked: true,
              reason: 'autonomous physical motion requires a fresh user gesture'
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        } catch {
          // If a request cannot be inspected, let the bridge validate it normally.
        }
      }

      return nativeFetch(input, init);
    };
  }

  function installSleepingZoneGuard() {
    document.addEventListener('click', event => {
      const zone = event.target.closest?.('[data-zone]');
      if (!zone) return;

      const state = readStoredState();
      if (state?.awake === false) {
        event.preventDefault();
        event.stopImmediatePropagation();

        const line = 'I am asleep. The map can wait until morning.';
        const ambient = document.querySelector('#ambientText');
        const mind = document.querySelector('#mindText');
        if (ambient) ambient.textContent = line;
        if (mind) mind.textContent = line;
      }
    }, true);
  }

  function installMindstreamSync() {
    const ambient = document.querySelector('#ambientText');
    const mind = document.querySelector('#mindText');
    if (!ambient || !mind) return;

    const sync = () => {
      if (ambient.textContent && mind.textContent !== ambient.textContent) {
        mind.textContent = ambient.textContent;
      }
    };

    new MutationObserver(sync).observe(ambient, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  sanitizeStoredState();
  document.addEventListener('pointerdown', noteTrustedGesture, true);
  document.addEventListener('keydown', noteTrustedGesture, true);
  installMotorSafetyGuard();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      installSleepingZoneGuard();
      installMindstreamSync();
    }, { once: true });
  } else {
    installSleepingZoneGuard();
    installMindstreamSync();
  }
})();
