/*
 * Ozi Play Club — plain browser JS; loading this file does not move the robot.
 * window.OziClub.TRICKS / MOVES contain old-bridge steps (mm, mm/s, degrees,
 * degrees/s, seconds). Positive turns are left; a full spin is two 180s.
 *
 * createActivities({ perform, sleep, now, update, onComplete, isHardware,
 *                    readColor }) -> { start, input, stop, snapshot, busy }.
 * perform(steps, signal) owns animation, transport, and movement permission;
 * it must reject failed/partial execution. sleep(ms, signal) owns timers.
 * Both must honor abort. now() is a monotonic millisecond clock. readColor
 * returns the actual sensor string or { surface: string }; no guessed colors.
 * update(snapshot) and onComplete({ kind, won, score, message }) are callbacks.
 * Snapshot/error strings are plain text; render them as text, never HTML.
 *
 * start('freeze'|'copycat'|'color'|'trail') resolves true on game completion
 * (including a loss), false on duplicate/unknown start, stop, or runtime error.
 * input(value) returns whether the current prompt accepted it. Values are
 * 'freeze', 'red'|'blue'|'green'|'yellow', 'read', or 'forward'|'left'|'right'.
 * Early Freeze taps warn and return false. Input during execution is ignored.
 * stop() returns whether a run was aborted; errors/aborts never call onComplete.
 * snapshot() returns a detached copy; busy() is synchronous. Hardware/screen
 * mode is captured at start. Trail is a plan, never physical localization.
 * No DOM, audio, network, storage, automatic startup, or completion movement.
 */
