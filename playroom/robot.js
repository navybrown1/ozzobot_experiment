/* One explicit connection, one routine, no implicit reconnect or motor replay. */
(() => {
  'use strict';
  const N = window.OziClub = window.OziClub || {};
  const ENDPOINT = 'http://127.0.0.1:8787';
  class Bridge extends EventTarget {
    constructor() { super(); this.key = ''; this.connected = false; this.status = 'screen'; this.floor = false; this.protocol = 0; this.busy = false; this.epoch = 0; this.polling = false; this.simulator = false; this.message = ''; this.stopPending = null; this.controls = Promise.resolve(); this.controlCount = 0; this.operation = null; this.stopJob = null; }
    state() { return { connected: this.connected, status: this.status, floor: this.floor, protocol: this.protocol, busy: this.busy, simulator: this.simulator, message: this.message }; }
    emit() { this.dispatchEvent(new CustomEvent('state', { detail: this.state() })); }
    // Serialize connection/mode changes. Emergency STOP also goes immediately;
    // a second STOP after this queue drains neutralizes any late arm request.
    enqueue(fn) {
      this.controlCount++;
      const result = this.controls.then(fn).finally(() => { this.controlCount--; });
      this.controls = result.catch(() => {});
      return result;
    }
    invalidate() {
      ++this.epoch; this.floor = false;
      const old = this.operation; this.operation = null; this.busy = false;
      old?.controller.abort();
      return this.epoch;
    }
    offline(message, epoch = this.epoch) {
      if (epoch !== this.epoch) return;
      const wasConnected = this.connected;
      this.connected = false; this.floor = false; this.status = 'offline'; this.message = message; this.emit();
      if (wasConnected) this.dispatchEvent(new Event('lost'));
    }
    async request(path, body, { timeout = 8000, signal, key = this.key } = {}) {
      if (signal?.aborted) throw N.abortError();
      const control = new AbortController();
      const cancel = () => control.abort(); signal?.addEventListener('abort', cancel, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; control.abort(); }, timeout);
      try {
        const response = await fetch(ENDPOINT + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-OzoPet-Key': key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: control.signal });
        const data = await response.json();
        if (!response.ok || !data.ok) { const err = new Error(response.status === 401 ? 'That bridge key did not match. Paste the current key from your bridge.' : data.error || 'The robot could not finish that request.'); err.status = response.status; throw err; }
        return data;
      } catch (error) {
        if (signal?.aborted) throw N.abortError();
        if (timedOut) throw new Error('The robot took too long to answer.');
        if (error instanceof TypeError) throw new Error('The local bridge is unreachable. Check that it is running and allow local network access in your browser.');
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    }
    async connect(key) {
      if (this.status === 'connecting') return;
      key = String(key).trim();
      if (!key) throw new Error('Paste your bridge key first.');
      if (this.key && (this.connected || this.controlCount)) this.stop().catch(() => {});
      const epoch = this.invalidate(); this.key = key;
      this.connected = false; this.floor = false; this.status = 'connecting'; this.message = 'Finding your Evo. Bluetooth can take up to two minutes.'; this.emit();
      try {
        await this.enqueue(async () => {
          if (epoch !== this.epoch) return;
          const status = await this.request('/connect', {}, { timeout: 115000, key });
          if (epoch !== this.epoch) return;
          if (!status.connected) throw new Error('The bridge is running, but the Evo has not connected.');
          const protocol = Number(status.protocol_version) || 0;
          if (protocol >= 4) {
            const desk = await this.request('/play-mode', { mode: 'desk' }, { key });
            if (epoch !== this.epoch) return;
            if (!desk.connected || desk.play_mode !== 'desk') throw new Error('The bridge could not confirm connected desk mode.');
          }
          await this.request('/action', { action: 'led', color: '#7ce0bd' }, { timeout: 30000, key });
          if (epoch !== this.epoch) return;
          this.protocol = protocol; this.simulator = status.mode !== 'hardware';
          this.connected = true; this.status = 'ready'; this.message = this.simulator ? 'Simulator bridge connected. This is not a physical Evo.' : 'Ozi answered! Lights are ready. Enable floor play below for wheels.'; this.emit();
        });
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.lost(error.message); throw error;
      }
    }
    async poll() {
      if (!this.key || this.status !== 'ready' || this.polling || this.busy || this.stopPending) return;
      const epoch = this.epoch; this.polling = true;
      try {
        const data = await this.request('/health');
        if (epoch !== this.epoch) return;
        if (!data.connected) this.lost('Ozi lost its Bluetooth link. Reconnect when you’re ready.');
        else if (this.floor && data.play_mode !== 'floor') { this.floor = false; this.message = 'The wheels are locked. Set up floor play to use them again.'; this.emit(); }
      } catch (error) { if (epoch === this.epoch) this.lost(error.message); }
      finally { this.polling = false; }
    }
    lost(message) { this.stop().catch(() => {}); this.offline(message); }
    async setFloor(confirmed) {
      if (!this.connected) throw new Error('Connect your Evo first.');
      if (this.protocol < 4) throw new Error('Update the local bridge to version 4 to enable floor play.');
      if (confirmed !== true) { await this.stop(); return; }
      if (this.busy || this.stopPending || this.controlCount) throw new Error('Finish or stop the current activity first.');
      const epoch = this.epoch;
      const key = this.key;
      try {
        await this.enqueue(async () => {
          if (epoch !== this.epoch) throw N.abortError();
          const result = await this.request('/play-mode', { mode: 'floor', floor_confirmed: true }, { key });
          if (epoch !== this.epoch || !this.connected) throw N.abortError();
          if (!result.connected || result.play_mode !== 'floor') throw new Error('Floor play was not armed by the bridge.');
          this.floor = true; this.emit();
        });
      } catch (error) { if (epoch === this.epoch) this.stop().catch(() => {}); throw error; }
    }
    async perform(steps, signal) {
      if (signal?.aborted) throw N.abortError();
      if (this.status === 'screen') return { ok: true, simulated: true };
      if (!this.connected) throw new Error('Reconnect Ozi, or choose screen play in setup.');
      if (this.busy || this.stopPending || this.controlCount) throw new Error('Ozi is finishing its last action. Try again in a moment.');
      const filtered = this.floor ? steps : steps.map(s => { const { move, turn, ...safe } = s; return safe; }).filter(s => Object.keys(s).length);
      if (!filtered.length) return { ok: true, lightsOnly: true };
      const epoch = this.epoch, op = { controller: new AbortController(), key: this.key };
      const cancel = () => { if (this.operation === op && epoch === this.epoch) this.stop().catch(() => {}); };
      this.operation = op; this.busy = true;
      signal?.addEventListener('abort', cancel, { once: true }); this.emit();
      try {
        const result = await this.request('/sequence', { steps: filtered, source: 'playroom' }, { timeout: 35000, signal: op.controller.signal, key: op.key });
        if (signal?.aborted || op.controller.signal.aborted || epoch !== this.epoch) throw N.abortError();
        if (result.truncated) { const error = new Error('Ozi stopped before the routine finished. Try a shorter routine.'); error.code = 'ROUTINE_TRUNCATED'; throw error; }
        return result;
      } catch (error) {
        if (epoch === this.epoch && this.operation === op) {
          if (error.name === 'AbortError' || error.code === 'ROUTINE_TRUNCATED') this.stop().catch(() => {});
          else if (!error.status || error.status >= 500 || /not connected|link|Bluetooth/i.test(error.message)) this.lost(error.message);
        }
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
        if (this.operation === op) { this.operation = null; this.busy = false; this.emit(); }
      }
    }
    async readColor(signal) {
      if (!this.connected) throw new Error('Connect Ozi to read real paper colors.');
      if (this.busy || this.stopPending) throw new Error('Wait for Ozi to finish the current move.');
      const epoch = this.epoch;
      try { const d = await this.request('/action', { action: 'read_color' }, { timeout: 30000, signal }); if (epoch !== this.epoch) throw N.abortError(); return d.surface; }
      catch (e) { if (e.name !== 'AbortError' && epoch === this.epoch) this.lost(e.message); throw e; }
    }
    stop() {
      const epoch = this.invalidate(), key = this.key;
      if (this.status === 'connecting') this.status = 'offline';
      if (this.stopJob?.key === key) { this.stopJob.epoch = epoch; this.emit(); return this.stopPending; }
      if (!key) { this.emit(); return Promise.resolve(); }
      const job = { key, epoch }, hadControls = this.controlCount > 0;
      const immediate = this.request('/stop', {}, { timeout: 8000, key }).then(value => ({ value }), error => ({ error }));
      const final = this.enqueue(async () => {
        const first = await immediate;
        if (hadControls) return this.request('/stop', {}, { timeout: 8000, key });
        if (first.error) throw first.error;
        return first.value;
      });
      this.stopJob = job;
      this.stopPending = final.catch(error => {
        // Do not call lost(): its best-effort STOP would recurse on failure.
        if (this.status !== 'screen') this.offline('Stop could not be confirmed. Turn off the Evo if it is still moving.', job.epoch);
        throw error;
      }).finally(() => { if (this.stopJob === job) { this.stopJob = null; this.stopPending = null; this.emit(); } });
      this.emit(); return this.stopPending;
    }
    async disconnect(toScreen = false) {
      const key = this.key; this.stop().catch(() => {});
      const epoch = this.epoch;
      this.connected = false; this.status = toScreen ? 'screen' : 'offline'; this.emit();
      // Cleanup uses the old key and precedes any subsequent queued connect.
      if (key) { try { await this.enqueue(() => this.request('/disconnect', {}, { timeout: 12000, key })); } catch { /* Still attempt disconnect when STOP failed. */ } }
      if (epoch !== this.epoch) return;
      this.connected = false; this.floor = false; this.status = toScreen ? 'screen' : 'offline';
      if (toScreen) { this.key = ''; this.simulator = false; this.message = ''; }
      this.emit();
    }
  }
  N.Bridge = Bridge;
})();
