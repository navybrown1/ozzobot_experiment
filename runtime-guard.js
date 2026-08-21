(() => {
  'use strict';

  const STORAGE_KEY = 'ozopet-state-v1';
  const MOTOR_ACTIONS = new Set(['move', 'turn', 'dance']);
  const ALLOWED_ZONES = new Set(['nest', 'food', 'play', 'mystery', 'center']);
  const MOTOR_INTENTS = [
    '[data-hw="forward"]',
    '[data-hw="back"]',
    '[data-hw="left"]',
    '[data-hw="right"]',
    '[data-action="explore"]',
    '[data-action="dance"]',
    '[data-action="mischief"]'
  ].join(',');
  const GESTURE_WINDOW_MS = 900;
  let motorPermitUntil = 0;
  let eraseArmedUntil = 0;

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

      // Bridge keys are short-lived localhost secrets. Never restore one after a page load.
      state.hardware = state.hardware && typeof state.hardware === 'object' ? state.hardware : {};
      state.hardware.connected = false;
      state.hardware.key = '';

      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The main app already has a safe default-state fallback.
    }
  }

  function armMotorIntent(event) {
    if (!event.isTrusted) return;
    const target = event.target?.closest?.(MOTOR_INTENTS);
    if (!target) return;
    motorPermitUntil = Date.now() + GESTURE_WINDOW_MS;
  }

  function consumeMotorPermit() {
    if (Date.now() > motorPermitUntil) return false;
    motorPermitUntil = 0;
    return true;
  }

  function installMotorSafetyGuard() {
    const nativeFetch = window.fetch.bind(window);

    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url;
      const isBridgeAction = typeof url === 'string' && /^http:\/\/127\.0\.0\.1:8787\/action(?:$|[?#])/.test(url);

      if (isBridgeAction && String(init.method || 'GET').toUpperCase() === 'POST') {
        try {
          const payload = typeof init.body === 'string' ? JSON.parse(init.body) : null;
          if (payload && MOTOR_ACTIONS.has(payload.action) && !consumeMotorPermit()) {
            return new Response(JSON.stringify({
              ok: true,
              action: payload.action,
              blocked: true,
              reason: 'physical motion requires an explicit user control gesture'
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        } catch {
          // Let the localhost bridge perform its own validation when inspection is impossible.
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

  function installMemoryEraseGuard() {
    const button = document.querySelector('#clearMemories');
    if (!button) return;
    const original = button.textContent || 'ERASE';

    button.addEventListener('click', event => {
      const now = Date.now();
      if (now <= eraseArmedUntil) {
        eraseArmedUntil = 0;
        button.textContent = original;
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      eraseArmedUntil = now + 3000;
      button.textContent = 'CONFIRM?';
      setTimeout(() => {
        if (Date.now() > eraseArmedUntil) {
          eraseArmedUntil = 0;
          button.textContent = original;
        }
      }, 3100);
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

  function installFooterSync() {
    const footer = document.querySelector('#footerStatus');
    if (!footer) return;

    const sync = () => {
      const state = readStoredState();
      if (state?.awake === false && footer.textContent?.startsWith('simulation awake')) {
        footer.textContent = 'simulation asleep // no hardware commands sent';
      }
    };

    new MutationObserver(sync).observe(footer, {
      childList: true,
      characterData: true,
      subtree: true
    });
    queueMicrotask(sync);
  }

  sanitizeStoredState();
  document.addEventListener('pointerdown', armMotorIntent, true);
  document.addEventListener('keydown', armMotorIntent, true);
  installMotorSafetyGuard();

  const installDomGuards = () => {
    installSleepingZoneGuard();
    installMemoryEraseGuard();
    installMindstreamSync();
    installFooterSync();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installDomGuards, { once: true });
  } else {
    installDomGuards();
  }
})();