(function (club) {
  'use strict';

  const LIGHT = Object.freeze({
    red: '#ff405e', blue: '#3988ff', green: '#24d68b', yellow: '#ffd34d',
    pink: '#ff63c3', purple: '#a477ff', white: '#ffffff', off: '#000000'
  });
  const COLORS = Object.freeze(['red', 'blue', 'green', 'yellow'].map(function (id) {
    return Object.freeze({ id: id, label: id[0].toUpperCase() + id.slice(1), color: LIGHT[id] });
  }));
  const TITLES = Object.freeze({
    freeze: 'Freeze Dance', copycat: 'Copycat Lights', color: 'Color Quest', trail: 'Treasure Trail'
  });
  const TOTALS = Object.freeze({ freeze: 3, copycat: 5, color: 4, trail: 1 });
  const MAP_NOTE = "The map is a plan. It doesn't track Ozi's real position.";
  const DIRECTIONS = Object.freeze([
    { x: 0, y: -1, name: 'north' }, { x: 1, y: 0, name: 'east' },
    { x: 0, y: 1, name: 'south' }, { x: -1, y: 0, name: 'west' }
  ]);
  const DRIVE_CHOICES = Object.freeze([
    { id: 'forward', label: 'Forward', color: LIGHT.green },
    { id: 'left', label: 'Left', color: LIGHT.blue },
    { id: 'right', label: 'Right', color: LIGHT.pink }
  ]);

  function freezeData(value) {
    Object.keys(value).forEach(function (key) {
      if (value[key] && typeof value[key] === 'object') freezeData(value[key]);
    });
    return Object.freeze(value);
  }

  // Raw motion + waits <= 4.6s; estimated total <= 7s, leaving bridge margin.
  // Estimate adds .15s/step, .2s/LED, .25s/move, and .25s/turn to raw time.
  // Keep <= 16 steps and avoid extra LED commands just for decoration.
  club.TRICKS = freezeData({
    wiggle: {
      title: 'Mega Wiggle', quip: 'Big wiggle energy. Tiny robot superstar!',
      steps: [ // 4.0s raw / 6.6s estimated; returns to its planned starting pose.
        { led: LIGHT.pink, turn: { angle: 60, speed: 120 } },
        { turn: { angle: -120, speed: 120 } },
        { led: LIGHT.blue, turn: { angle: 60, speed: 120 } },
        { led: LIGHT.green, move: { distance: 80, speed: 80 } },
        { move: { distance: -80, speed: 80 } }
      ]
    },
    sneak: {
      title: 'Sneaky Scout', quip: 'Nobody saw me. Except absolutely everybody.',
      steps: [ // 4.32s raw / 6.52s estimated; approach, look, and retreat.
        { led: LIGHT.purple, move: { distance: 80, speed: 60 }, wait: 0.1 },
        { led: LIGHT.yellow, turn: { angle: 90, speed: 120 }, wait: 0.05 },
        { turn: { angle: -90, speed: 120 } },
        { led: LIGHT.blue, move: { distance: -80, speed: 60 } }
      ]
    },
    spin: {
      title: 'Turbo Twirl', quip: 'One whole turn. Still ridiculously cute.',
      steps: [ // 3.0s raw / 4.2s estimated; exactly 360 degrees.
        { led: LIGHT.blue, turn: { angle: 180, speed: 120 } },
        { led: LIGHT.pink, turn: { angle: 180, speed: 120 } }
      ]
    },
    celebrate: {
      title: 'Victory Lap', quip: 'Step up. Spin around. Take a robot bow!',
      steps: [ // 4.5s raw / 6.7s estimated; approach, full spin, retreat.
        { led: LIGHT.yellow, move: { distance: 60, speed: 80 } },
        { led: LIGHT.green, turn: { angle: 180, speed: 120 } },
        { turn: { angle: 180, speed: 120 } },
        { led: LIGHT.blue, move: { distance: -60, speed: 80 } }
      ]
    },
    surprise: {
      title: 'Peekaboo Pop', quip: 'Where did I go? BOOP! Right here.',
      steps: [ // 4.5s raw / 6.7s estimated; keep the big 120 mm peekaboo.
        { led: LIGHT.blue, move: { distance: -120, speed: 80 } },
        { led: LIGHT.yellow, move: { distance: 120, speed: 80 } },
        { led: LIGHT.pink, turn: { angle: 90, speed: 120 } },
        { turn: { angle: -90, speed: 120 } }
      ]
    },
    party: {
      title: 'Party Tornado', quip: 'Left! Right! TWIRL! The floor is mine.',
      steps: [ // 4.0s raw / 6.6s estimated; quick shimmy, then a full spin.
        { led: LIGHT.yellow, turn: { angle: 30, speed: 120 } },
        { turn: { angle: -60, speed: 120 } },
        { led: LIGHT.pink, turn: { angle: 30, speed: 120 } },
        { led: LIGHT.green, turn: { angle: 180, speed: 120 } },
        { turn: { angle: 180, speed: 120 } }
      ]
    }
  });

  club.MOVES = freezeData({
    forward: { title: 'Forward', icon: '↑', steps: [{ move: { distance: 120, speed: 80 } }] },
    back: { title: 'Back', icon: '↓', steps: [{ move: { distance: -120, speed: 80 } }] },
    left: { title: 'Left', icon: '↶', steps: [{ turn: { angle: 90, speed: 120 } }] },
    right: { title: 'Right', icon: '↷', steps: [{ turn: { angle: -90, speed: 120 } }] },
    spin: {
      title: 'Full Spin', icon: '⟳',
      steps: [{ turn: { angle: 180, speed: 120 } }, { turn: { angle: 180, speed: 120 } }]
    },
    wiggle: {
      title: 'Wiggle', icon: '〰',
      steps: [
        { turn: { angle: 90, speed: 120 } },
        { turn: { angle: -180, speed: 120 } },
        { turn: { angle: 90, speed: 120 } }
      ]
    },
    glow: {
      title: 'Rainbow Glow', icon: '🌈',
      steps: COLORS.map(function (color) { return { led: color.color, wait: 0.25 }; })
    },
    pause: { title: 'Pause', icon: 'Ⅱ', steps: [{ wait: 1 }] }
  });

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readable(value, fallback) {
    const text = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 220) : fallback;
  }

  function errorText(error) {
    return readable(error && error.message ? error.message : error, 'An unexpected error interrupted the game.');
  }

  function abortError() {
    const error = new Error('Game stopped.');
    error.name = 'AbortError';
    return error;
  }

  function checkResponse(response) {
    if (response && response.ok === false) {
      throw new Error(errorText(response.error || response.message || 'The robot could not finish that action.'));
    }
    if (response && response.truncated === true) {
      throw new Error('The robot stopped before finishing the requested steps.');
    }
    return response;
  }

  function sensorColor(sample) {
    checkResponse(sample);
    const value = sample && typeof sample === 'object' && Object.prototype.hasOwnProperty.call(sample, 'surface')
      ? sample.surface : sample;
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    let observed;
    if (value == null || value === '') observed = 'no color reading';
    else if (typeof value === 'object') {
      try { observed = readable(JSON.stringify(value), 'an unrecognized reading'); }
      catch (_) { observed = 'an unreadable sensor value'; }
    } else observed = readable(value, 'no color reading');
    return {
      id: COLORS.some(function (color) { return color.id === normalized; }) ? normalized : null,
      observed: observed
    };
  }

  club.createActivities = function createActivities(options) {
    const {
      perform, sleep, now,
      update = function () {}, onComplete = function () {},
      isHardware = function () { return false; }, readColor
    } = options || {};
    [perform, sleep, now, update, onComplete, isHardware].forEach(function (dependency) {
      if (typeof dependency !== 'function') throw new TypeError('Activity dependencies must be functions.');
    });

    let generation = 0;
    let active = null;
    let state = freshState(null);

    function freshState(kind) {
      return {
        kind: kind, phase: kind ? 'starting' : 'idle', title: TITLES[kind] || 'Pick a game',
        instruction: kind ? 'Get ready to play!' : 'Choose a game to start playing with Ozi.',
        round: 0, total: TOTALS[kind] || 0, score: 0,
        input: null, flash: null, choices: [], board: null, result: null
      };
    }

    function snapshot() { return copy(state); }
    function busy() { return active !== null; }
    function current(run) {
      return active === run && generation === run.id && !run.controller.signal.aborted;
    }
    function check(run) { if (!current(run)) throw abortError(); }
    function clockNow() {
      const value = now();
      if (!Number.isFinite(value)) throw new Error('The game clock did not return a valid time.');
      return value;
    }

    function publish(run, patch) {
      check(run);
      state = Object.assign({}, state, copy(patch));
      update(snapshot());
      check(run); // An update callback is allowed to stop the current game.
    }

    // Abort wins even if a dependency ignores its signal or settles much later.
    // Its eventual rejection is still observed, so it cannot leak a rejection.
    async function guarded(run, operation) {
      check(run);
      const signal = run.controller.signal;
      let onAbort;
      try {
        const result = await new Promise(function (resolve, reject) {
          onAbort = function () { reject(abortError()); };
          signal.addEventListener('abort', onAbort, { once: true });
          try { Promise.resolve(operation(signal)).then(resolve, reject); }
          catch (error) { reject(error); }
        });
        check(run);
        return result;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }

    async function execute(run, steps) {
      const response = await guarded(run, function (signal) { return perform(copy(steps), signal); });
      check(run);
      checkResponse(response);
    }

    async function delay(run, ms) {
      await guarded(run, function (signal) { return sleep(ms, signal); });
      check(run);
    }

    // An interaction waits for deliberate input. A retry re-arms the prompt;
    // it does not loop, poll, queue clicks, or start another physical command.
    // There is only one outstanding prompt and at most one handler in flight.
    function interact(run, spec, handle) {
      check(run);
      return new Promise(function (resolve, reject) {
        const signal = run.controller.signal;
        let settled = false;
        let gate = null;
        let openedAt = 0;

        function settle(error, value) {
          if (settled) return;
          settled = true;
          if (run.pending === gate) run.pending = null;
          signal.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve(value);
        }

        function onAbort() { settle(abortError()); }

        function arm(patch) {
          check(run);
          openedAt = clockNow();
          gate = {
            accepts: spec.accepts,
            submit: function (value) {
              if (settled || !current(run) || run.pending !== gate) return false;
              run.pending = null; // Lock immediately, before any await or update.
              let answer;
              try { answer = { value: value, at: clockNow(), openedAt: openedAt }; }
              catch (error) { settle(error); return false; }
              process(answer);
              return true;
            }
          };
          run.pending = gate;
          publish(run, Object.assign({}, patch, { input: spec.input, choices: spec.choices || [] }));
        }

        async function process(answer) {
          try {
            const outcome = await (handle ? handle(answer) : answer);
            check(run);
            if (outcome && outcome.retry) arm(outcome.retry);
            else settle(null, outcome);
          } catch (error) { settle(error); }
        }

        signal.addEventListener('abort', onAbort, { once: true });
        try { arm(spec.ready); }
        catch (error) { settle(error); }
      });
    }

    function isColor(value) {
      return COLORS.some(function (color) { return color.id === value; });
    }

    async function freeze(run) {
      const dances = [
        [
          { led: LIGHT.pink, turn: { angle: 90, speed: 120 }, wait: 0.25 },
          { led: LIGHT.blue, turn: { angle: -90, speed: 120 }, wait: 0.25 }
        ],
        [
          { led: LIGHT.green, move: { distance: 80, speed: 80 } },
          { led: LIGHT.purple, move: { distance: -80, speed: 80 } }
        ],
        [
          { led: LIGHT.blue, turn: { angle: -90, speed: 120 }, wait: 0.25 },
          { led: LIGHT.pink, turn: { angle: 90, speed: 120 }, wait: 0.25 }
        ]
      ];
      for (let round = 1; round <= 3; round += 1) {
        publish(run, {
          phase: 'dancing', round: round, title: 'Dance… wait for FREEZE!',
          instruction: "Dance along if you like. Wait for FREEZE, then tap! We're timing your tap.",
          input: 'freeze', choices: [], flash: LIGHT.pink
        });
        await execute(run, dances[round - 1]);
        check(run);
        await execute(run, [{ led: LIGHT.yellow }]);
        check(run);
        const answer = await interact(run, {
          input: 'freeze', accepts: function (value) { return value === 'freeze'; },
          ready: {
            phase: 'freeze', title: 'FREEZE!', flash: LIGHT.yellow,
            instruction: 'Tap Freeze now! How quick is your finger?'
          }
        });
        check(run);
        const elapsed = Math.max(0, answer.at - answer.openedAt);
        const points = Math.max(10, 100 - Math.floor(elapsed / 25));
        publish(run, {
          phase: 'feedback', input: null, flash: LIGHT.green, title: 'Nice freeze tap!',
          score: state.score + points,
          instruction: Math.round(elapsed) + ' ms — ' + points + ' points!'
        });
        await delay(run, 750);
        check(run);
      }
      return { won: true, score: state.score, message: 'Three freeze taps! You scored ' + state.score + ' out of 300.' };
    }

    async function copycat(run) {
      const pattern = Array.from({ length: 5 }, function () {
        return COLORS[Math.floor(Math.random() * COLORS.length)].id;
      });
      for (let round = 1; round <= 5; round += 1) {
        const prefix = pattern.slice(0, round);
        publish(run, {
          phase: 'watch', round: round, title: 'Watch Ozi’s lights',
          instruction: 'Remember these ' + round + (round === 1 ? ' light.' : ' lights, in order.'),
          input: null, choices: [], flash: null, pattern: prefix, inputIndex: 0
        });
        await delay(run, 400);
        check(run);
        for (let index = 0; index < prefix.length; index += 1) {
          publish(run, {
            flash: LIGHT[prefix[index]],
            instruction: 'Watch: light ' + (index + 1) + ' of ' + round + '.'
          });
          await execute(run, [{ led: LIGHT[prefix[index]], wait: 0.55 }]);
          check(run);
          publish(run, { flash: null });
          await execute(run, [{ led: LIGHT.off, wait: 0.2 }]);
          check(run);
        }
        for (let index = 0; index < prefix.length; index += 1) {
          const answer = await interact(run, {
            input: 'colors', choices: COLORS, accepts: isColor,
            ready: {
              phase: 'input', title: 'Your turn!', flash: null, inputIndex: index,
              instruction: 'Repeat the lights in order. Tap color ' + (index + 1) + ' of ' + round + '.'
            }
          });
          check(run);
          if (answer.value !== prefix[index]) {
            return {
              won: false, score: state.score,
              message: 'You tapped ' + answer.value + '; the next light was ' + prefix[index] + '. Tap play to try a fresh pattern!'
            };
          }
          publish(run, { phase: 'feedback', input: null, choices: [], flash: LIGHT[answer.value] });
          await execute(run, [{ led: LIGHT[answer.value], wait: 0.18 }, { led: LIGHT.off }]);
          check(run);
          publish(run, { score: state.score + 10, inputIndex: index + 1, flash: null });
        }
        publish(run, {
          phase: 'feedback', title: 'Pattern nailed!', input: null, choices: [],
          instruction: round === 5 ? 'You remembered all five!' : 'Here comes one more light…'
        });
        await delay(run, 650);
        check(run);
      }
      return { won: true, score: state.score, message: 'Memory superstar! All five patterns matched — ' + state.score + ' points.' };
    }

    async function colorQuest(run) {
      if (run.hardware && typeof readColor !== 'function') {
        throw new Error('The robot color reader is not connected to this game.');
      }
      for (let index = 0; index < COLORS.length; index += 1) {
        const target = COLORS[index];
        const prompt = run.hardware
          ? 'Place Ozi’s color sensor on a ' + target.id + ' surface, then tap Read Color.'
          : 'Find ' + target.label + '! Tap the matching color.';
        publish(run, {
          round: index + 1, phase: 'target', title: 'Find ' + target.label + '!',
          instruction: prompt, input: null, choices: [], flash: target.color
        });
        await execute(run, [{ led: target.color, wait: 0.45 }, { led: LIGHT.off }]);
        check(run);
        await interact(run, {
          input: run.hardware ? 'readColor' : 'colors', choices: run.hardware ? [] : COLORS,
          accepts: run.hardware ? function (value) { return value === 'read'; } : isColor,
          ready: { phase: 'choose', instruction: prompt, flash: target.color }
        }, async function (answer) {
          let observed = { id: answer.value, observed: answer.value };
          if (run.hardware) {
            publish(run, {
              phase: 'reading', input: null, choices: [],
              instruction: 'Reading the real sensor… keep Ozi over the color.'
            });
            const sample = await guarded(run, function (signal) { return readColor(signal); });
            check(run);
            observed = sensorColor(sample);
          }
          if (observed.id !== target.id) {
            return { retry: {
              phase: 'retry', flash: target.color,
              instruction: (run.hardware ? 'The sensor read “' : 'You chose “') + observed.observed +
                '”. We need ' + target.id + '. ' + prompt
            } };
          }
          publish(run, { phase: 'feedback', input: null, choices: [], instruction: target.label + ' found!' });
          await execute(run, [{ led: target.color, wait: 0.3 }]);
          check(run);
          return target.id;
        });
        check(run);
        publish(run, {
          phase: 'feedback', input: null, choices: [], score: state.score + 25,
          instruction: target.label + ' found! ' + (index + 1) + ' of 4 colors collected.'
        });
        await delay(run, 650);
        check(run);
      }
      return {
        won: true, score: state.score,
        message: run.hardware ? 'All four colors confirmed by Ozi’s sensor! 100 points.' : 'All four colors matched! 100 points.'
      };
    }

    async function trail(run) {
      let board = {
        cols: 5, rows: 5, x: 0, y: 4, heading: 0, goal: { x: 4, y: 0 },
        rocks: [{ x: 1, y: 4 }, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 0, y: 1 }, { x: 3, y: 0 }]
      };
      let commands = 0;
      const outcome = await interact(run, {
        input: 'drive', choices: DRIVE_CHOICES,
        accepts: function (value) { return value === 'forward' || value === 'left' || value === 'right'; },
        ready: {
          phase: 'playing', round: 1, board: board,
          instruction: 'Face north. Steer to the treasure and go around the rocks. ' + MAP_NOTE
        }
      }, async function (answer) {
        const next = copy(board);
        let steps;
        if (answer.value === 'forward') {
          next.x += DIRECTIONS[board.heading].x;
          next.y += DIRECTIONS[board.heading].y;
          const outside = next.x < 0 || next.y < 0 || next.x >= board.cols || next.y >= board.rows;
          const rock = board.rocks.some(function (item) { return item.x === next.x && item.y === next.y; });
          if (outside || rock) {
            return { retry: {
              phase: 'playing', board: board, flash: LIGHT.yellow,
              instruction: (outside ? 'That step leaves the map.' : 'Rock ahead on the map!') +
                ' No move sent. Turn left or right. ' + MAP_NOTE
            } };
          }
          steps = [{ led: LIGHT.green, move: { distance: 70, speed: 70 } }];
        } else {
          const left = answer.value === 'left';
          next.heading = (board.heading + (left ? 3 : 1)) % 4;
          steps = [{ led: left ? LIGHT.blue : LIGHT.pink, turn: { angle: left ? 90 : -90, speed: 120 } }];
        }
        publish(run, {
          phase: 'moving', input: null, choices: [], flash: null,
          instruction: (answer.value === 'forward' ? 'One 70 mm step… ' : 'Turning ' + answer.value + '… ') + MAP_NOTE
        });
        await execute(run, steps);
        check(run);
        board = next; // A failed robot command never advances the plan.
        commands += 1;
        publish(run, { board: board });
        if (board.x === board.goal.x && board.y === board.goal.y) {
          return {
            won: true, score: Math.max(10, 100 - Math.max(0, commands - 12) * 2),
            message: 'Treasure reached on your map in ' + commands + ' commands! ' + MAP_NOTE
          };
        }
        return { retry: {
          phase: 'playing', board: board, flash: null,
          instruction: 'Facing ' + DIRECTIONS[board.heading].name + '. Choose your next step. ' + MAP_NOTE
        } };
      });
      check(run);
      return outcome;
    }

    const runners = { freeze: freeze, copycat: copycat, color: colorQuest, trail: trail };

    async function start(kind) {
      if (active || !Object.prototype.hasOwnProperty.call(runners, kind)) return false;
      const run = { id: ++generation, kind: kind, controller: new AbortController(), pending: null, hardware: false };
      active = run; // Reserve synchronously; two starts cannot race.
      state = freshState(kind);
      try {
        run.hardware = Boolean(isHardware());
        publish(run, {});
        const outcome = await runners[kind](run);
        check(run);
        const result = { won: outcome.won === true, score: outcome.score, message: outcome.message };
        state = Object.assign({}, state, {
          phase: 'complete', title: result.won ? 'You did it!' : 'Give it another go!',
          instruction: result.message, score: result.score, input: null, choices: [],
          flash: result.won ? LIGHT.green : LIGHT.red, result: result
        });
        active = null; // Completion observers see busy() === false.
        update(snapshot());
        if (generation !== run.id || run.controller.signal.aborted) return false;
        onComplete(Object.assign({ kind: kind }, copy(result)));
        return true;
      } catch (error) {
        // Only our own stop/generation change is cancellation. An unexpected
        // AbortError from transport is still an error, never a silent success.
        if (generation !== run.id || run.controller.signal.aborted) return false;
        active = null;
        const message = 'Game paused: ' + errorText(error);
        state = Object.assign({}, state, {
          phase: 'error', title: 'Let’s pause here', instruction: message,
          input: null, choices: [], flash: null, result: { won: false, score: state.score, message: message }
        });
        // If the observer itself is broken, snapshot() still exposes the error.
        try { update(snapshot()); }
        catch (observerError) {
          if (generation === run.id) {
            state.instruction = message + ' Display update failed: ' + errorText(observerError);
            state.result.message = state.instruction;
          }
        }
        return false;
      } finally {
        if (active === run) active = null;
      }
    }

    function input(value) {
      const run = active;
      if (!run || !current(run)) return false;
      if (run.kind === 'freeze' && state.phase === 'dancing' && value === 'freeze') {
        publish(run, { instruction: 'Too soon! Ozi is still dancing. Wait until you see FREEZE, then tap.' });
        return false;
      }
      const gate = run.pending;
      if (!gate || !gate.accepts(value)) return false;
      return gate.submit(value);
    }

    function stop() {
      const run = active;
      if (!run) return false;
      active = null;
      generation += 1;
      run.controller.abort();
      run.pending = null;
      state = Object.assign({}, state, {
        phase: 'stopped', title: 'Game stopped', instruction: 'All done for now. Choose a game when you’re ready.',
        input: null, flash: null, choices: [], result: null
      });
      update(snapshot());
      return true;
    }

    return { start: start, input: input, stop: stop, snapshot: snapshot, busy: busy };
  };
})(window.OziClub = window.OziClub || {});
