// Весь звук синтезируется на WebAudio — ноль файлов.
//
// Чтобы это не звучало «пиксельно», три правила:
//  1) всё уходит в общий реверб (свёртка с сгенерированным импульсом) — он даёт
//     объём, из-за которого синтез перестаёт звучать как писк из динамика;
//  2) никаких чистых синусов и квадратов на переднем плане: расстроенные слои,
//     негармоничные обертоны и фильтрованный шум;
//  3) мягкие атаки, случайный разброс по высоте и времени.

let ctx = null;
let master = null, dry = null, verbSend = null, comp = null;
let muted = false;       // выбор игрока
let suspended = false;   // вкладка неактивна или идёт реклама
let noiseBuf = null, pinkBuf = null;

function applyGain(time = 0.05) {
  if (!master || !ctx) return;
  master.gain.setTargetAtTime((muted || suspended) ? 0 : 0.85, ctx.currentTime, time);
}

// ------------------------------------------------------------------ базис
function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22;
    comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.22;

    master = ctx.createGain();
    master.gain.value = (muted || suspended) ? 0 : 0.85;
    comp.connect(master).connect(ctx.destination);

    dry = ctx.createGain(); dry.gain.value = 1;
    dry.connect(comp);

    // реверб: тёмный зал старого дома
    const verb = ctx.createConvolver();
    verb.buffer = makeIR(2.9, 3.1);
    const verbLP = ctx.createBiquadFilter();
    verbLP.type = 'lowpass'; verbLP.frequency.value = 2600;
    const verbHP = ctx.createBiquadFilter();
    verbHP.type = 'highpass'; verbHP.frequency.value = 110;
    verbSend = ctx.createGain(); verbSend.gain.value = 1;
    verbSend.connect(verb).connect(verbHP).connect(verbLP).connect(comp);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function makeIR(seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // шум, сглаженный однополюсным фильтром — хвост получается мягче
      lp += ((Math.random() * 2 - 1) - lp) * 0.35;
      d[i] = lp * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

function getNoise() {
  if (!noiseBuf) {
    const len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

// Розовый шум — «мягче» белого, ближе к природным шорохам.
function getPink() {
  if (!pinkBuf) {
    const len = ctx.sampleRate * 3;
    pinkBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = pinkBuf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
  }
  return pinkBuf;
}

// Узел с параллельной посылкой в реверб.
function out(node, wetAmount = 0.25) {
  node.connect(dry);
  if (wetAmount > 0) {
    const s = ctx.createGain();
    s.gain.value = wetAmount;
    node.connect(s).connect(verbSend);
  }
  return node;
}

function noiseSource(pink = false) {
  const src = ctx.createBufferSource();
  src.buffer = pink ? getPink() : getNoise();
  return src;
}

// ------------------------------------------------------------- музыка
// Медленный тёмный эмбиент: дрон + пэд + шумовая текстура + редкий удар
// «колокола». Тональность плавает между несколькими нотами.
const ROOTS = [49.0, 51.9, 55.0, 43.65];   // G1, G#1, A1, F1
let music = null;
let breathGain = null;

function startMusic() {
  if (!ctx || music) return;
  const t = ctx.currentTime;
  const g = ctx.createGain(); g.gain.value = 0;
  out(g, 0.55);

  // --- дрон: две расстроенные пилы через низкий фильтр ---
  const droneGain = ctx.createGain(); droneGain.gain.value = 0.5;
  const dlp = ctx.createBiquadFilter();
  dlp.type = 'lowpass'; dlp.frequency.value = 150; dlp.Q.value = 3;
  const d1 = ctx.createOscillator(); d1.type = 'sawtooth';
  const d2 = ctx.createOscillator(); d2.type = 'sawtooth';
  d1.connect(dlp); d2.connect(dlp); dlp.connect(droneGain).connect(g);

  // --- пэд: кластер с очень долгой атакой ---
  const padGain = ctx.createGain(); padGain.gain.value = 0.16;
  const plp = ctx.createBiquadFilter();
  plp.type = 'lowpass'; plp.frequency.value = 700; plp.Q.value = 1.2;
  const pads = [];
  for (const mult of [2, 3, 4.76, 6]) {           // октава, квинта, негармоника
    const o = ctx.createOscillator();
    o.type = mult > 4 ? 'triangle' : 'sawtooth';
    o.connect(plp);
    pads.push({ o, mult });
  }
  plp.connect(padGain).connect(g);
  // медленное дыхание фильтра
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.045;
  const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 320;
  lfo.connect(lfoAmt).connect(plp.frequency);

  // --- текстура: розовый шум в полосовом фильтре, медленно плывёт ---
  const texGain = ctx.createGain(); texGain.gain.value = 0.05;
  const tex = noiseSource(true); tex.loop = true;
  const tbp = ctx.createBiquadFilter();
  tbp.type = 'bandpass'; tbp.frequency.value = 420; tbp.Q.value = 0.8;
  const tlfo = ctx.createOscillator(); tlfo.frequency.value = 0.031;
  const tlfoAmt = ctx.createGain(); tlfoAmt.gain.value = 260;
  tlfo.connect(tlfoAmt).connect(tbp.frequency);
  tex.connect(tbp).connect(texGain).connect(g);

  // --- слой напряжения: включается, когда монстр близко ---
  const tenGain = ctx.createGain(); tenGain.gain.value = 0;
  const t1 = ctx.createOscillator(); t1.type = 'sawtooth';
  const t2 = ctx.createOscillator(); t2.type = 'sawtooth';
  const tlp = ctx.createBiquadFilter();
  tlp.type = 'bandpass'; tlp.frequency.value = 900; tlp.Q.value = 2.4;
  t1.connect(tlp); t2.connect(tlp); tlp.connect(tenGain).connect(g);

  [d1, d2, ...pads.map(p => p.o), lfo, tlfo, t1, t2].forEach(o => o.start(t));
  tex.start(t);

  music = { g, d1, d2, pads, tenGain, t1, t2, tlp, level: 1, rootI: 0, changeT: 0, bellT: 8 + Math.random() * 10 };
  setRoot(ROOTS[0], 0.01);
  g.gain.setTargetAtTime(0.5, t, 4);
}

function setRoot(f, ramp) {
  if (!music) return;
  const t = ctx.currentTime;
  music.d1.frequency.setTargetAtTime(f, t, ramp);
  music.d2.frequency.setTargetAtTime(f * 1.006, t, ramp);   // биения
  for (const p of music.pads) p.o.frequency.setTargetAtTime(f * p.mult, t, ramp);
  music.t1.frequency.setTargetAtTime(f * 5.66, t, ramp);    // тритон — тревога
  music.t2.frequency.setTargetAtTime(f * 5.71, t, ramp);
}

function stopMusic() {
  if (!music) return;
  const m = music; music = null;
  m.g.gain.setTargetAtTime(0, ctx.currentTime, 0.7);
  setTimeout(() => {
    try {
      [m.d1, m.d2, m.t1, m.t2, ...m.pads.map(p => p.o)].forEach(o => o.stop());
    } catch (e) {}
  }, 3000);
}

// Глухой удар «колокола»: негармоничные обертоны + длинный хвост в ревербе.
function bell() {
  if (!ctx || muted) return;
  const t = ctx.currentTime;
  const base = 110 + Math.random() * 60;
  const g = ctx.createGain(); g.gain.value = 1;
  out(g, 0.9);
  // негармонические множители — так звучит металл, а не музыкальная нота
  [1, 2.76, 5.4, 8.9].forEach((mult, i) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = base * mult;
    const og = ctx.createGain();
    const peak = 0.09 / (i + 1.4);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 2.6 + i * 0.4);
    o.connect(og).connect(g);
    o.start(t); o.stop(t + 4);
  });
}

// Дом оседает: скрип балки где-то далеко.
function houseGroan() {
  if (!ctx || muted) return;
  const t = ctx.currentTime;
  const g = ctx.createGain(); g.gain.value = 1;
  out(g, 0.85);
  const src = noiseSource(true); src.loop = true;
  src.playbackRate.value = 0.35 + Math.random() * 0.3;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.Q.value = 9;
  const base = 90 + Math.random() * 130;
  f.frequency.setValueAtTime(base, t);
  f.frequency.linearRampToValueAtTime(base * (1.3 + Math.random() * 0.5), t + 1.6);
  const vg = ctx.createGain();
  vg.gain.setValueAtTime(0.0001, t);
  vg.gain.linearRampToValueAtTime(0.055, t + 0.5);
  vg.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
  src.connect(f).connect(vg).connect(g);
  src.start(t); src.stop(t + 2.4);
}

// --------------------------------------------- готовые файлы (необязательно)
// Если положить файлы в assets/audio/, они заменят синтез. Формат — ogg или
// mp3, моно/стерео, любой длины. Нет файла — звучит синтез, игра не ломается.
const CLIPS = {
  scream_listener: 'assets/audio/scream_listener',
  scream_watcher:  'assets/audio/scream_watcher',
  thunder:         'assets/audio/thunder',
};
const buffers = {};

export async function loadClips() {
  ensureCtx();
  await Promise.all(Object.entries(CLIPS).map(async ([name, base]) => {
    for (const ext of ['.ogg', '.mp3', '.wav']) {
      try {
        const res = await fetch(base + ext);
        if (!res.ok) continue;
        const raw = await res.arrayBuffer();
        buffers[name] = await ctx.decodeAudioData(raw);
        return;
      } catch (e) { /* нет файла или не декодируется — идём дальше */ }
    }
  }));
  return Object.keys(buffers);
}

function playClip(name, vol = 1, wet = 0.5) {
  const buf = buffers[name];
  if (!buf || !ctx || muted) return false;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  // часть заготовок обрывается на полной громкости — гасим хвост,
  // иначе на стыке слышен щелчок
  const fade = Math.min(0.18, buf.duration * 0.15);
  g.gain.setValueAtTime(vol, t);
  g.gain.setValueAtTime(vol, t + buf.duration - fade);
  g.gain.exponentialRampToValueAtTime(0.0005, t + buf.duration);
  src.connect(g);
  out(g, wet);
  src.start(t);
  src.stop(t + buf.duration + 0.05);
  return true;
}

// ------------------------------------------------------------------- API
export const Sound = {
  unlock() { ensureCtx(); },
  loadClips,
  hasClip(name) { return !!buffers[name]; },
  setMuted(m) {
    muted = m;
    applyGain(0.05);
  },
  get muted() { return muted; },

  // Системное приглушение: вкладка свернулась или показывается реклама.
  // Отдельно от пользовательского мута, чтобы не затирать его выбор.
  setSuspended(s) {
    suspended = s;
    applyGain(0.08);
    if (ctx && s && ctx.state === 'running') { try { ctx.suspend(); } catch (e) {} }
    if (ctx && !s && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
  },

  startDrone() { ensureCtx(); startMusic(); },
  stopDrone() { stopMusic(); },

  // 0 — заглушить музыку целиком (модификатор «тишина»), 1 — обычная громкость
  setMusicLevel(v) {
    if (!music || !ctx) return;
    if (music.level === v) return;
    music.level = v;
    music.g.gain.setTargetAtTime(0.5 * v, ctx.currentTime, 1.2);
  },

  // диагностика: жив ли контекст и что сейчас звучит
  debug() {
    return {
      ctx: ctx ? ctx.state : 'none',
      muted,
      music: !!music,
      masterGain: master ? +master.gain.value.toFixed(2) : null,
      tension: music ? +music.tenGain.gain.value.toFixed(3) : null,
      root: music ? ROOTS[music.rootI] : null,
      nextEvent: music ? +music.bellT.toFixed(1) : null,
    };
  },

  // Вызывается каждый кадр: развитие музыки и случайные звуки дома.
  update(dt, tension) {
    if (!music || !ctx) return;
    // смена тональности раз в ~40 секунд
    music.changeT -= dt;
    if (music.changeT <= 0) {
      music.changeT = 34 + Math.random() * 22;
      let next = music.rootI;
      while (next === music.rootI) next = Math.floor(Math.random() * ROOTS.length);
      music.rootI = next;
      setRoot(ROOTS[next], 6);
    }
    // редкие акценты
    music.bellT -= dt;
    if (music.bellT <= 0) {
      music.bellT = 16 + Math.random() * 26;
      Math.random() < 0.55 ? bell() : houseGroan();
    }
    // слой тревоги
    const target = Math.pow(Math.max(0, Math.min(1, tension)), 1.6) * 0.09;
    music.tenGain.gain.setTargetAtTime(target, ctx.currentTime, 0.5);
    music.tlp.frequency.setTargetAtTime(700 + tension * 1500, ctx.currentTime, 0.6);
  },

  // --- сердце ---------------------------------------------------------
  _heartT: 0, _heartPhase: 0,
  heartbeat(dt, bpm, intensity) {
    if (!ctx || muted) return false;
    this._heartT += dt;
    const interval = 60 / bpm;
    if (this._heartT >= (this._heartPhase === 0 ? interval * 0.72 : interval * 0.28)) {
      this._heartT = 0;
      const second = this._heartPhase === 1;
      this._heartPhase = second ? 0 : 1;
      thump(second ? 0.6 : 1.0, 0.25 + intensity * 0.75);
      return !second;
    }
    return false;
  },

  // --- шаги -----------------------------------------------------------
  playerStep(running, silent) {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const vol = silent ? 0.045 : (running ? 0.26 : 0.1);
    const g = ctx.createGain(); g.gain.value = 1;
    out(g, silent ? 0.05 : 0.16);
    // удар подошвы: короткий шумовой транзиент + низкая «телесная» составляющая
    const src = noiseSource(true);
    src.playbackRate.value = 0.75 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = running ? 1500 : 950;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(vol, t);
    ng.gain.exponentialRampToValueAtTime(0.0005, t + 0.075);
    src.connect(f).connect(ng).connect(g);
    src.start(t, Math.random() * 1.5); src.stop(t + 0.12);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(62, t + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * 0.5, t);
    og.gain.exponentialRampToValueAtTime(0.0005, t + 0.09);
    o.connect(og).connect(g);
    o.start(t); o.stop(t + 0.12);
  },

  monsterStep(distNorm, wallCount) {
    if (!ctx || muted) return;
    const vol = (1 - distNorm) * 0.5;
    if (vol <= 0.01) return;
    const t = ctx.currentTime;
    const cutoff = Math.max(110, 700 - wallCount * 220);
    const g = ctx.createGain(); g.gain.value = 1;
    // чем дальше и чем больше стен — тем больше «хвоста», меньше прямого звука
    out(g, 0.2 + distNorm * 0.5 + wallCount * 0.08);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(72, t);
    o.frequency.exponentialRampToValueAtTime(36, t + 0.11);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol, t);
    og.gain.exponentialRampToValueAtTime(0.0005, t + 0.18);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = cutoff;
    o.connect(f).connect(og).connect(g);
    o.start(t); o.stop(t + 0.22);

    // шорох по полу — глохнет за стенами первым
    if (wallCount < 2) {
      const src = noiseSource(true);
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass'; nf.frequency.value = 500; nf.Q.value = 1;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(vol * 0.35, t);
      ng.gain.exponentialRampToValueAtTime(0.0005, t + 0.1);
      src.connect(nf).connect(ng).connect(g);
      src.start(t, Math.random()); src.stop(t + 0.14);
    }
  },

  // --- дыхание Слушателя рядом ----------------------------------------
  setBreath(level) {
    if (!ctx || muted) { if (breathGain) breathGain.gain.value = 0; return; }
    if (!breathGain) {
      const src = noiseSource(true); src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 260; f.Q.value = 1.1;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.5;
      const lfoG = ctx.createGain(); lfoG.gain.value = 130;
      lfo.connect(lfoG).connect(f.frequency);
      // амплитуда тоже дышит
      const amp = ctx.createGain(); amp.gain.value = 0.55;
      const alfo = ctx.createOscillator(); alfo.frequency.value = 0.5;
      const alfoG = ctx.createGain(); alfoG.gain.value = 0.45;
      alfo.connect(alfoG).connect(amp.gain);
      breathGain = ctx.createGain(); breathGain.gain.value = 0;
      const bus = ctx.createGain(); bus.gain.value = 1;
      out(bus, 0.4);
      src.connect(f).connect(amp).connect(breathGain).connect(bus);
      src.start(); lfo.start(); alfo.start();
    }
    breathGain.gain.setTargetAtTime(level * 0.2, ctx.currentTime, 0.3);
  },

  // --- события ---------------------------------------------------------
  // Ключ: связка металла, а не писк. Негармоничные обертоны + звяк.
  keyPickup() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.value = 1;
    out(g, 0.7);
    for (let n = 0; n < 3; n++) {
      const at = t + n * 0.045 + Math.random() * 0.02;
      const base = 1500 + Math.random() * 900;
      [1, 2.41, 3.83].forEach((mult, i) => {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = base * mult;
        const og = ctx.createGain();
        const peak = 0.05 / (i + 1.6);
        og.gain.setValueAtTime(0.0001, at);
        og.gain.exponentialRampToValueAtTime(peak, at + 0.005);
        og.gain.exponentialRampToValueAtTime(0.0001, at + 0.5 + i * 0.2);
        o.connect(og).connect(g);
        o.start(at); o.stop(at + 1);
      });
    }
  },

  // Замок: тяжёлый механический лязг с эхом по дому.
  doorUnlock() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.value = 1;
    out(g, 0.95);
    // проворот механизма
    for (let i = 0; i < 4; i++) {
      const at = t + i * 0.055;
      const src = noiseSource();
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1800 + Math.random() * 1400; f.Q.value = 12;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.07, at);
      ng.gain.exponentialRampToValueAtTime(0.0005, at + 0.06);
      src.connect(f).connect(ng).connect(g);
      src.start(at, Math.random()); src.stop(at + 0.08);
    }
    // финальный удар засова
    const at = t + 0.26;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, at);
    o.frequency.exponentialRampToValueAtTime(55, at + 0.14);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.3, at);
    og.gain.exponentialRampToValueAtTime(0.0005, at + 0.35);
    o.connect(og).connect(g);
    o.start(at); o.stop(at + 0.4);
    const src = noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 3;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.18, at);
    ng.gain.exponentialRampToValueAtTime(0.0005, at + 0.2);
    src.connect(f).connect(ng).connect(g);
    src.start(at, Math.random()); src.stop(at + 0.25);
  },

  creak() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.value = 1;
    out(g, 0.5);
    // дерево скрипит «рывками» — модулируем амплитуду быстрым дребезгом
    const base = 260 + Math.random() * 240;
    const src = noiseSource(true); src.loop = true;
    src.playbackRate.value = 0.6 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 11;
    f.frequency.setValueAtTime(base, t);
    f.frequency.linearRampToValueAtTime(base * (1.45 + Math.random() * 0.4), t + 0.2);
    f.frequency.linearRampToValueAtTime(base * 0.95, t + 0.4);
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0.0001, t);
    vg.gain.exponentialRampToValueAtTime(0.13, t + 0.03);
    vg.gain.exponentialRampToValueAtTime(0.0005, t + 0.42);
    // дребезг
    const jit = ctx.createOscillator(); jit.type = 'square';
    jit.frequency.value = 24 + Math.random() * 26;
    const jitG = ctx.createGain(); jitG.gain.value = 0.35;
    jit.connect(jitG).connect(vg.gain);
    src.connect(f).connect(vg).connect(g);
    src.start(t); src.stop(t + 0.45);
    jit.start(t); jit.stop(t + 0.45);
  },

  pant(exhausted) {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const dur = exhausted ? 0.5 : 0.36;
    const g = ctx.createGain(); g.gain.value = 1;
    out(g, 0.3);
    const src = noiseSource(true);
    src.playbackRate.value = 0.7 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.5;
    f.frequency.setValueAtTime(430, t);
    f.frequency.linearRampToValueAtTime(880, t + dur * 0.4);
    f.frequency.linearRampToValueAtTime(390, t + dur);
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0.0001, t);
    vg.gain.linearRampToValueAtTime(exhausted ? 0.19 : 0.1, t + dur * 0.35);
    vg.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(f).connect(vg).connect(g);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  },

  wardrobe() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.value = 1;
    out(g, 0.45);
    const src = noiseSource(true); src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 5;
    f.frequency.setValueAtTime(280, t);
    f.frequency.exponentialRampToValueAtTime(850, t + 0.3);
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0.1, t);
    vg.gain.exponentialRampToValueAtTime(0.0005, t + 0.38);
    src.connect(f).connect(vg).connect(g);
    src.start(t); src.stop(t + 0.4);
    // глухой стук створки
    const at = t + 0.3;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(110, at);
    o.frequency.exponentialRampToValueAtTime(48, at + 0.1);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.16, at);
    og.gain.exponentialRampToValueAtTime(0.0005, at + 0.2);
    o.connect(og).connect(g);
    o.start(at); o.stop(at + 0.25);
  },

  // Скример. Живой крик — это не «низкая пила», а глотка: гортанный источник
  // с дрожью, три форманты сверху, жёсткий клиппинг и шумовой выдох.
  scare(big, who) {
    ensureCtx();
    if (!ctx) return;
    // если положили настоящую запись — играем её
    if (playClip(who === 'watcher' ? 'scream_watcher' : 'scream_listener', big ? 1 : 0.7, 0.55)) return;
    if (muted) return;

    const t = ctx.currentTime;
    const dur = big ? 1.5 : 0.9;
    const g = ctx.createGain(); g.gain.value = 1;
    out(g, 0.75);

    // дисторшн: без него любой синтез звучит «чисто» и не пугает
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortion(big ? 55 : 30);
    shaper.oversample = '4x';
    const post = ctx.createBiquadFilter();
    post.type = 'lowpass';
    post.frequency.setValueAtTime(5200, t);
    post.frequency.exponentialRampToValueAtTime(700, t + dur);
    shaper.connect(post).connect(g);

    // --- источник: гортань. Пила с падающей высотой + неровная дрожь ---
    const f0 = who === 'watcher' ? 210 : 145;
    const src = ctx.createGain(); src.gain.value = 0.5;
    for (const det of [1, 1.008, 0.994]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * det * 1.35, t);
      o.frequency.exponentialRampToValueAtTime(f0 * det * 1.9, t + 0.09);  // рывок вверх
      o.frequency.exponentialRampToValueAtTime(f0 * det * 0.55, t + dur);
      // дрожь голоса
      const vib = ctx.createOscillator();
      vib.type = 'triangle';
      vib.frequency.value = 17 + Math.random() * 12;
      const vibAmt = ctx.createGain(); vibAmt.gain.value = f0 * 0.13;
      vib.connect(vibAmt).connect(o.frequency);
      o.connect(src);
      o.start(t); o.stop(t + dur + 0.2);
      vib.start(t); vib.stop(t + dur + 0.2);
    }
    // хрип: субгармоника на пол-октавы ниже даёт «сорванный» голос
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.setValueAtTime(f0 * 0.5, t);
    sub.frequency.exponentialRampToValueAtTime(f0 * 0.28, t + dur);
    const subG = ctx.createGain(); subG.gain.value = 0.22;
    sub.connect(subG).connect(src);
    sub.start(t); sub.stop(t + dur + 0.2);

    // огибающая крика: мгновенная атака, срыв в конце
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(big ? 0.85 : 0.5, t + 0.02);
    env.gain.setValueAtTime(big ? 0.85 : 0.5, t + dur * 0.55);
    env.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(env);

    // --- форманты: три резонанса, из них и складывается «голос» ---
    const FORMANTS = who === 'watcher' ? [[720, 9], [1750, 12], [3400, 9]]
                                       : [[540, 8], [1180, 11], [2650, 8]];
    for (const [fr, q] of FORMANTS) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = q;
      bp.frequency.setValueAtTime(fr * 1.15, t);
      bp.frequency.exponentialRampToValueAtTime(fr * 0.72, t + dur);
      const fg = ctx.createGain(); fg.gain.value = 0.5;
      env.connect(bp).connect(fg).connect(shaper);
    }
    // немного прямого сигнала, чтобы остался «корпус» голоса
    const direct = ctx.createGain(); direct.gain.value = 0.35;
    env.connect(direct).connect(shaper);

    // --- выдох: шум сквозь зубы, поверх крика ---
    const ns = noiseSource();
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass'; nf.Q.value = 0.7;
    nf.frequency.setValueAtTime(2600, t);
    nf.frequency.exponentialRampToValueAtTime(320, t + dur);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(big ? 0.4 : 0.24, t);
    ng.gain.exponentialRampToValueAtTime(0.0005, t + dur * 0.9);
    ns.connect(nf).connect(ng).connect(g);
    ns.start(t); ns.stop(t + dur + 0.1);

    // --- удар в самом начале: он делает скример «физическим» ---
    const imp = ctx.createOscillator();
    imp.type = 'sine';
    imp.frequency.setValueAtTime(90, t);
    imp.frequency.exponentialRampToValueAtTime(28, t + 0.22);
    const impG = ctx.createGain();
    impG.gain.setValueAtTime(big ? 0.7 : 0.4, t);
    impG.gain.exponentialRampToValueAtTime(0.0005, t + 0.3);
    imp.connect(impG).connect(g);
    imp.start(t); imp.stop(t + 0.35);
  },

  // Гром: далёкий раскат, который накрывает дом.
  thunder() {
    if (!ctx || muted) return;
    if (playClip('thunder', 0.9, 0.7)) return;
    const t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.value = 1;
    out(g, 0.9);
    const src = noiseSource(true); src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 2.6);
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0.0001, t);
    vg.gain.exponentialRampToValueAtTime(0.42, t + 0.12);
    // раскат неровный — два «переката» внутри затухания
    vg.gain.exponentialRampToValueAtTime(0.16, t + 0.7);
    vg.gain.exponentialRampToValueAtTime(0.3, t + 1.1);
    vg.gain.exponentialRampToValueAtTime(0.0005, t + 2.8);
    src.connect(lp).connect(vg).connect(g);
    src.start(t); src.stop(t + 3);
  },

  // Скрип где-то далеко — дом живёт сам (модификатор «сквозняк»).
  creakDistant() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.value = 0.45;
    out(g, 1.1);
    const src = noiseSource(true); src.loop = true;
    src.playbackRate.value = 0.4 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 10;
    const base = 160 + Math.random() * 180;
    f.frequency.setValueAtTime(base, t);
    f.frequency.linearRampToValueAtTime(base * 1.5, t + 0.9);
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0.0001, t);
    vg.gain.linearRampToValueAtTime(0.07, t + 0.25);
    vg.gain.exponentialRampToValueAtTime(0.0005, t + 1.2);
    src.connect(f).connect(vg).connect(g);
    src.start(t); src.stop(t + 1.3);
  },

  win() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.value = 1;
    out(g, 0.95);
    // выдох облегчения: мажорная терция низко, с долгим хвостом
    [110, 138.6, 164.8, 220].forEach((fr, i) => {
      const at = t + i * 0.14;
      const o = ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = fr;
      const o2 = ctx.createOscillator();
      o2.type = 'sine'; o2.frequency.value = fr * 2.005;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, at);
      og.gain.exponentialRampToValueAtTime(0.085, at + 0.12);
      og.gain.exponentialRampToValueAtTime(0.0005, at + 2.2);
      o.connect(og); o2.connect(og); og.connect(g);
      o.start(at); o.stop(at + 2.4);
      o2.start(at); o2.stop(at + 2.4);
    });
  },
};

// Кривая мягкого клиппинга: «грязь», без которой синтез звучит стерильно.
function makeDistortion(amount) {
  const n = 8192;
  const curve = new Float32Array(n);
  const k = amount;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function thump(power, intensity) {
  const t = ctx.currentTime;
  const g = ctx.createGain(); g.gain.value = 1;
  out(g, 0.12);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(62, t);
  o.frequency.exponentialRampToValueAtTime(28, t + 0.13);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.3 * power * intensity, t);
  og.gain.exponentialRampToValueAtTime(0.0005, t + 0.16);
  o.connect(og).connect(g);
  o.start(t); o.stop(t + 0.2);
  // «телесный» щелчок клапана — делает удар живым, а не синусом
  const src = noiseSource(true);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 220;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.06 * power * intensity, t);
  ng.gain.exponentialRampToValueAtTime(0.0005, t + 0.07);
  src.connect(f).connect(ng).connect(g);
  src.start(t, Math.random()); src.stop(t + 0.1);
}
