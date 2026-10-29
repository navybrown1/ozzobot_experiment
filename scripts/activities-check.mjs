/**
 * Run: node scripts/activities-check.mjs
 * Regression checks for activities.js and the shared scene timing estimate,
 * using Node built-ins, a VM fake window, and injected mocks. No DOM, robot,
 * network, or external packages. Scene classes are loaded, never instantiated.
 * Any assertion, runtime failure, or stalled suite exits nonzero.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const sourceURL = new URL('../playroom/activities.js', import.meta.url);
const sceneURL = new URL('../playroom/scene.js', import.meta.url);
const context = { window: { OziClub: { parentMarker: true } }, AbortController };
for (const url of [sourceURL, sceneURL]) {
  vm.runInNewContext(fs.readFileSync(url, 'utf8'), context, {
    filename: fileURLToPath(url), timeout: 1000
  });
}
const club = context.window.OziClub;
const plain = value => JSON.parse(JSON.stringify(value));
let checks = 0;

function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

function eq(actual, expected, message) {
  assert.deepEqual(plain(actual), plain(expected), message);
  checks++;
}

function duration(steps) {
  return steps.reduce((sum, step) => sum + (step.wait || 0)
    + (step.move ? Math.abs(step.move.distance) / step.move.speed : 0)
    + (step.turn ? Math.abs(step.turn.angle) / step.turn.speed : 0), 0);
}

function schema(steps, maxMove = 120) {
  ok(steps.length <= 16, 'at most 16 steps');
  for (const step of steps) {
    ok(Object.keys(step).every(key => ['led', 'move', 'turn', 'wait'].includes(key)), 'only legacy keys, no tone');
    if (step.led) ok(/^#[a-f\d]{6}$/i.test(step.led), 'hex LED');
    if (step.move) {
      ok(Math.abs(step.move.distance) <= maxMove && step.move.speed > 0 && step.move.speed <= 80, 'move caps');
    }
    if (step.turn) {
      ok(Math.abs(step.turn.angle) <= 180 && step.turn.speed > 0 && step.turn.speed <= 120, 'turn caps');
    }
    if (step.wait !== undefined) ok(step.wait >= 0 && step.wait <= 1.5, 'wait range');
  }
}

function setup(overrides = {}) {
  let time = 0;
  const events = [], completions = [], calls = [], signals = [];
  let engine;
  const deps = {
    now: () => time,
    sleep: async (ms, signal) => {
      signals.push(signal);
      time += ms;
    },
    perform: async (steps, signal) => {
      schema(steps);
      calls.push(plain(steps));
      signals.push(signal);
      time += duration(steps) * 1000;
    },
    update: snapshot => {
      ok(['freeze', 'copycat', 'color', 'trail', null].includes(snapshot.kind), 'snapshot kind');
      ok([null, 'freeze', 'colors', 'readColor', 'drive'].includes(snapshot.input), 'snapshot input kind');
      ok(Array.isArray(snapshot.choices)
        && ['phase', 'title', 'instruction', 'round', 'total', 'score', 'flash', 'board', 'result']
          .every(key => key in snapshot), 'complete snapshot');
      if (snapshot.board) {
        ok(snapshot.board.cols === 5 && snapshot.board.rows === 5
          && snapshot.board.heading >= 0 && snapshot.board.heading <= 3, 'board shape');
      }
      events.push(plain(snapshot));
    },
    onComplete: result => {
      ok(!engine.busy(), 'not busy during completion callback');
      completions.push(plain(result));
    },
    isHardware: () => false,
    ...overrides
  };
  engine = club.createActivities(deps);
  return { engine, events, completions, calls, signals, addTime: ms => { time += ms; } };
}

async function until(predicate, message) {
  for (let index = 0; index < 600; index++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out: ' + message);
}

async function flush() {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function ready(harness, phase, round) {
  await until(() => harness.engine.snapshot().phase === phase
    && (round === undefined || harness.engine.snapshot().round === round), phase + '/' + round);
}

async function runSuite() {
  ok(club.parentMarker, 'preserves namespace members');
  eq(Object.keys(club.TRICKS), ['wiggle', 'sneak', 'spin', 'celebrate', 'surprise', 'party']);
  eq(Object.keys(club.MOVES), ['forward', 'back', 'left', 'right', 'spin', 'wiggle', 'glow', 'pause']);
  ok(typeof club.stepTime === 'function', 'use the actual shared timing estimate');
  const budgets = {};
  for (const [id, trick] of Object.entries(club.TRICKS)) {
    schema(trick.steps);
    const raw = duration(trick.steps);
    const estimated = trick.steps.reduce((sum, step) => sum + club.stepTime(step), 0);
    ok(raw <= 4.6, id + ': raw motion/waits within 4.6 seconds');
    ok(estimated <= 7, id + ': shared estimate within seven seconds including overhead');
    ok(typeof trick.title === 'string' && typeof trick.quip === 'string', 'trick metadata');
    budgets[id] = { raw: Math.round(raw * 100) / 100, estimated: Math.round(estimated * 100) / 100 };
  }
  for (const move of Object.values(club.MOVES)) {
    schema(move.steps);
    ok(typeof move.icon === 'string', 'move icon');
  }
  eq(club.MOVES.spin.steps.reduce((sum, step) => sum + step.turn.angle, 0), 360, 'full spin');

  // Freeze: early taps, duplicate starts/inputs, real elapsed scoring, 3 rounds.
  const h = setup();
  ok(!h.engine.busy() && h.calls.length === 0, 'no automatic action');
  eq(await h.engine.start('unknown'), false);
  const freeze = h.engine.start('freeze');
  ok(h.engine.busy(), 'start reserves immediately');
  eq(await h.engine.start('trail'), false, 'duplicate benign');
  eq(h.engine.input('freeze'), false, 'early freeze ignored');
  ok(/Too soon/.test(h.engine.snapshot().instruction)
    && h.engine.snapshot().score === 0, 'early warning without win');
  for (let round = 1; round <= 3; round++) {
    await ready(h, 'freeze', round);
    h.addTime(250);
    eq(h.engine.input('freeze'), true);
    eq(h.engine.input('freeze'), false, 'duplicate tap ignored');
  }
  eq(await freeze, true);
  eq(h.engine.snapshot().result.score, 270);
  eq(h.completions, [{ kind: 'freeze', won: true, score: 270,
    message: 'Three freeze taps! You scored 270 out of 300.' }]);
  ok(new Set(h.signals).size === 1, 'one abort signal per run');
  eq(h.calls.filter(steps => steps.some(step => step.move || step.turn)).map(duration),
    [2, 2, 2], 'two-second dances');

  // Copycat: input locking during watch, wrong-answer loss, complete replay.
  const c = setup();
  const failedCopy = c.engine.start('copycat');
  eq(c.engine.input('red'), false, 'watch ignores input');
  await ready(c, 'input', 1);
  const expected = c.engine.snapshot().pattern[0];
  c.engine.input(expected === 'red' ? 'blue' : 'red');
  eq(await failedCopy, true);
  ok(!c.engine.snapshot().result.won, 'copycat wrong is a loss');
  eq(c.completions.length, 1);
  const replay = c.engine.start('copycat');
  for (let round = 1; round <= 5; round++) {
    for (let index = 0; index < round; index++) {
      await until(() => c.engine.snapshot().phase === 'input'
        && c.engine.snapshot().round === round
        && c.engine.snapshot().inputIndex === index, 'copycat input');
      const snapshot = c.engine.snapshot();
      eq(snapshot.pattern.length, round);
      c.engine.input(snapshot.pattern[index]);
    }
  }
  eq(await replay, true);
  eq(c.engine.snapshot().result.score, 150);
  ok(c.engine.snapshot().result.won, 'copycat five-round win');

  // Screen color quest: wrong answers explain/retry without extra commands.
  const s = setup();
  const screen = s.engine.start('color');
  const colors = ['red', 'blue', 'green', 'yellow'];
  for (let index = 0; index < 4; index++) {
    await ready(s, 'choose', index + 1);
    eq(s.engine.input('read'), false, 'screen play cannot read hardware');
    const oldCalls = s.calls.length;
    s.engine.input(colors[(index + 1) % 4]);
    await ready(s, 'retry', index + 1);
    eq(s.calls.length, oldCalls, 'wrong color causes no execution');
    ok(s.engine.snapshot().instruction.includes(colors[(index + 1) % 4]), 'wrong observed color explained');
    eq(s.engine.snapshot().score, index * 25);
    s.engine.input(colors[index]);
  }
  eq(await screen, true);
  eq(s.engine.snapshot().score, 100);

  // Hardware color quest: only actual strings/surface readings may match.
  let readings = 0;
  const actual = ['BLUE', 'UNKNOWN', 0, { surface: ' RED ' }, 'blue', { surface: 'GREEN' }, 'YELLOW'];
  const hardware = setup({ isHardware: () => true, readColor: async () => actual[readings++] });
  const quest = hardware.engine.start('color');
  await ready(hardware, 'choose', 1);
  eq(hardware.engine.snapshot().input, 'readColor');
  eq(hardware.engine.input('red'), false);
  for (let index = 0; index < 3; index++) {
    eq(hardware.engine.input('read'), true);
    eq(hardware.engine.input('read'), false);
    await ready(hardware, 'retry', 1);
    eq(hardware.engine.snapshot().score, 0);
    ok(hardware.engine.snapshot().instruction.includes(['BLUE', 'UNKNOWN', '0'][index]), 'actual sensor value reported');
  }
  hardware.engine.input('read');
  for (let round = 2; round <= 4; round++) {
    await ready(hardware, 'choose', round);
    hardware.engine.input('read');
  }
  eq(await quest, true);
  eq(readings, 7);
  eq(hardware.engine.snapshot().score, 100);
  ok(hardware.engine.snapshot().result.won, 'only actual readings win');

  // Trail: no autoplay, correct heading signs, preflight blocking, real goal.
  const t = setup();
  const trail = t.engine.start('trail');
  await ready(t, 'playing');
  eq(t.calls.length, 0, 'trail has no autoplay');
  async function command(value) {
    eq(t.engine.input(value), true, value);
    await flush();
    ok(['playing', 'complete'].includes(t.engine.snapshot().phase), 'command settled');
  }
  await command('left');
  eq(t.engine.snapshot().board.heading, 3);
  eq(t.calls.at(-1)[0].turn.angle, 90);
  let before = t.calls.length;
  await command('forward');
  eq(t.calls.length, before, 'boundary rejected before move');
  await command('right');
  await command('right');
  before = t.calls.length;
  await command('forward');
  eq(t.calls.length, before, 'rock rejected before move');
  await command('left');
  const detached = t.engine.snapshot();
  detached.board.goal.x = 0;
  detached.board.rocks.length = 0;
  eq(t.engine.snapshot().board.goal.x, 4, 'snapshot detached');
  eq(t.engine.snapshot().board.rocks.length, 5);
  for (const move of ['forward', 'right', 'forward', 'forward', 'left', 'forward',
    'forward', 'right', 'forward', 'forward', 'left', 'forward']) {
    await command(move);
  }
  eq(await trail, true);
  eq(t.engine.snapshot().board.x, 4);
  eq(t.engine.snapshot().board.y, 0);
  ok(t.engine.snapshot().result.won && /plan/.test(t.engine.snapshot().instruction), 'goal and plan caveat');
  for (const steps of t.calls) schema(steps, 70);

  // Execution failures must surface safe actual errors and never record wins.
  for (const kind of ['freeze', 'copycat', 'color', 'trail']) {
    const broken = setup({ perform: async () => {
      throw new Error('BLE disconnected <unsafe>\nTry reconnecting');
    } });
    const task = broken.engine.start(kind);
    if (kind === 'trail') {
      await ready(broken, 'playing');
      broken.engine.input('forward');
    }
    eq(await task, false);
    eq(broken.engine.snapshot().phase, 'error');
    ok(!broken.engine.snapshot().result.won && broken.completions.length === 0, 'hardware failure is never completion');
    ok(/BLE disconnected/.test(broken.engine.snapshot().instruction)
      && !/[<>\n]/.test(broken.engine.snapshot().instruction), 'safe actual error');
    if (kind === 'trail') eq(broken.engine.snapshot().board.y, 4, 'failed command leaves board unchanged');
  }
  for (const response of [{ ok: false, error: 'Denied by robot' }, { ok: true, truncated: true }]) {
    const broken = setup({ perform: async () => response });
    eq(await broken.engine.start('freeze'), false);
    eq(broken.engine.snapshot().phase, 'error');
    eq(broken.completions.length, 0);
  }
  const readFail = setup({ isHardware: () => true, readColor: async () => {
    throw new Error('Sensor unavailable');
  } });
  const readTask = readFail.engine.start('color');
  await ready(readFail, 'choose');
  readFail.engine.input('read');
  eq(await readTask, false);
  ok(/Sensor unavailable/.test(readFail.engine.snapshot().instruction));
  eq(readFail.completions.length, 0);

  // Stop releases each await even when the mock ignores abort. Late success
  // and rejection must not update, complete, or clear a newer generation.
  for (const dependency of ['perform', 'sleep', 'readColor']) {
    const late = deferred();
    let pendingSignal;
    const overrides = { [dependency]: (...args) => {
      pendingSignal = args.at(-1);
      return late.promise;
    } };
    if (dependency === 'readColor') overrides.isHardware = () => true;
    const stopped = setup(overrides);
    const kind = dependency === 'perform' ? 'freeze' : dependency === 'sleep' ? 'copycat' : 'color';
    const oldTask = stopped.engine.start(kind);
    if (dependency === 'readColor') {
      await ready(stopped, 'choose');
      stopped.engine.input('read');
    }
    await until(() => pendingSignal, 'pending operation');
    eq(stopped.engine.stop(), true);
    ok(pendingSignal.aborted, 'signal aborted');
    eq(await oldTask, false);
    eq(stopped.completions.length, 0);
    eq(stopped.engine.input('freeze'), false);
    const nextTask = stopped.engine.start('trail');
    await ready(stopped, 'playing');
    const count = stopped.events.length;
    if (dependency === 'sleep') late.reject(new Error('Late timer failure'));
    else late.resolve('RED');
    await flush();
    eq(stopped.events.length, count, 'old operation cannot emit into new game');
    eq(stopped.engine.snapshot().kind, 'trail');
    ok(stopped.engine.busy(), 'old finally cannot clear new run');
    stopped.engine.stop();
    eq(await nextTask, false);
  }
  const pending = setup();
  const pendingTask = pending.engine.start('trail');
  await ready(pending, 'playing');
  pending.engine.stop();
  eq(await pendingTask, false);
  eq(pending.engine.snapshot().phase, 'stopped');
  eq(pending.completions.length, 0);

  console.log(JSON.stringify({
    passed: true, checks, trickSeconds: budgets,
    coverage: [
      'all game wins', 'copycat loss and replay', 'freeze early taps and timing',
      'sensor mismatch and failure', 'trail rocks, boundary, headings and goal',
      'stop during perform, sleep, sensor and input', 'late settlements and duplicate input',
      'snapshot isolation', 'hardware failure propagation'
    ]
  }, null, 2));
}

let watchdog;
try {
  await Promise.race([
    runSuite(),
    new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('Regression suite stalled for 5 seconds.')), 5000);
    })
  ]);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
}
