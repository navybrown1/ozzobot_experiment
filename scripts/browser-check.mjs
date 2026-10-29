import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const url = process.env.TEST_URL || 'http://127.0.0.1:3001';
fs.mkdirSync('output/playwright', { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1120 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
const state = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
const advance = ms => page.evaluate(ms => window.advanceTime(ms), ms);
async function until(check, label, limit = 180) {
  for (let i = 0; i < limit; i++) { const s = await state(); if (check(s)) return s; await advance(100); }
  throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(await state()));
}
async function game(kind) { if (await page.locator('#exitActivity').isVisible()) await page.locator('#exitActivity').click(); await page.locator(`.game-card[data-game="${kind}"]`).click(); }
try {
  await page.goto(url); await page.waitForFunction(() => !!window.render_game_to_text);
  assert.equal((await state()).robot.status, 'screen');
  await page.screenshot({ path: 'output/playwright/home-desktop.png', fullPage: true });
  await game('freeze'); await page.locator('.freeze-button').click();
  assert.match((await state()).game.instruction, /Too soon/);
  await page.locator('#stopButton').click(); await advance(20000);
  assert.equal((await state()).game.phase, 'stopped'); assert.equal((await state()).busy, false);
  await page.getByRole('button', { name: 'Play again' }).click();
  for (let i = 0; i < 3; i++) { await until(s => s.game.phase === 'freeze', 'freeze cue'); await page.locator('.freeze-button').click(); await advance(800); }
  await until(s => s.game.phase === 'complete', 'freeze complete'); assert((await state()).game.result.won);
  await game('copycat'); let s = await until(s => s.game.input === 'colors', 'copycat input');
  await page.locator(`[data-input="${['red','blue','green','yellow'].find(x => x !== s.game.pattern[0])}"]`).click();
  await until(s => s.game.phase === 'complete', 'copycat loss'); assert.equal((await state()).game.result.won, false);
  await page.getByRole('button', { name: 'Play again' }).click();
  for (let round = 1; round <= 5; round++) for (let i = 0; i < round; i++) {
    s = await until(s => s.game.input === 'colors' && s.game.round === round && s.game.inputIndex === i, 'copycat round ' + round);
    await page.locator(`[data-input="${s.game.pattern[i]}"]`).click(); await advance(600);
  }
  await until(s => s.game.phase === 'complete', 'copycat win'); assert((await state()).game.result.won);
  await game('color'); await until(s => s.game.input === 'colors', 'color prompt');
  await page.locator('[data-input="blue"]').click(); await advance(20); assert.equal((await state()).game.phase, 'retry');
  for (const color of ['red', 'blue', 'green', 'yellow']) { await until(s => s.game.input === 'colors', 'color ' + color); await page.locator(`[data-input="${color}"]`).click(); await advance(1200); }
  await until(s => s.game.phase === 'complete', 'color complete'); assert((await state()).game.result.won);
  await game('trail'); await until(s => s.game.input === 'drive', 'trail');
  const drive = async direction => { await until(s => s.game.input === 'drive', 'drive ready'); await page.locator(`[data-input="${direction}"]`).click(); await advance(1200); };
  await drive('right'); await drive('forward'); assert.equal((await state()).game.board.x, 0); assert.match((await state()).game.instruction, /Rock ahead/);
  await drive('left');
  for (const direction of ['forward','right','forward','forward','forward','forward','left','forward','forward','forward']) await drive(direction);
  await until(s => s.game.phase === 'complete', 'trail complete'); assert((await state()).game.result.won);
  await page.screenshot({ path: 'output/playwright/game-complete.png', fullPage: true });
  await page.locator('[data-view="create"]').click();
  for (let i = 0; i < 5; i++) await page.locator('[data-move="forward"]').click();
  assert.equal((await state()).recipe.length, 3); assert((await state()).recipeSeconds <= 7);
  await page.locator('#clearRecipe').click();
  for (const id of ['left', 'right', 'glow', 'forward']) await page.locator(`[data-move="${id}"]`).click();
  await page.screenshot({ path: 'output/playwright/create-desktop.png', fullPage: true });
  await page.locator('#runRecipe').click(); await advance(7000); assert.equal((await state()).busy, false); assert((await state()).badges.includes('maker'));
  await page.reload(); await page.waitForFunction(() => !!window.render_game_to_text); assert.equal((await state()).busy, false); assert.equal((await state()).recipe.length, 4); assert.equal((await state()).badges.length, 5);
  // Fake bridge: every network request is intercepted. Never touches real Evo.
  const requests = []; let connected = false, floor = false, failSequence = false;
  await page.route('http://127.0.0.1:8787/**', async route => {
    const req = route.request(), p = new URL(req.url()).pathname, body = req.postDataJSON(); requests.push({ p, body });
    if (req.headers()['x-ozopet-key'] !== 'test-key') return route.fulfill({ status: 401, json: { ok: false, error: 'bad key' } });
    if (p === '/connect') connected = true;
    if (p === '/disconnect') connected = false;
    if (p === '/stop') floor = false;
    if (p === '/play-mode') floor = body.mode === 'floor';
    if (p === '/sequence' && failSequence) { connected = false; return route.fulfill({ status: 500, json: { ok: false, error: 'Not connected' } }); }
    return route.fulfill({ json: { ok: true, connected, mode: 'hardware', protocol_version: 4, play_mode: floor ? 'floor' : 'desk', truncated: false, surface: 'UNKNOWN' } });
  });
  await page.locator('#connectButton').click(); await page.locator('#bridgeKey').fill('test-key'); await page.locator('#pairButton').click();
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).robot.connected);
  assert.equal((await state()).robot.floor, false);
  await page.locator('[data-close="connectionDialog"]').click();
  await page.locator('[data-trick="spin"]').click(); await page.waitForFunction(() => !JSON.parse(window.render_game_to_text()).busy, undefined, { timeout: 15000 });
  const deskSequence = requests.find(r => r.p === '/sequence'); assert(deskSequence); assert(deskSequence.body.steps.every(step => !step.move && !step.turn));
  await page.locator('#floorButton').click(); await page.locator('#floorConsent').check(); await page.locator('#armFloor').click(); await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).robot.floor); assert.equal((await state()).robot.floor, true);
  failSequence = true; await page.locator('[data-trick="wiggle"]').click(); await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).robot.status === 'offline');
  assert.equal((await state()).robot.floor, false); assert.equal((await state()).busy, false);
  const motorRequests = requests.filter(r => r.p === '/sequence' && r.body.steps.some(s => s.move || s.turn)); assert.equal(motorRequests.length, 1, 'failed motor request must not replay');
  await page.locator('#connectButton').click(); await page.locator('#screenPlay').click(); await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).robot.status === 'screen');
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.waitForFunction(() => !!window.render_game_to_text);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'output/playwright/home-mobile.png', fullPage: true });
  await game('copycat'); await until(s => s.game.input === 'colors', 'mobile colors');
  assert.equal(await page.locator('.color-pad:visible').count(), 4);
  await page.screenshot({ path: 'output/playwright/game-mobile.png', fullPage: true });
  await page.keyboard.press('Escape'); assert.equal((await state()).busy, false);
  assert.deepEqual(errors.filter(e => !e.includes('500 (Internal Server Error)')), [], 'No unexpected browser errors');
  console.log('Browser checks passed: 4 games, wrong inputs, replay, STOP, builder limits, save/reload, floor arming, no motor replay, mobile layout.');
} finally { await browser.close(); }
