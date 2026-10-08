// Генеративная музыка первого экрана: каждое столкновение фигур звучит нотой.
// Все ноты берутся из одной пентатоники и текущего аккорда, поэтому
// одновременные удары складываются в гармоничный аккорд, а не в кашу.
// Звук синтезируется в реальном времени через Web Audio API — без файлов.
//
// Физика ничего не знает о звуке: при новом касании она отправляет событие
// "shapecollision" на .hero__space, а этот модуль его слушает.
// Наружу доступно window.musicEngine = { initAudio, handleCollision,
// playCollisionVoice, getHarmonicNotes, getAudioGraph }. Через getAudioGraph
// музыка второго экрана (colorMusic.js) использует тот же AudioContext.
(() => {
  // ---------- Тональность и гармония ----------

  // Тоника в MIDI-номерах: 62 = D4. Сдвиг на 1 = на полутон (63 = D#, 60 = C)
  const KEY_ROOT = 62;

  // Лад — ступени в полутонах от тоники. Мажорная пентатоника:
  // в ней нет полутонов, поэтому любые сочетания нот звучат мягко
  const SCALE = [0, 2, 4, 7, 9];

  // Аккорды из нот лада (полутоны от тоники); root — басовая нота аккорда.
  // Аккорд сменяется по кругу, если после прошлой смены прошло CHORD_HOLD
  const CHORDS = [
    { root: 0, tones: [0, 4, 7, 9] }, // D6
    { root: 9, tones: [9, 0, 4, 7] }, // Bm7
    { root: 2, tones: [2, 7, 9, 4] }, // Esus4 add9
    { root: 7, tones: [7, 9, 2, 4] }, // A6sus2
  ];

  const CLUSTER_WINDOW = 0.25; // с, удары ближе этого — один аккорд
  const CHORD_HOLD = 6; // с, сколько минимум держится аккорд

  // ---------- Громкость и пространство ----------

  const MASTER_VOLUME = 0.5; // общая громкость
  const MAX_VOICES = 16; // больше нот одновременно — старые плавно гасятся
  const REVERB_SECONDS = 2.8; // длина хвоста реверберации
  const REVERB_MIX = 0.32; // сколько сигнала уходит в реверб
  const DELAY_TIME = 0.36; // с, интервал эха
  const DELAY_FEEDBACK = 0.3; // сколько повторов у эха (0…0.9)
  const DELAY_MIX = 0.16; // громкость эха

  const MIN_STRENGTH = 0.03; // более слабые касания не звучат
  const SHAPE_COOLDOWN = 0.12; // с, одна фигура не звучит чаще этого
  const PHRASE_STEP = 0.11; // с, шаг между нотами фразы у звёзд

  // ---------- Тембры ----------
  // attack — нарастание, release — затухание (с), gain — громкость тембра.
  // partials — осцилляторы: тип волны, кратность частоты (ratio),
  // расстройка в центах (detune), уровень и своё затухание (decay).
  // filter — фильтр низких частот: base + velocity × сила удара,
  // затем закрывается к base за filter.decay — звук «темнеет» по мере затухания
  const TIMBRES = {
    // Большие фигуры: низкий мягкий пэд с суб-басом
    pad: {
      attack: 0.08,
      release: 3.4,
      gain: 0.2,
      partials: [
        { type: "sawtooth", detune: -8, gain: 0.5 },
        { type: "sawtooth", detune: 8, gain: 0.5 },
        { type: "sine", ratio: 0.5, gain: 0.8 },
      ],
      filter: { base: 280, velocity: 1200, decay: 2.5, Q: 0.6 },
    },
    // Средние фигуры: синтезаторный щипок
    pluck: {
      attack: 0.006,
      release: 1.1,
      gain: 0.17,
      partials: [
        { type: "triangle", gain: 0.8 },
        { type: "square", detune: 5, gain: 0.18 },
      ],
      filter: { base: 600, velocity: 3200, decay: 0.35, Q: 2 },
    },
    // Маленькие фигуры: высокий колокольчик; неровные обертоны гаснут быстрее
    bell: {
      attack: 0.004,
      release: 2.6,
      gain: 0.11,
      partials: [
        { type: "sine", gain: 0.8 },
        { type: "sine", ratio: 2.76, gain: 0.3, decay: 0.9 },
        { type: "sine", ratio: 5.4, gain: 0.12, decay: 0.35 },
      ],
      filter: { base: 6000, velocity: 4000, decay: 1, Q: 0.3 },
    },
    // Звёзды: мягкая мелодичная «флейта», играет фразу из трёх нот
    star: {
      attack: 0.025,
      release: 1.3,
      gain: 0.12,
      partials: [
        { type: "triangle", gain: 0.8 },
        { type: "sine", ratio: 2, gain: 0.15 },
      ],
      filter: { base: 1400, velocity: 2400, decay: 0.8, Q: 0.8 },
    },
  };

  // ---------- Характер фигур ----------
  // timbre — тембр, range — диапазон нот в MIDI (не меньше октавы),
  // notes — сколько нот играет фигура за удар
  const SHAPES = {
    "planet--zebra": { timbre: "pad", range: [38, 50] },
    "planet--orange": { timbre: "pad", range: [40, 52] },
    "planet--green": { timbre: "pad", range: [43, 55] },
    "planet--cream": { timbre: "pluck", range: [57, 69] },
    "planet--target": { timbre: "pluck", range: [60, 72] },
    "planet--stripes": { timbre: "pluck", range: [62, 74] },
    "planet--dot": { timbre: "bell", range: [81, 93] },
    "star--pink": { timbre: "star", range: [72, 88], notes: 3 },
    "star--lime": { timbre: "star", range: [67, 83], notes: 3 },
  };
  const DEFAULT_SHAPE = { timbre: "pluck", range: [60, 72] };

  // ---------- Состояние ----------

  let ctx = null; // один AudioContext на всю страницу
  let voiceBus = null; // сюда подключаются все голоса (идёт через эхо и реверб)
  let master = null; // общая громкость → компрессор → лимитер → выход
  let voices = []; // звучащие голоса, от старых к новым
  const lastSound = new WeakMap(); // фигура → время её последней ноты

  const harmony = {
    chordIndex: 0,
    chordSince: 0,
    lastHit: -Infinity,
    usedClasses: new Set(), // ноты (без октавы), уже взятые в текущем аккорде
  };

  const pitchClass = (midi) => (((midi - KEY_ROOT) % 12) + 12) % 12;
  const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

  const profileOf = (shape) => {
    const name = Object.keys(SHAPES).find((cls) => shape.classList?.contains(cls));
    return name ? SHAPES[name] : DEFAULT_SHAPE;
  };

  // Позиция фигуры на экране → панорама слева направо
  const panOf = (shape) => {
    const rect = shape.getBoundingClientRect?.();
    if (!rect || !window.innerWidth) return 0;
    const x = (rect.left + rect.width / 2) / window.innerWidth;
    return Math.max(-1, Math.min(1, (x * 2 - 1) * 0.7));
  };

  // ---------- Аудиограф ----------

  // Импульс реверберации: затухающий стерео-шум, создаётся один раз
  const makeImpulse = (seconds) => {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
      }
    }
    return buffer;
  };

  // Создаёт AudioContext и общую цепочку эффектов. Браузер разрешает звук
  // только после действия пользователя, поэтому вызывается по первому клику.
  // Повторные вызовы лишь возобновляют приостановленный контекст
  function initAudio() {
    if (ctx) {
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    ctx = new AudioCtx({ latencyHint: "interactive" });

    master = ctx.createGain();
    master.gain.value = MASTER_VOLUME;

    // Мягкий компрессор выравнивает громкость, лимитер не даёт перегрузиться
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 12;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;

    voiceBus = ctx.createGain();
    voiceBus.connect(master);

    // Эхо: повторы постепенно темнеют за счёт фильтра в петле
    const delaySend = ctx.createGain();
    delaySend.gain.value = DELAY_MIX;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = DELAY_TIME;
    const delayTone = ctx.createBiquadFilter();
    delayTone.type = "lowpass";
    delayTone.frequency.value = 2200;
    const feedback = ctx.createGain();
    feedback.gain.value = DELAY_FEEDBACK;
    voiceBus.connect(delaySend).connect(delay).connect(delayTone);
    delayTone.connect(feedback).connect(delay);
    delayTone.connect(master);

    // Реверберация
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = REVERB_MIX;
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(REVERB_SECONDS);
    voiceBus.connect(reverbSend).connect(reverb).connect(master);

    master.connect(compressor).connect(limiter).connect(ctx.destination);
    ctx.resume();
    return ctx;
  }

  // ---------- Гармония ----------

  // Удары, пришедшие с паузой меньше CLUSTER_WINDOW, считаются одним аккордом.
  // После паузы начинается новый «кластер» и, если пора, меняется аккорд
  const updateHarmony = (now) => {
    if (now - harmony.lastHit > CLUSTER_WINDOW) {
      if (now - harmony.chordSince > CHORD_HOLD) {
        harmony.chordIndex = (harmony.chordIndex + 1) % CHORDS.length;
        harmony.chordSince = now;
      }
      harmony.usedClasses.clear();
    }
    harmony.lastHit = now;
  };

  // Ноты для фигуры из текущего аккорда в её диапазоне. Предпочитаются ноты,
  // которых ещё нет в звучащем аккорде, — так удары дополняют друг друга.
  // count > 1 — короткая фраза-арпеджио по нотам аккорда
  function getHarmonicNotes(shape, count = 1) {
    const profile = shape.timbre ? shape : profileOf(shape);
    const chord = CHORDS[harmony.chordIndex];
    const [low, high] = profile.range;
    const candidates = [];
    for (let m = low; m <= high; m++) {
      const pc = pitchClass(m);
      if (SCALE.includes(pc) && chord.tones.includes(pc)) candidates.push(m);
    }
    if (!candidates.length) return [];

    const fresh = candidates.filter((m) => !harmony.usedClasses.has(pitchClass(m)));
    const pool = fresh.length ? fresh : candidates;
    let notes;

    if (profile.timbre === "pad") {
      // Бас держит основу аккорда: сначала его корень, потом свободные ноты
      const root = pool.find((m) => pitchClass(m) === chord.root);
      notes = [root ?? pool[0]];
    } else if (count > 1) {
      const n = Math.min(count, candidates.length);
      const start = candidates.indexOf(pool[Math.floor(Math.random() * pool.length)]);
      const from = Math.min(start, candidates.length - n);
      notes = candidates.slice(from, from + n);
      if (Math.random() < 0.4) notes.reverse(); // иногда фраза идёт вниз
    } else {
      notes = [pool[Math.floor(Math.random() * pool.length)]];
    }

    notes.forEach((m) => harmony.usedClasses.add(pitchClass(m)));
    return notes;
  }

  // ---------- Голоса ----------

  // Отключает узлы отзвучавшего голоса, чтобы не копились в памяти
  const releaseVoice = (voice) => {
    voice.nodes.forEach((node) => node.disconnect());
    const index = voices.indexOf(voice);
    if (index !== -1) voices.splice(index, 1);
  };

  // Если голосов слишком много — самые старые плавно гасятся за 60 мс
  const makeRoom = () => {
    const now = ctx.currentTime;
    while (voices.length >= MAX_VOICES) {
      const voice = voices.shift();
      const gain = voice.env.gain;
      if (gain.cancelAndHoldAtTime) {
        gain.cancelAndHoldAtTime(now);
      } else {
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(gain.value, now);
      }
      gain.linearRampToValueAtTime(0, now + 0.06);
      voice.oscillators.forEach((osc) => osc.stop(now + 0.08));
    }
  };

  // Одна нота: осцилляторы → фильтр → огибающая → панорама → общая шина.
  // Огибающая: плавный подъём за attack и экспоненциальное затухание за release
  function playCollisionVoice({ midi, timbre = "pluck", strength = 0.5, when, pan = 0 }) {
    if (!ctx) return;
    const t = TIMBRES[timbre] || TIMBRES.pluck;
    makeRoom();

    const start = Math.max(when ?? 0, ctx.currentTime);
    const end = start + t.attack + t.release;
    const freq = midiToHz(midi);
    const peak = t.gain * (0.3 + 0.7 * strength);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = t.filter.Q;
    const cutoff = Math.min(t.filter.base + t.filter.velocity * strength, 18000);
    filter.frequency.setValueAtTime(cutoff, start);
    filter.frequency.exponentialRampToValueAtTime(t.filter.base, start + t.filter.decay);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + t.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    env.gain.linearRampToValueAtTime(0, end + 0.02);

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;

    filter.connect(env).connect(panner).connect(voiceBus);

    const nodes = [filter, env, panner];
    const oscillators = t.partials.map((p) => {
      const osc = ctx.createOscillator();
      osc.type = p.type;
      osc.frequency.value = freq * (p.ratio ?? 1);
      osc.detune.value = p.detune ?? 0;
      const level = ctx.createGain();
      level.gain.setValueAtTime(p.gain, start);
      if (p.decay) level.gain.exponentialRampToValueAtTime(0.0001, start + p.decay);
      osc.connect(level).connect(filter);
      osc.start(start);
      osc.stop(end + 0.05);
      nodes.push(osc, level);
      return osc;
    });

    const voice = { env, nodes, oscillators };
    oscillators[0].onended = () => releaseVoice(voice);
    voices.push(voice);
  }

  // ---------- Столкновения ----------

  // shapeA, shapeB — элементы фигур, strength — сила удара 0…1.
  // Каждая из двух фигур звучит своим тембром в общем аккорде
  function handleCollision(shapeA, shapeB, strength) {
    if (!ctx || ctx.state !== "running" || strength < MIN_STRENGTH) return;
    const now = ctx.currentTime;
    updateHarmony(now);

    [shapeA, shapeB].forEach((shape) => {
      // Фигура, задевшая сразу несколько других, звучит один раз
      if (now - (lastSound.get(shape) ?? -Infinity) < SHAPE_COOLDOWN) return;
      lastSound.set(shape, now);

      const profile = profileOf(shape);
      const pan = panOf(shape);
      getHarmonicNotes(profile, profile.notes ?? 1).forEach((midi, i) => {
        playCollisionVoice({
          midi,
          timbre: profile.timbre,
          strength: strength * (1 - i * 0.2),
          when: now + i * PHRASE_STEP,
          pan,
        });
      });
    });
  }

  // ---------- Подключение ----------

  // Звук включается первым действием пользователя (политика автозапуска)
  ["pointerdown", "keydown", "touchstart"].forEach((type) => {
    window.addEventListener(type, initAudio, { capture: true, passive: true });
  });

  document.querySelector(".hero__space")?.addEventListener("shapecollision", (event) => {
    const { a, b, strength } = event.detail;
    handleCollision(a, b, strength);
  });

  // Общий AudioContext и шины для других звуковых модулей страницы:
  // dry — сразу на выход, fx — через эхо и реверберацию
  function getAudioGraph() {
    const audio = initAudio();
    return audio ? { ctx: audio, dry: master, fx: voiceBus } : null;
  }

  window.musicEngine = {
    initAudio,
    handleCollision,
    playCollisionVoice,
    getHarmonicNotes,
    getAudioGraph,
  };
})();
