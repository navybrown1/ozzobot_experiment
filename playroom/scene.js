/* Shared game clock, original robot artwork, and small synthesized sounds. */
(() => {
  'use strict';
  const N = window.OziClub = window.OziClub || {};
  const abortError = () => new DOMException('Activity stopped', 'AbortError');
  class Clock {
    constructor() { this.time = 0; this.jobs = new Set(); }
    now() { return this.time; }
    tick(ms) {
      this.time += Math.max(0, ms);
      for (const job of [...this.jobs]) if (job.at <= this.time) job.done();
    }
    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const cleanup = () => { this.jobs.delete(job); signal?.removeEventListener('abort', cancel); };
        const cancel = () => { cleanup(); reject(abortError()); };
        const job = { at: this.time + Math.max(0, ms), done: () => { cleanup(); resolve(); } };
        this.jobs.add(job); signal?.addEventListener('abort', cancel, { once: true });
      });
    }
  }
  function stepTime(s) {
    return (s.wait || 0) + (s.move ? Math.abs(s.move.distance) / Math.max(20, s.move.speed) : 0)
      + (s.turn ? Math.abs(s.turn.angle) / Math.max(30, s.turn.speed) : 0) + (s.tone?.duration || 0)
      + .15 + (s.led ? .2 : 0) + (s.move ? .25 : 0) + (s.turn ? .25 : 0);
  }
  N.stepTime = stepTime;
  N.Clock = Clock;
  N.abortError = abortError;

  class Sound {
    constructor() { this.enabled = false; this.context = null; this.nodes = new Set(); }
    async unlock() {
      if (!this.enabled) return;
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      try { this.context ||= new Audio(); await this.context.resume(); } catch { /* Optional sound. */ }
    }
    note(hz = 659, seconds = .12, delay = 0) {
      if (!this.enabled || !this.context || this.context.state !== 'running') return;
      const ctx = this.context, t = ctx.currentTime + delay;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(hz, t); osc.frequency.exponentialRampToValueAtTime(hz * .85, t + seconds);
      gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(.065, t + .012); gain.gain.exponentialRampToValueAtTime(.0001, t + seconds);
      osc.connect(gain).connect(ctx.destination); this.nodes.add(osc);
      osc.onended = () => { this.nodes.delete(osc); osc.disconnect(); gain.disconnect(); };
      osc.start(t); osc.stop(t + seconds + .03);
    }
    win() { [523, 659, 784, 1047].forEach((f, i) => this.note(f, .16, i * .13)); }
    stop() { for (const n of this.nodes) { try { n.stop(); } catch {} } this.nodes.clear(); }
  }
  N.Sound = Sound;

  class Scene {
    constructor(canvas, clock) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.clock = clock;
      this.pose = { x: 0, y: 0, angle: 0 }; this.tween = null; this.color = '#7ce0bd';
      this.mood = 'happy'; this.board = null; this.confettiAt = -10000;
      this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    reset() { this.tween = null; this.pose = { x: 0, y: 0, angle: 0 }; this.board = null; this.mood = 'happy'; this.color = '#7ce0bd'; }
    celebrate() { this.confettiAt = this.clock.now(); this.mood = 'happy'; }
    setGame(data) {
      this.board = data?.board || null;
      this.mood = data?.phase === 'freeze' ? 'surprised' : data?.phase === 'error' ? 'curious' : 'happy';
      if (data?.flash) this.color = data.flash;
    }
    async play(steps, signal, sound) {
      for (const step of steps) {
        if (signal?.aborted) throw abortError();
        if (step.led) { this.color = step.led === 'off' ? '#a5b9af' : step.led; sound?.note(440 + ((parseInt(step.led.slice(1, 3), 16) || 120) * 3)); }
        const from = this.currentPose();
        const target = { ...from };
        if (step.move) { target.x = Math.max(-130, Math.min(130, from.x + step.move.distance * .7)); target.y = from.y - Math.abs(step.move.distance) * .12; }
        if (step.turn) target.angle += step.turn.angle * Math.PI / 180;
        const ms = Math.max(160, stepTime(step) * 1000);
        this.tween = { from, target, at: this.clock.now(), ms };
        await this.clock.sleep(ms, signal);
        if (signal?.aborted) throw abortError();
        this.pose = target; this.tween = null;
      }
      const from = this.currentPose();
      this.tween = { from, target: { x: 0, y: 0, angle: Math.round(from.angle / (Math.PI * 2)) * Math.PI * 2 }, at: this.clock.now(), ms: 350 };
    }
    currentPose() {
      if (!this.tween) return this.pose;
      const t = Math.min(1, Math.max(0, (this.clock.now() - this.tween.at) / this.tween.ms));
      const ease = t * t * (3 - 2 * t), p = {};
      for (const key of ['x', 'y', 'angle']) p[key] = this.tween.from[key] + (this.tween.target[key] - this.tween.from[key]) * ease;
      if (t === 1) { this.pose = p; this.tween = null; }
      return p;
    }
    rounded(x, y, w, h, r, fill, stroke, width = 2) {
      const c = this.ctx; c.beginPath(); c.roundRect(x, y, w, h, r);
      if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
    }
    ellipse(x, y, rx, ry, fill) { const c = this.ctx; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); }
    star(x, y, size, color) {
      const c = this.ctx; c.save(); c.translate(x, y); c.beginPath();
      for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, r = i % 2 ? size * .44 : size; c.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      c.closePath(); c.fillStyle = color; c.fill(); c.restore();
    }
    robot(x, y, scale = 1, angle = 0) {
      const c = this.ctx, t = this.clock.now(); c.save(); c.translate(x, y); c.scale(scale, scale);
      const bob = this.reduced || this.mood === 'surprised' ? 0 : Math.sin(t / 420) * 4;
      this.ellipse(0, 125, 120, 22, '#55526a20');
      c.translate(0, bob); c.rotate(angle);
      const wheel = c.createLinearGradient(-150, 0, 150, 0); wheel.addColorStop(0, '#282f37'); wheel.addColorStop(.5, '#616872'); wheel.addColorStop(1, '#303740');
      for (const side of [-1, 1]) {
        this.rounded(side * 120 - 23, 24, 46, 98, 18, wheel, '#252c32', 3);
        for (let i = 0; i < 6; i++) this.rounded(side * 120 - 18, 36 + i * 13, 36, 5, 2, '#858b9050');
      }
      const shell = c.createLinearGradient(-80, -90, 80, 130); shell.addColorStop(0, '#ffffff'); shell.addColorStop(.48, '#f0fbf6'); shell.addColorStop(1, '#bbd3c8');
      c.beginPath(); c.moveTo(-114, 70); c.bezierCurveTo(-117, -25, -85, -109, 0, -111); c.bezierCurveTo(85, -109, 117, -25, 114, 70); c.bezierCurveTo(107, 133, -107, 133, -114, 70);
      c.fillStyle = shell; c.fill(); c.strokeStyle = '#5c7974'; c.lineWidth = 3; c.stroke();
      c.save(); c.globalAlpha = .4; this.ellipse(0, 80, 96, 28, this.color); c.restore();
      c.strokeStyle = '#93b0a4'; c.lineWidth = 2; c.beginPath(); c.ellipse(0, 79, 104, 37, 0, 0, Math.PI); c.stroke();
      this.rounded(-89, -51, 178, 108, 40, '#253d44', '#426069', 3);
      const blink = !this.reduced && t % 4700 > 4500;
      for (const side of [-1, 1]) {
        const eyeX = side * 40, eyeH = blink ? 5 : this.mood === 'surprised' ? 47 : 38;
        this.rounded(eyeX - 15, -eyeH / 2, 30, eyeH, 15, '#d9fff5');
        if (!blink) this.ellipse(eyeX + 4, -9, 5, 7, '#fff');
      }
      c.strokeStyle = '#a3eecb'; c.lineWidth = 3; c.lineCap = 'round'; c.beginPath();
      if (this.mood === 'surprised') c.arc(0, 30, 6, 0, Math.PI * 2);
      else { c.moveTo(-10, 28); c.quadraticCurveTo(0, 38, 10, 28); } c.stroke();
      for (let i = 0; i < 5; i++) { this.ellipse(-42 + i * 21, -74, 6, 5, this.color); }
      c.strokeStyle = '#44595d'; c.lineWidth = 5; c.beginPath(); c.moveTo(0, -112); c.lineTo(0, -145); c.stroke();
      this.ellipse(0, -150, 11, 11, this.color); this.ellipse(-3, -153, 3, 3, '#fff');
      this.ellipse(-75, 74, 4, 4, '#77958b'); this.ellipse(75, 74, 4, 4, '#77958b');
      c.font = '800 21px "Avenir Next", sans-serif'; c.textAlign = 'center'; c.fillStyle = '#42665e'; c.fillText('ozi', 0, 91);
      c.strokeStyle = '#ffffffaa'; c.lineWidth = 5; c.beginPath(); c.moveTo(-100, -5); c.quadraticCurveTo(-97, -62, -65, -82); c.stroke();
      c.restore();
    }
    render() {
      const c = this.ctx, w = this.canvas.width, h = this.canvas.height;
      c.clearRect(0, 0, w, h); c.fillStyle = '#eae9f1'; c.fillRect(0, 0, w, h);
      const g = c.createRadialGradient(450, 330, 50, 450, 330, 520); g.addColorStop(0, '#f7f6faff'); g.addColorStop(1, '#dfdcecff'); c.fillStyle = g; c.fillRect(0, 0, w, h);
      if (this.board) this.renderBoard();
      else {
        c.strokeStyle = '#cecbdc'; c.lineWidth = 1;
        for (let i = 0; i < 3; i++) { c.beginPath(); c.ellipse(440, 510, 210 + i * 66, 39 + i * 15, -.07, 0, Math.PI * 2); c.stroke(); }
        this.ellipse(440, 509, 195, 39, '#bbb6cf25');
        this.star(175, 270, 15, '#aa98d6'); this.star(700, 218, 12, '#c9be98');
        this.star(705, 420, 8, '#a4c5ba');
        c.strokeStyle = '#b6adc9'; c.lineWidth = 3; c.beginPath(); c.arc(170, 410, 18, .1, 1.9); c.stroke();
        const p = this.currentPose(); this.robot(435 + p.x, 376 + p.y, 1.24, p.angle);
      }
      const since = this.clock.now() - this.confettiAt;
      if (!this.reduced && since >= 0 && since < 2200) {
        const colors = ['#ff7458', '#9879d8', '#6cb596', '#d4b54f'];
        for (let i = 0; i < 36; i++) { c.save(); c.translate((i * 131 + 80) % 850, (since * (.15 + (i % 4) * .045) + i * 29) % 650); c.rotate(i + since / 500); c.fillStyle = colors[i % 4]; c.fillRect(-4, -7, 8, 14); c.restore(); }
      }
    }
    renderBoard() {
      const b = this.board, c = this.ctx, size = 77, left = 258, top = 188;
      for (let y = 0; y < b.rows; y++) for (let x = 0; x < b.cols; x++) this.rounded(left + x * size, top + y * size, size - 6, size - 6, 14, '#fcfbff', '#d7d3e3', 1.5);
      for (const rock of b.rocks || []) { this.rounded(left + rock.x * size + 14, top + rock.y * size + 18, 43, 35, [15, 19, 9, 9], '#b7b0c7'); this.ellipse(left + rock.x * size + 29, top + rock.y * size + 25, 6, 4, '#cbc5d6'); }
      this.star(left + b.goal.x * size + 35, top + b.goal.y * size + 35, 24, '#ff7856');
      const px = left + b.x * size + 35, py = top + b.y * size + 35;
      c.save(); c.translate(px, py); c.rotate(b.heading * Math.PI / 2); c.fillStyle = '#77639e'; c.beginPath(); c.moveTo(-5, -32); c.lineTo(0, -40); c.lineTo(5, -32); c.fill(); c.restore();
      this.robot(px, py - 3, .21, b.heading * Math.PI / 2);
    }
  }
  N.Scene = Scene;
})();
