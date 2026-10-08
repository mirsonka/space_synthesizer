// Волна кругов второго экрана под музыку (scripts/colorMusic.js).
// Пока играет тема, круги покачиваются бегущей волной, слегка поворачиваются
// и «вдыхают» на каждую долю. Лента при этом продолжает ехать вправо:
// она движется через transform контейнера, а волна — через отдельные
// свойства translate/rotate/scale каждого круга, они не мешают друг другу
// и увеличению при наведении.
(() => {
  const container = document.querySelector(".choose__circles");
  const stage = document.querySelector(".choose__stage");
  if (!container || !stage) return;

  const circles = [...container.querySelectorAll(".circle")];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- Настройки ----------
  // Размах, скорость и пульс волны для каждого цвета задаются в colorMusic.js
  // (THEMES → wave); здесь — общий характер движения

  const LAYOUT_WIDTH = 1440; // ширина макета: --u = ширина экрана / 1440
  const CIRCLE_STEP = 260; // шаг кругов в ленте, px макета (320 − 60)
  const WAVE_LENGTH = 780; // длина волны = период узора, поэтому зацикливание ленты незаметно
  const SMOOTHING = 2.5; // 1/с, как быстро волна нарастает, гаснет и меняет характер
  const PHASE_LOCK = 3; // 1/с, как плотно фаза волны подстраивается под доли
  const TILT = 0.2; // градусов наклона на 1 px размаха
  const PULSE_DECAY = 5; // как быстро гаснет «вдох» после доли

  // ---------- Состояние ----------

  let amplitude = 0;
  let pulseAmount = 0;
  let beatsPerCycle = 2;
  let phase = 0;
  let rate = 0; // текущая скорость фазы, рад/с
  let frame = null;
  let lastTime = null;

  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a)); // угол в −π…π
  const approach = (value, target, k) => value + (target - value) * k;

  // Один шаг анимации. isMusicPlaying — играет ли тема, rhythmData — ритм
  // из colorMusic.getRhythmData(), dt — время с прошлого кадра (с).
  // Возвращает false, когда волна полностью затихла и кадры больше не нужны
  function updateWaveMotion(isMusicPlaying, rhythmData, dt) {
    const k = 1 - Math.exp(-SMOOTHING * dt);
    const wave = isMusicPlaying ? rhythmData.wave : null;

    amplitude = approach(amplitude, wave ? wave.amplitude : 0, k);
    pulseAmount = approach(pulseAmount, wave ? wave.pulse : 0, k);

    let pulse = 0;
    if (wave) {
      beatsPerCycle = approach(beatsPerCycle, wave.beatsPerCycle, k);
      rate = ((rhythmData.bpm / 60) * Math.PI * 2) / beatsPerCycle;
      // Фаза идёт плавно, но притягивается к долям — волна держит такт
      const target = (rhythmData.beat / beatsPerCycle) * Math.PI * 2;
      phase += rate * dt + wrap(target - phase) * (1 - Math.exp(-PHASE_LOCK * dt));
      pulse = Math.exp(-(rhythmData.beat % 1) * PULSE_DECAY) * pulseAmount;
    } else {
      phase += rate * dt; // после остановки волна дотекает и гаснет
    }

    if (!isMusicPlaying && amplitude < 0.05) {
      circles.forEach((circle) => {
        circle.style.translate = "";
        circle.style.rotate = "";
        circle.style.scale = "";
      });
      amplitude = pulseAmount = 0;
      return false;
    }

    // Фаза каждого круга зависит от его места на экране, а не от номера,
    // поэтому волна бежит по ленте и не прыгает при её зацикливании
    const u = stage.clientWidth / LAYOUT_WIDTH;
    const left = (container.getBoundingClientRect().left - stage.getBoundingClientRect().left) / u;
    circles.forEach((circle, i) => {
      const x = left + i * CIRCLE_STEP;
      const theta = phase - (x / WAVE_LENGTH) * Math.PI * 2;
      const y = amplitude * Math.sin(theta);
      circle.style.translate = `0 calc(${y.toFixed(2)} * var(--u))`;
      circle.style.rotate = `${(amplitude * TILT * Math.cos(theta)).toFixed(2)}deg`;
      circle.style.scale = (1 + pulse).toFixed(4);
    });
    return true;
  }

  const loop = (time) => {
    const dt = lastTime === null ? 0 : Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;
    const rhythm = window.colorMusic ? window.colorMusic.getRhythmData() : { playing: false };
    const active = updateWaveMotion(rhythm.playing, rhythm, dt);
    frame = active ? requestAnimationFrame(loop) : null;
    if (!active) lastTime = null;
  };

  document.addEventListener("colorthemechange", () => {
    if (frame || reduceMotion.matches) return;
    frame = requestAnimationFrame(loop);
  });

  window.waveMotion = { updateWaveMotion };
})();
