(() => {
  'use strict';

  const STORAGE_KEY = 'ozopet-state-v1';
  const MOTOR_ACTIONS = new Set(['move', 'turn', 'dance']);
  const ALLOWED_ZONES = new Set(['nest', 'food', 'play', 'mystery', 'center']);
  const TOP_LEVEL_KEYS = new Set(['version', 'name', 'day', 'awake', 'living', 'mood', 'zone', 'vitals', 'dna', 'memories', 'dreams', 'hardware', 'interactionCount']);
  const VITAL_DEFAULTS = { energy: 84, curiosity: 91, social: 63, confidence: 72, mischief: 82, boredom: 26, trust: 68 };
  const DNA_DEFAULTS = { curiosity: 91, courage: 57, affection: 74, independence: 79, mischief: 88, patience: 31, obedience: 49, persistence: 84, weirdness: 93 };
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
  let motorPermit = null;
  let eraseArmedUntil = 0;

  function clampNumber(value, fallback, min = 0, max = 100) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function safeText(value, fallback = '', max = 500) {
    const text = typeof value === 'string' ? value : fallback;
    return text.slice(0, max);
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

      // Drop anything unknown before it can reach a renderer.
      for (const key of Object.keys(state)) {
        if (!TOP_LEVEL_KEYS.has(key)) delete state[key];
      }

      state.name = safeText(state.name, 'Ozi', 32) || 'Ozi';
      state.mood = safeText(state.mood, 'curious', 32) || 'curious';
      state.day = Math.max(1, Math.floor(clampNumber(state.day, 1, 1, 999999)));
      state.interactionCount = Math.floor(clampNumber(state.interactionCount, 0, 0, 1_000_000_000));
      state.awake = typeof state.awake === 'boolean' ? state.awake : true;
      state.living = typeof state.living === 'boolean' ? state.living : true;
      state.zone = ALLOWED_ZONES.has(state.zone) ? state.zone : 'nest';

      state.memories = (Array.isArray(state.memories) ? state.memories : [])
        .slice(-80)
        .filter(item => item && typeof item === 'object')
        .map(item => ({
          text: safeText(item.text, 'A fuzzy memory.', 600),
          at: safeText(item.at, 'unknown time', 80)
        }));

      state.dreams = (Array.isArray(state.dreams) ? state.dreams : [])
        .slice(-40)
        .filter(item => item && typeof item === 'object')
        .map(item => ({
          title: safeText(item.title, 'Untitled Dream', 100),
          text: safeText(item.text, 'The details faded before morning.', 1200),
          day: Math.max(0, Math.floor(clampNumber(item.day, 0, 0, 999999)))
        }));

      state.vitals = state.vitals && typeof state.vitals === 'object' && !Array.isArray(state.vitals) ? state.vitals : {};
      state.dna = state.dna && typeof state.dna === 'object' && !Array.isArray(state.dna) ? state.dna : {};

      for (const key of Object.keys(state.vitals)) {
        if (!(key in VITAL_DEFAULTS)) delete state.vitals[key];
      }
      for (const key of Object.keys(state.dna)) {
        if (!(key in DNA_DEFAULTS)) delete state.dna[key];
      }
      for (const key of Object.keys(VITAL_DEFAULTS)) {
        state.vitals[key] = clampNumber(state.vitals[key], VITAL_DEFAULTS[key]);
      }
      for (const key of Object.keys(DNA_DEFAULTS)) {
        state.dna[key] = clampNumber(state.dna[key], DNA_DEFAULTS[key]);
      }

      // Bridge keys are short-lived localhost secrets. Never restore one after a page load.
      state.hardware = state.hardware && typeof state.hardware === 'object' && !Array.isArray(state.hardware) ? state.hardware : {};
      state.hardware.connected = false;
      state.hardware.key = '';

      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The main app already has a safe default-state fallback.
    }
  }

  function expectedMotorAction(target) {
    const hw = target?.dataset?.hw;
    const action = target?.dataset?.action;
    if (hw === 'forward' || hw === 'back') return 'move';
    if (hw === 'left' || hw === 'right') return 'turn';
    if (action === 'explore') return 'move';
    if (action === 'dance') return 'dance';
    if (action === 'mischief') return 'turn';
    return null;
  }

  function armMotorIntent(event) {
    if (!event.isTrusted) return;
    const target = event.target?.closest?.(MOTOR_INTENTS);
    const action = expectedMotorAction(target);
    if (!action) return;
    motorPermit = { action, until: Date.now() + GESTURE_WINDOW_MS };
  }

  function consumeMotorPermit(action) {
    const permit = motorPermit;
    motorPermit = null;
    return !!permit && permit.action === action && Date.now() <= permit.until;
  }

  function installMotorSafetyGuard() {
    const nativeFetch = window.fetch.bind(window);

    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url;
      const isBridgeAction = typeof url === 'string' && /^http:\/\/127\.0\.0\.1:8787\/action(?:$|[?#])/.test(url);

      if (isBridgeAction && String(init.method || 'GET').toUpperCase() === 'POST') {
        try {
          const payload = typeof init.body === 'string' ? JSON.parse(init.body) : null;
          if (payload && MOTOR_ACTIONS.has(payload.action) && !consumeMotorPermit(payload.action)) {
            return new Response(JSON.stringify({
              ok: true,
              action: payload.action,
              blocked: true,
              reason: 'physical motion requires the matching explicit user control gesture'
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

  function installVisualFixes() {
    const style = document.createElement('style');
    style.id = 'ozopet-runtime-visual-fixes';
    style.textContent = `
      .dust i{position:absolute;width:3px;height:3px;border-radius:50%;background:rgba(21,21,21,.28);animation:dust-drift var(--d,10s) ease-in-out infinite alternate}
      @keyframes dust-drift{from{transform:translate3d(-3px,-5px,0);opacity:.18}50%{opacity:.55}to{transform:translate3d(7px,9px,0);opacity:.12}}
      @media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}}
    `;
    document.head.appendChild(style);
  }

  sanitizeStoredState();
  installVisualFixes();
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
