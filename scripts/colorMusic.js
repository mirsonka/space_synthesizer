// Генеративная музыка второго экрана: клик по кругу включает тему его цвета.
// Каждая тема — маленький секвенсор на Web Audio API: партии не записаны
// заранее, а сочиняются на ходу по правилам (лад, аккорды, вероятности),
// поэтому музыка всё время немного разная.
//
// UX: клик по кругу другого цвета плавно переключает тему, клик по кругу
// того же цвета, что уже играет, — плавно останавливает музыку.
//
// AudioContext общий с музыкой первого экрана (scripts/musicEngine.js).
// Наружу: window.colorMusic = { playColorTheme, stopCurrentTheme,
// toggleColorTheme, getRhythmData }. При смене темы на document отправляется
// событие "colorthemechange" — на него подписана волна (scripts/waveMotion.js).
(() => {
  // ---------- Общие настройки ----------

  const LOOKAHEAD = 0.12; // с, на сколько вперёд планируются ноты
  const TICK_MS = 25; // как часто планировщик дописывает ноты
  const FADE_IN = 0.08; // с, плавный вход темы
  const FADE_OUT = 0.6; // с, плавный выход темы при остановке/смене

  const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const chance = (p) => Math.random() < p;

  let graph = null; // { ctx, dry, fx } из musicEngine
  let noiseBuffer = null; // белый шум для хэтов и снейра, создаётся один раз
  let current = null; // играющая тема
  let playToken = 0; // защита от гонки при быстрых кликах
  let pausedByHidden = false;

  // ---------- Инструменты ----------
  // Каждый звук — набор узлов, которые сами отключаются после затухания

  const cleanupOnEnd = (source, nodes) => {
    source.onended = () => nodes.forEach((node) => node.disconnect());
  };

  // Нота: осцилляторы → фильтр → огибающая → панорама → выход темы.
  // attack — нарастание, dur — сколько держится, release — затухание (с).
  // filterTo/filterTime — фильтр закрывается после удара (кислотный «квак»)
  function note(out, time, midi, opts = {}) {
    const { ctx } = graph;
    const {
      partials = [{ type: "sine" }],
      gain = 0.05,
      attack = 0.01,
      dur = 0.2,
      release = 0.3,
      sustain = 0.7,
      cutoff = 4000,
      filterTo = null,
      filterTime = 0.15,
      Q = 0.7,
      pan = 0,
    } = opts;
    const hold = Math.max(dur, attack);
    const end = time + hold + release;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = Q;
    filter.frequency.setValueAtTime(cutoff, time);
    if (filterTo) filter.frequency.exponentialRampToValueAtTime(filterTo, time + filterTime);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(gain, time + attack);
    env.gain.setTargetAtTime(gain * sustain, time + attack, hold / 3 + 0.01);
    env.gain.setTargetAtTime(0, time + hold, release / 5);

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    filter.connect(env).connect(panner).connect(out);

    const nodes = [filter, env, panner];
    const freq = midiToHz(midi);
    let first = null;
    partials.forEach((p) => {
      const osc = ctx.createOscillator();
      osc.type = p.type || "sine";
      osc.frequency.value = freq * (p.ratio ?? 1);
      osc.detune.value = p.detune ?? 0;
      const level = ctx.createGain();
      level.gain.value = p.gain ?? 1;
      osc.connect(level).connect(filter);
      osc.start(time);
      osc.stop(end + 0.05);
      nodes.push(osc, level);
      first = first || osc;
    });
    cleanupOnEnd(first, nodes);
  }

  // Бочка: синус с быстро падающей высотой
  function kick(out, time, gain = 0.4) {
    const { ctx } = graph;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(140, time);
    osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(gain, time + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, time + 0.35);
    osc.connect(env).connect(out);
    osc.start(time);
    osc.stop(time + 0.4);
    cleanupOnEnd(osc, [osc, env]);
  }

  // Шумовые удары: хэт (highpass), снейр/клэп (bandpass)
  function noise(out, time, { gain = 0.02, dur = 0.05, type = "highpass", freq = 8000, Q = 0.7, pan = 0 } = {}) {
    const { ctx } = graph;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = Q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(gain, time + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    src.connect(filter).connect(env).connect(panner).connect(out);
    src.start(time, Math.random() * 0.5);
    src.stop(time + dur + 0.02);
    cleanupOnEnd(src, [src, filter, env, panner]);
  }

  // ---------- Темы цветов ----------
  // bpm — темп, swing — сдвиг чётных шестнадцатых (0…0.5),
  // level — громкость темы, fx — сколько уходит в эхо/реверб,
  // wave — характер волны кругов (настраивается в waveMotion.js по этим числам):
  //   amplitude — размах в px макета, beatsPerCycle — долей на одну волну,
  //   pulse — сила «вдоха» кругов на каждую долю.
  // setup() — начальное состояние генератора, step() — что звучит на шестнадцатой i
  const THEMES = {
    // Розово-оранжевые круги: «Neon dream» — мечтательный synthwave,
    // пэд из расстроенных пил и арпеджио, бредущее по нотам аккорда
    pink: {
      bpm: 96,
      swing: 0,
      level: 0.9,
      fx: 0.4,
      wave: { amplitude: 28, beatsPerCycle: 2, pulse: 0.035 },
      chords: [
        [57, 60, 64], // Am
        [53, 57, 60], // F
        [60, 64, 67], // C
        [55, 59, 62], // G
      ],
      setup: () => ({ arp: 0 }),
      step(i, t, s, out, sixteenth) {
        const pos = i % 16;
        const chord = this.chords[Math.floor(i / 16) % this.chords.length];
        if (pos === 0) {
          chord.forEach((m) =>
            note(out, t, m, {
              partials: [
                { type: "sawtooth", detune: -9, gain: 0.5 },
                { type: "sawtooth", detune: 9, gain: 0.5 },
              ],
              gain: 0.03,
              attack: 0.5,
              dur: sixteenth * 15,
              release: 1.2,
              sustain: 0.9,
              cutoff: 900,
            })
          );
        }
        if (pos === 0 || pos === 6 || pos === 10) {
          note(out, t, chord[0] - 24, {
            partials: [{ type: "sine" }, { type: "triangle", gain: 0.3 }],
            gain: 0.13,
            dur: sixteenth * 2,
            release: 0.2,
            cutoff: 500,
          });
        }
        // Арпеджио: на каждую восьмую и иногда на шестнадцатую,
        // шаг по нотам аккорда (с октавой выше) случайно вверх или вниз
        if (pos % 2 === 0 || chance(0.25)) {
          const tones = [...chord, ...chord.map((m) => m + 12)];
          s.arp = Math.max(0, Math.min(tones.length - 1, s.arp + pick([-2, -1, 1, 1, 2])));
          const octave = chance(0.12) ? 12 : 0;
          note(out, t, tones[s.arp] + octave, {
            partials: [{ type: "sawtooth" }, { type: "square", gain: 0.2, detune: 6 }],
            gain: 0.035,
            attack: 0.005,
            dur: 0.05,
            release: 0.3,
            sustain: 0.4,
            cutoff: 2600,
            filterTo: 700,
            filterTime: 0.2,
            pan: pos % 4 === 0 ? -0.4 : 0.4,
          });
        }
        if (pos === 0 || pos === 8 || (pos === 11 && chance(0.3))) kick(out, t, 0.32);
        if (pos % 4 === 2) noise(out, t, { gain: 0.025, dur: 0.06 });
      },
    },

    // Кремовые круги: «Warm lo-fi» — медленный тёплый лоу-фай со свингом:
    // электропиано, мягкая мелодия по пентатонике, щёточные барабаны
    cream: {
      bpm: 74,
      swing: 0.3,
      level: 0.95,
      fx: 0.35,
      wave: { amplitude: 36, beatsPerCycle: 4, pulse: 0.02 },
      chords: [
        [60, 64, 67, 71], // Cmaj7
        [57, 60, 64, 67], // Am7
        [53, 57, 60, 64], // Fmaj7
        [55, 59, 62, 64], // G6
      ],
      melodyScale: [72, 74, 76, 79, 81, 84, 86, 88], // до-мажорная пентатоника
      setup: () => ({ melody: 3 }),
      step(i, t, s, out, sixteenth) {
        const pos = i % 16;
        const chord = this.chords[Math.floor(i / 16) % this.chords.length];
        const rhodes = {
          partials: [
            { type: "sine" },
            { type: "sine", ratio: 2, gain: 0.22 },
            { type: "sine", ratio: 3, gain: 0.06 },
          ],
          attack: 0.012,
          release: 1.4,
          sustain: 0.5,
          cutoff: 2400,
        };
        // Аккорд «перебором» с небольшой задержкой между нотами
        if (pos === 0) {
          chord.forEach((m, k) =>
            note(out, t + k * 0.025, m, { ...rhodes, gain: 0.045, dur: sixteenth * 12 })
          );
        }
        if (pos === 10 && chance(0.5)) {
          chord.slice(-2).forEach((m, k) =>
            note(out, t + k * 0.03, m, { ...rhodes, gain: 0.03, dur: sixteenth * 4 })
          );
        }
        if (pos === 0 || (pos === 7 && chance(0.6)) || pos === 12) {
          note(out, t, chord[0] - 24, {
            partials: [{ type: "triangle" }],
            gain: 0.12,
            dur: sixteenth * 3,
            release: 0.3,
            cutoff: 600,
          });
        }
        // Мелодия: случайное блуждание по пентатонике небольшими шагами
        if (pos % 4 === 0 && pos !== 0 && chance(0.55)) {
          s.melody = Math.max(0, Math.min(this.melodyScale.length - 1, s.melody + pick([-2, -1, -1, 1, 1, 2])));
          note(out, t, this.melodyScale[s.melody], {
            partials: [{ type: "triangle" }, { type: "sine", ratio: 2, gain: 0.12 }],
            gain: 0.04,
            attack: 0.02,
            dur: sixteenth * 2,
            release: 0.7,
            cutoff: 3000,
            pan: 0.25,
          });
        }
        if (pos === 0 || (pos === 10 && chance(0.5))) kick(out, t, 0.3);
        if (pos === 4 || pos === 12) {
          noise(out, t, { gain: 0.05, dur: 0.18, type: "bandpass", freq: 1800, Q: 0.8 });
        }
        if (pos % 2 === 0) noise(out, t, { gain: 0.014, dur: 0.04, pan: -0.3 });
      },
    },

    // Салатовые круги: «Acid pulse» — бодрая электроника: кислотный бас,
    // который сам себя переписывает каждые два такта, и случайные «бипы»
    lime: {
      bpm: 122,
      swing: 0,
      level: 0.75,
      fx: 0.3,
      wave: { amplitude: 18, beatsPerCycle: 1, pulse: 0.05 },
      root: 40, // E2
      barShift: [0, -4, -2, 0], // E, C, D, E
      bassNotes: [0, 0, 0, 12, 7, 10, 3],
      bleeps: [76, 79, 81, 83, 86, 88, 91, 93], // ми-минорная пентатоника
      setup() {
        const pattern = Array.from({ length: 16 }, () => this.makeStep());
        return { pattern };
      },
      makeStep() {
        return { on: chance(0.7), note: pick(this.bassNotes), accent: chance(0.3) };
      },
      step(i, t, s, out, sixteenth) {
        const pos = i % 16;
        const bar = Math.floor(i / 16);
        // Каждые два такта бас-паттерн немного мутирует
        if (pos === 0 && bar > 0 && bar % 2 === 0) {
          for (let k = 0; k < 3; k++) s.pattern[Math.floor(Math.random() * 16)] = this.makeStep();
        }
        const st = s.pattern[pos];
        if (st.on) {
          const sweep = 0.5 + 0.5 * Math.sin((i / 64) * Math.PI * 2); // медленное открытие фильтра
          note(out, t, this.root + this.barShift[bar % 4] + st.note, {
            partials: [{ type: "sawtooth" }],
            gain: st.accent ? 0.075 : 0.055,
            attack: 0.004,
            dur: sixteenth * 0.6,
            release: 0.08,
            sustain: 0.8,
            cutoff: 500 + sweep * 1500 + (st.accent ? 1400 : 0),
            filterTo: 220,
            filterTime: sixteenth * 0.9,
            Q: 9,
          });
        }
        if (pos % 2 === 1 && chance(0.22)) {
          note(out, t, pick(this.bleeps), {
            gain: 0.03,
            attack: 0.003,
            dur: 0.03,
            release: 0.25,
            sustain: 0.3,
            cutoff: 6000,
            pan: Math.random() * 1.4 - 0.7,
          });
        }
        if (pos % 4 === 0) kick(out, t, 0.42);
        if (pos === 4 || pos === 12) {
          noise(out, t, { gain: 0.04, dur: 0.12, type: "bandpass", freq: 1500, Q: 1.2 });
        }
        if (pos % 4 === 2) noise(out, t, { gain: 0.03, dur: 0.12, pan: 0.2 });
        else noise(out, t, { gain: 0.01, dur: 0.03, pan: -0.2 });
      },
    },
  };

  // ---------- Планировщик ----------
  // Ноты планируются по часам AudioContext на LOOKAHEAD вперёд:
  // ритм не зависит от загрузки страницы и таймеров

  function tick() {
    const c = current;
    if (!c) return;
    const { ctx } = graph;
    const sixteenth = 60 / c.theme.bpm / 4;
    // После паузы (вкладка была скрыта) догоняем текущее время, а не играем всё разом
    if (c.nextTime < ctx.currentTime - 0.1) c.nextTime = ctx.currentTime + 0.02;
    while (c.nextTime < ctx.currentTime + LOOKAHEAD) {
      const swing = c.step % 2 ? c.theme.swing * sixteenth : 0;
      c.theme.step(c.step, c.nextTime + swing, c.state, c.out, sixteenth);
      c.nextTime += sixteenth;
      c.step++;
    }
  }

  const notify = () => {
    document.dispatchEvent(
      new CustomEvent("colorthemechange", { detail: { color: current ? current.color : null } })
    );
  };

  // ---------- Управление ----------

  // Плавно гасит играющую тему; её ноты дозвучат и отключатся сами
  function stopCurrentTheme() {
    if (!current) return;
    const { ctx } = graph;
    const { out, send, timer } = current;
    clearInterval(timer);
    out.gain.cancelScheduledValues(ctx.currentTime);
    out.gain.setValueAtTime(out.gain.value, ctx.currentTime);
    out.gain.setTargetAtTime(0, ctx.currentTime, FADE_OUT / 5);
    setTimeout(() => {
      out.disconnect();
      send.disconnect();
    }, (FADE_OUT + 2) * 1000);
    current = null;
    notify();
  }

  // Включает тему цвета; если играет другая — плавно сменяет её
  async function playColorTheme(color) {
    const theme = THEMES[color];
    if (!theme) return;
    graph = graph || window.musicEngine?.getAudioGraph();
    if (!graph) return;
    const { ctx } = graph;
    const token = ++playToken;
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        return;
      }
    }
    if (token !== playToken) return; // пока ждали, пользователь кликнул ещё раз

    if (!noiseBuffer) {
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }

    stopCurrentTheme();

    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(theme.level, now + FADE_IN);
    out.connect(graph.dry);
    const send = ctx.createGain();
    send.gain.value = theme.fx;
    out.connect(send).connect(graph.fx);

    const start = now + 0.03;
    current = {
      color,
      theme,
      out,
      send,
      state: theme.setup(),
      step: 0,
      startTime: start,
      nextTime: start,
      timer: setInterval(tick, TICK_MS),
    };
    tick();
    notify();
  }

  // Клик по уже играющему цвету — стоп, по другому — смена темы
  function toggleColorTheme(color) {
    if (current && current.color === color) {
      playToken++;
      stopCurrentTheme();
    } else {
      playColorTheme(color);
    }
  }

  // Ритм для анимации: доля (beat) считается по часам звука,
  // с поправкой на задержку вывода — движение совпадает с тем, что слышно
  function getRhythmData() {
    if (!current) return { playing: false };
    const { ctx } = graph;
    const latency = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    const beat = ((ctx.currentTime - latency - current.startTime) * current.theme.bpm) / 60;
    return {
      playing: true,
      color: current.color,
      bpm: current.theme.bpm,
      beat: Math.max(beat, 0),
      wave: current.theme.wave,
    };
  }

  // ---------- Подключение ----------

  document.querySelector(".choose__circles")?.addEventListener("click", (event) => {
    const circle = event.target.closest(".circle");
    if (!circle) return;
    const color = Object.keys(THEMES).find((name) => circle.classList.contains("circle--" + name));
    if (color) toggleColorTheme(color);
  });

  // Скрытая вкладка: браузер замедляет таймеры, поэтому звук ставится на паузу
  document.addEventListener("visibilitychange", () => {
    if (!graph) return;
    if (document.hidden && current && graph.ctx.state === "running") {
      pausedByHidden = true;
      graph.ctx.suspend();
    } else if (!document.hidden && pausedByHidden) {
      pausedByHidden = false;
      graph.ctx.resume();
    }
  });

  window.colorMusic = { playColorTheme, stopCurrentTheme, toggleColorTheme, getRhythmData };
})();
