// Offline transport regressions. The VM has only a fake fetch; no real endpoint.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../playroom/robot.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.fail('mock operation did not start'); }

function setup({ ready = true, ignoreAbort = false } = {}) {
  const calls = [], server = { connected: ready, mode: 'desk', moving: false };
  let hook = async () => {};
  const status = () => ({ ok: true, connected: server.connected, mode: 'hardware', protocol_version: 4, play_mode: server.mode });
  const fetch = (url, options) => {
    assert.equal(new URL(url).origin, 'http://127.0.0.1:8787'); // string only, never opened
    const call = { path: new URL(url).pathname, body: options.body ? JSON.parse(options.body) : undefined, key: options.headers['X-OzoPet-Key'] };
    calls.push(call);
    const response = (async () => {
      const override = await hook(call);
      let data = override;
      if (!data) {
        if (call.path === '/connect') server.connected = true;
        if (call.path === '/disconnect') { server.connected = false; server.mode = 'desk'; server.moving = false; }
        if (call.path === '/play-mode') { server.mode = call.body.mode; if (server.mode === 'desk') server.moving = false; }
        if (call.path === '/stop') { server.mode = 'desk'; server.moving = false; }
        data = call.path === '/sequence' ? { ok: true, truncated: false } : status();
      }
      return { ok: data.ok !== false, status: data.ok === false ? 500 : 200, json: async () => data };
    })();
    if (ignoreAbort) return response;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (options.signal.aborted) return abort();
      options.signal.addEventListener('abort', abort, { once: true });
      response.then(resolve, reject).finally(() => options.signal.removeEventListener('abort', abort));
    });
  };
  class DetailEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } }
  const context = { window: {}, EventTarget, Event, CustomEvent: DetailEvent, AbortController, TypeError, setTimeout, clearTimeout, fetch };
  vm.runInNewContext(source, context);
  context.window.OziClub.abortError = () => new DOMException('Activity stopped', 'AbortError');
  const bridge = new context.window.OziClub.Bridge();
  if (ready) Object.assign(bridge, { connected: true, status: 'ready', protocol: 4, key: 'old-key' });
  return { bridge, calls, server, hook: fn => { hook = fn; } };
}

for (const end of ['stop', 'desk']) test(`late floor arm ends disarmed after ${end}`, async () => {
  const h = setup(), gate = deferred();
  h.hook(async c => { if (c.path === '/play-mode' && c.body.mode === 'floor') await gate.promise; });
  const arming = h.bridge.setFloor(true).catch(e => e);
  await until(() => h.calls.some(c => c.body?.mode === 'floor'));
  const stopping = end === 'stop' ? h.bridge.stop() : h.bridge.setFloor(false);
  await tick(); gate.resolve();
  await Promise.all([arming, stopping]);
  assert.equal(h.bridge.floor, false);
  assert.equal(h.server.mode, 'desk');
});

test('abort sends server STOP and disarms without replay', async () => {
  const h = setup(), gate = deferred(), abort = new AbortController();
  h.bridge.floor = true; h.server.mode = 'floor';
  h.hook(async c => { if (c.path === '/sequence') { h.server.moving = true; await gate.promise; } });
  const running = h.bridge.perform([{ move: { distance: 40, speed: 50 } }], abort.signal).catch(e => e);
  await until(() => h.server.moving); abort.abort();
  const error = await running;
  await tick(); gate.resolve(); if (h.bridge.stopPending) await h.bridge.stopPending;
  assert.equal(error.name, 'AbortError');
  assert.ok(h.calls.some(c => c.path === '/stop'));
  assert.equal(h.server.moving, false); assert.equal(h.bridge.floor, false);
  assert.equal(h.calls.filter(c => c.path === '/sequence').length, 1);
});

test('loss attempts STOP once; failed STOP cannot recursively emit loss', async () => {
  const h = setup(); let lost = 0;
  h.bridge.addEventListener('lost', () => lost++);
  h.hook(async c => { if (c.path === '/stop') throw new TypeError('offline'); });
  h.bridge.lost('Link lost');
  await tick(); if (h.bridge.stopPending) await h.bridge.stopPending.catch(() => {}); await tick();
  assert.equal(lost, 1);
  assert.equal(h.calls.filter(c => c.path === '/stop').length, 1);
  assert.equal(h.bridge.connected, false); assert.equal(h.bridge.floor, false);
});

test('normal truncation reports incomplete routine without false disconnect', async () => {
  const h = setup(); let lost = 0;
  h.bridge.addEventListener('lost', () => lost++);
  h.hook(async c => c.path === '/sequence' ? { ok: true, truncated: true } : undefined);
  const error = await h.bridge.perform([{ wait: 0 }]).catch(e => e);
  if (h.bridge.stopPending) await h.bridge.stopPending;
  assert.match(error.message, /stopped|finished|routine/i);
  assert.equal(h.bridge.connected, true); assert.equal(h.bridge.status, 'ready'); assert.equal(lost, 0);
});

test('transport failure stops best effort and never reconnects or replays motion', async () => {
  const h = setup(); h.bridge.floor = true;
  h.hook(async c => { if (c.path === '/sequence') throw new TypeError('response lost after delivery'); });
  await assert.rejects(h.bridge.perform([{ move: {} }]));
  await tick(); if (h.bridge.stopPending) await h.bridge.stopPending.catch(() => {});
  assert.ok(h.calls.some(c => c.path === '/stop'));
  assert.equal(h.calls.filter(c => c.path === '/sequence').length, 1);
  assert.equal(h.calls.filter(c => c.path === '/connect').length, 0);
});

test('disconnect waits out a late connect and leaves screen mode disconnected', async () => {
  const h = setup({ ready: false }), gate = deferred();
  h.hook(async c => { if (c.path === '/connect') await gate.promise; });
  const connecting = h.bridge.connect('old-key');
  await until(() => h.calls.some(c => c.path === '/connect'));
  const closing = h.bridge.disconnect(true);
  await tick(); gate.resolve(); await Promise.all([connecting, closing]);
  assert.equal(h.server.connected, false); assert.equal(h.bridge.status, 'screen');
  assert.equal(h.bridge.connected, false); assert.equal(h.bridge.key, '');
  assert.equal(h.calls.filter(c => c.path === '/action').length, 0);
});

test('old disconnect cannot clear credentials or disconnect a new session', async () => {
  const h = setup(), gate = deferred();
  h.hook(async c => { if (c.path === '/disconnect') await gate.promise; });
  const closing = h.bridge.disconnect(true);
  await until(() => h.calls.some(c => c.path === '/disconnect'));
  const connecting = h.bridge.connect('new-key');
  await tick(); gate.resolve(); await Promise.all([closing, connecting]);
  assert.equal(h.bridge.key, 'new-key'); assert.equal(h.bridge.connected, true);
  assert.equal(h.server.connected, true); assert.equal(h.bridge.status, 'ready');
  assert.equal(h.calls.find(c => c.path === '/disconnect').key, 'old-key');
});

test('stale perform finally does not release a newer busy operation', async () => {
  const h = setup({ ignoreAbort: true }), old = deferred(), fresh = deferred(); let number = 0;
  h.hook(async c => { if (c.path === '/sequence') await (++number === 1 ? old.promise : fresh.promise); });
  const first = h.bridge.perform([{ wait: 0 }]).catch(e => e);
  await until(() => number === 1); await h.bridge.stop();
  const second = h.bridge.perform([{ wait: 0 }]);
  await until(() => number === 2); old.resolve(); await first;
  assert.equal(h.bridge.busy, true);
  fresh.resolve(); await second; assert.equal(h.bridge.busy, false);
});
