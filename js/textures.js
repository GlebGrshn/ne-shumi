// Процедурные текстуры: считаются один раз при загрузке в offscreen-canvas.
// Ноль файлов, ноль лицензий. Всё бесшовно тайлится по сетке.
import { mulberry32 } from './utils.js';

export const TS = 128;      // пикселей текстуры на одну клетку
const PAT = TS * 2;         // паттерн 2×2 клетки — меньше видно повтор

// Бесшовный value-noise: сетка freq×freq с заворотом по краям.
function noise2d(freq, rng) {
  const g = new Float32Array(freq * freq);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return (x, y) => {
    const fx = x * freq, fy = y * freq;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const x0 = ((ix % freq) + freq) % freq, y0 = ((iy % freq) + freq) % freq;
    const x1 = (x0 + 1) % freq, y1 = (y0 + 1) % freq;
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = g[y0 * freq + x0], b = g[y0 * freq + x1];
    const c = g[y1 * freq + x0], d = g[y1 * freq + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

function fbm(octaves, baseFreq, rng) {
  const layers = [];
  let f = baseFreq, amp = 1, total = 0;
  for (let i = 0; i < octaves; i++) {
    layers.push({ n: noise2d(f, rng), amp });
    total += amp; f *= 2; amp *= 0.5;
  }
  return (x, y) => {
    let s = 0;
    for (const l of layers) s += l.n(x, y) * l.amp;
    return s / total;
  };
}

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const mix = (a, b, t) => a + (b - a) * t;
function rgb(r, g, b) { return `rgb(${r | 0},${g | 0},${b | 0})`; }

// ---------------------------------------------------------------- пол: доски
function buildFloor(seed, tint) {
  const rng = mulberry32(seed);
  const cv = newCanvas(PAT, PAT);
  const ctx = cv.getContext('2d');
  const grain = fbm(4, 4, rng);
  const dirt = fbm(4, 3, mulberry32(seed + 77));

  const img = ctx.createImageData(PAT, PAT);
  const d = img.data;
  const boardH = TS / 2;                    // 2 доски на клетку
  const rows = PAT / boardH;
  // сдвиг стыков и оттенок каждой доски
  const rowShift = [], rowTint = [];
  for (let r = 0; r < rows; r++) {
    rowShift.push(Math.floor(rng() * PAT));
    rowTint.push(0.82 + rng() * 0.36);
  }

  for (let y = 0; y < PAT; y++) {
    const row = Math.floor(y / boardH);
    const inRow = y - row * boardH;
    for (let x = 0; x < PAT; x++) {
      // волокно вдоль доски: растянуто по X
      const g = grain(x / PAT * 0.55, (y / PAT) * 3.2);
      let v = 0.5 + (g - 0.5) * 0.7;
      v *= rowTint[row];

      // тёмный шов между досками
      const edge = Math.min(inRow, boardH - 1 - inRow);
      if (edge < 1.5) v *= 0.42 + edge * 0.2;

      // поперечные стыки досок
      const seam = (x + rowShift[row]) % (PAT / 2 | 0);
      if (seam < 2) v *= 0.5;

      // грязь и потёртости
      const dv = dirt(x / PAT, y / PAT);
      v *= mix(0.72, 1.06, dv);

      const i = (y * PAT + x) * 4;
      d[i]     = tint[0] * v;
      d[i + 1] = tint[1] * v;
      d[i + 2] = tint[2] * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// ------------------------------------------------------- пол подвала: бетон
function buildConcrete(seed, tint) {
  const rng = mulberry32(seed);
  const cv = newCanvas(PAT, PAT);
  const ctx = cv.getContext('2d');
  const rough = fbm(5, 8, rng);
  const stain = fbm(3, 2, mulberry32(seed + 31));

  const img = ctx.createImageData(PAT, PAT);
  const d = img.data;
  for (let y = 0; y < PAT; y++) {
    for (let x = 0; x < PAT; x++) {
      const r = rough(x / PAT, y / PAT);
      const s = stain(x / PAT, y / PAT);
      let v = mix(0.72, 1.12, r) * mix(0.62, 1.05, s);
      const i = (y * PAT + x) * 4;
      d[i]     = tint[0] * v;
      d[i + 1] = tint[1] * v;
      d[i + 2] = tint[2] * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // редкие трещины
  ctx.strokeStyle = 'rgba(0,0,0,0.34)';
  for (let i = 0; i < 5; i++) {
    ctx.lineWidth = 0.6 + rng();
    ctx.beginPath();
    let x = rng() * PAT, y = rng() * PAT, a = rng() * Math.PI * 2;
    ctx.moveTo(x, y);
    for (let s = 0; s < 14; s++) {
      a += (rng() - 0.5) * 1.1;
      x += Math.cos(a) * 9; y += Math.sin(a) * 9;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return cv;
}

// ------------------------------------------------------ стена: штукатурка
function buildWall(seed, tint) {
  const rng = mulberry32(seed);
  const cv = newCanvas(PAT, PAT);
  const ctx = cv.getContext('2d');
  const coarse = fbm(4, 3, rng);
  const fine = fbm(3, 12, mulberry32(seed + 5));

  const img = ctx.createImageData(PAT, PAT);
  const d = img.data;
  for (let y = 0; y < PAT; y++) {
    for (let x = 0; x < PAT; x++) {
      const c = coarse(x / PAT, y / PAT), f = fine(x / PAT, y / PAT);
      const v = mix(0.74, 1.14, c) * mix(0.93, 1.07, f);
      const i = (y * PAT + x) * 4;
      d[i]     = tint[0] * v;
      d[i + 1] = tint[1] * v;
      d[i + 2] = tint[2] * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // осыпавшаяся штукатурка: тёмные проплешины
  for (let i = 0; i < 7; i++) {
    const x = rng() * PAT, y = rng() * PAT, r = 4 + rng() * 13;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,0.3)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // трещины
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  for (let i = 0; i < 4; i++) {
    ctx.lineWidth = 0.7 + rng() * 0.9;
    ctx.beginPath();
    let x = rng() * PAT, y = rng() * PAT, a = rng() * Math.PI * 2;
    ctx.moveTo(x, y);
    for (let s = 0; s < 10; s++) {
      a += (rng() - 0.5) * 1.3;
      x += Math.cos(a) * 8; y += Math.sin(a) * 8;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return cv;
}

// ------------------------------------------------------------ дерево шкафа
function buildWood(seed, tint) {
  const rng = mulberry32(seed);
  const cv = newCanvas(TS, TS);
  const ctx = cv.getContext('2d');
  const grain = fbm(4, 5, rng);
  const img = ctx.createImageData(TS, TS);
  const d = img.data;
  for (let y = 0; y < TS; y++) {
    for (let x = 0; x < TS; x++) {
      // вертикальное волокно
      const g = grain((x / TS) * 2.6, (y / TS) * 0.5);
      const rings = 0.5 + 0.5 * Math.sin((x / TS) * 26 + g * 7);
      const v = mix(0.76, 1.1, g) * mix(0.9, 1.05, rings);
      const i = (y * TS + x) * 4;
      d[i]     = tint[0] * v;
      d[i + 1] = tint[1] * v;
      d[i + 2] = tint[2] * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// --------------------------------------------------------------------- API
// ------------------------------------------------------- дверь выхода
// Тяжёлая дощатая дверь с железными полосами. Рисуется целиком в текстуру,
// чтобы в кадре не считалась каждый раз.
function buildDoor(seed) {
  const rng = mulberry32(seed);
  const cv = newCanvas(TS, TS);
  const ctx = cv.getContext('2d');
  const grain = fbm(4, 6, rng);

  // дверное полотно: вертикальные доски
  const img = ctx.createImageData(TS, TS);
  const d = img.data;
  const plankW = TS / 4;
  for (let y = 0; y < TS; y++) {
    for (let x = 0; x < TS; x++) {
      const pl = Math.floor(x / plankW);
      const inPl = x - pl * plankW;
      const g = grain((x / TS) * 1.2, (y / TS) * 0.35);
      let v = mix(0.62, 1.0, g) * (0.86 + ((pl * 37) % 5) * 0.05);
      // тёмный шов между досками
      const edge = Math.min(inPl, plankW - 1 - inPl);
      if (edge < 1.6) v *= 0.4 + edge * 0.22;
      // рамка проёма по периметру
      const br = Math.min(x, y, TS - 1 - x, TS - 1 - y);
      if (br < 5) v *= 0.42 + br * 0.1;
      const i = (y * TS + x) * 4;
      d[i] = 78 * v; d[i + 1] = 54 * v; d[i + 2] = 34 * v; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // железные полосы поперёк
  for (const fy of [0.22, 0.72]) {
    const y = TS * fy;
    const g = ctx.createLinearGradient(0, y - TS * 0.05, 0, y + TS * 0.05);
    g.addColorStop(0, '#4a4550');
    g.addColorStop(0.4, '#6b6472');
    g.addColorStop(1, '#33303a');
    ctx.fillStyle = g;
    ctx.fillRect(TS * 0.06, y - TS * 0.045, TS * 0.88, TS * 0.09);
    // заклёпки
    ctx.fillStyle = '#87808f';
    for (const fx of [0.13, 0.37, 0.63, 0.87]) {
      ctx.beginPath();
      ctx.arc(TS * fx, y, TS * 0.018, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return cv;
}

export function buildTextures() {
  // стены заметно светлее пола — иначе в темноте комната читается как каша
  const t = {
    floor: buildFloor(1337, [62, 56, 88]),
    floorAlt: buildFloor(90210, [56, 51, 80]),
    concrete: buildConcrete(4242, [62, 59, 74]),
    wall: buildWall(777, [104, 97, 140]),
    wood: buildWood(2024, [118, 84, 51]),
    door: buildDoor(555),
  };
  return t;
}

// Паттерн, выровненный по мировой сетке: 128 px текстуры = 1 клетка.
export function alignPattern(ctx, canvas, originX, originY, S) {
  const pat = ctx.createPattern(canvas, 'repeat');
  const k = S / TS;
  if (pat.setTransform) {
    pat.setTransform(new DOMMatrix([k, 0, 0, k, originX, originY]));
  }
  return pat;
}
