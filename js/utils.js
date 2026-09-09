// Математика, RNG, лучи и поиск пути по сетке.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

export function normAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// --- сетка ---------------------------------------------------------------
// map: { w, h, cells:Uint8Array } ; 0 пол, 1 стена, 2 выход
export const CELL = { FLOOR: 0, WALL: 1, EXIT: 2 };

export function cellAt(map, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= map.w || cy >= map.h) return CELL.WALL;
  return map.cells[cy * map.w + cx];
}

// Сколько клеток стен пересекает отрезок (для затухания звука сквозь стены).
export function wallsBetween(map, x0, y0, x1, y1) {
  const steps = Math.ceil(dist(x0, y0, x1, y1) * 3);
  if (steps === 0) return 0;
  let count = 0, lastKey = -1;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const cx = Math.floor(lerp(x0, x1, t));
    const cy = Math.floor(lerp(y0, y1, t));
    const key = cy * 4096 + cx;
    if (key !== lastKey) {
      lastKey = key;
      if (cellAt(map, cx, cy) === CELL.WALL) count++;
      if (count >= 6) return count;
    }
  }
  return count;
}

export function losClear(map, x0, y0, x1, y1) {
  return wallsBetween(map, x0, y0, x1, y1) === 0;
}

// Длина луча до стены (для полигона видимости).
export function castRay(map, x, y, ang, maxDist) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const step = 0.08;
  let d = 0;
  while (d < maxDist) {
    d += step;
    const px = x + dx * d, py = y + dy * d;
    if (cellAt(map, Math.floor(px), Math.floor(py)) === CELL.WALL) return d;
  }
  return maxDist;
}

// BFS-путь по клеткам. solidFn(cx,cy) -> true если непроходимо.
// Возвращает массив [{x,y}] центров клеток (без стартовой) или null.
export function bfsPath(map, sx, sy, tx, ty, solidFn) {
  const w = map.w, h = map.h;
  const scx = clamp(Math.floor(sx), 0, w - 1), scy = clamp(Math.floor(sy), 0, h - 1);
  const tcx = clamp(Math.floor(tx), 0, w - 1), tcy = clamp(Math.floor(ty), 0, h - 1);
  if (scx === tcx && scy === tcy) return [];
  const prev = new Int32Array(w * h).fill(-2);
  const queue = new Int32Array(w * h);
  let qh = 0, qt = 0;
  const sIdx = scy * w + scx;
  prev[sIdx] = -1; queue[qt++] = sIdx;
  const tIdx = tcy * w + tcx;
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
  let found = false;
  while (qh < qt) {
    const cur = queue[qh++];
    if (cur === tIdx) { found = true; break; }
    const cx = cur % w, cy = (cur / w) | 0;
    for (let i = 0; i < 4; i++) {
      const nx = cx + DX[i], ny = cy + DY[i];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (prev[ni] !== -2) continue;
      if (solidFn(nx, ny) && ni !== tIdx) { prev[ni] = -3; continue; }
      prev[ni] = cur; queue[qt++] = ni;
    }
  }
  if (!found) return null;
  const path = [];
  let cur = tIdx;
  while (cur !== sIdx) {
    path.push({ x: (cur % w) + 0.5, y: ((cur / w) | 0) + 0.5 });
    cur = prev[cur];
    if (cur < 0) return null;
  }
  path.reverse();
  return path;
}

// BFS-расстояния от точки до всех клеток (для расстановки ключей/выхода).
export function bfsDistances(map, sx, sy, solidFn) {
  const w = map.w, h = map.h;
  const distArr = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let qh = 0, qt = 0;
  const sIdx = Math.floor(sy) * w + Math.floor(sx);
  distArr[sIdx] = 0; queue[qt++] = sIdx;
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
  while (qh < qt) {
    const cur = queue[qh++];
    const cx = cur % w, cy = (cur / w) | 0, d = distArr[cur];
    for (let i = 0; i < 4; i++) {
      const nx = cx + DX[i], ny = cy + DY[i];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (distArr[ni] !== -1 || solidFn(nx, ny)) continue;
      distArr[ni] = d + 1; queue[qt++] = ni;
    }
  }
  return distArr;
}

// Движение круга с коллизией о сетку (скольжение вдоль стен).
export function moveCircle(ent, dx, dy, solidFn) {
  const r = ent.r;
  ent.x += dx;
  resolveAxis(ent, solidFn, true, r);
  ent.y += dy;
  resolveAxis(ent, solidFn, false, r);
}

function resolveAxis(ent, solidFn, isX, r) {
  const minX = Math.floor(ent.x - r), maxX = Math.floor(ent.x + r);
  const minY = Math.floor(ent.y - r), maxY = Math.floor(ent.y + r);
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      if (!solidFn(cx, cy)) continue;
      const nx = clamp(ent.x, cx, cx + 1);
      const ny = clamp(ent.y, cy, cy + 1);
      const ddx = ent.x - nx, ddy = ent.y - ny;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 >= r * r || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const push = r - d;
      if (isX) ent.x += (ddx / d) * push;
      else ent.y += (ddy / d) * push;
    }
  }
}
