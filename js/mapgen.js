// Процедурный генератор дома: комнаты + коридоры, с гарантией связности.
import { mulberry32, CELL, bfsDistances } from './utils.js';

// Возвращает map: { w,h,cells, start, exit, keys[], wardrobes[], waypoints[], rooms[] }
export function generateMap(params) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const seed = (Math.random() * 0xFFFFFFFF) >>> 0;
    const map = tryGenerate(params, mulberry32(seed));
    if (map) { map.seed = seed; return map; }
  }
  throw new Error('mapgen: не удалось собрать связную карту');
}

function tryGenerate(p, rng) {
  const w = p.w, h = p.h;
  const cells = new Uint8Array(w * h).fill(CELL.WALL);
  const idx = (x, y) => y * w + x;

  // --- комнаты ---
  const targetRooms = Math.max(6, Math.floor((w * h) / 52));
  const rooms = [];
  for (let tries = 0; tries < 300 && rooms.length < targetRooms; tries++) {
    const rw = 4 + Math.floor(rng() * 5);           // 4..8
    const rh = 3 + Math.floor(rng() * 4);           // 3..6
    const rx = 1 + Math.floor(rng() * (w - rw - 2));
    const ry = 1 + Math.floor(rng() * (h - rh - 2));
    let ok = true;
    for (const r of rooms) {
      if (rx < r.x + r.w + 1 && rx + rw + 1 > r.x && ry < r.y + r.h + 1 && ry + rh + 1 > r.y) { ok = false; break; }
    }
    if (!ok) continue;
    rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: rx + Math.floor(rw / 2), cy: ry + Math.floor(rh / 2) });
    for (let y = ry; y < ry + rh; y++)
      for (let x = rx; x < rx + rw; x++) cells[idx(x, y)] = CELL.FLOOR;
  }
  if (rooms.length < 5) return null;

  // --- коридоры: каждую следующую комнату тянем к ближайшей уже связанной ---
  const connected = [rooms[0]];
  const rest = rooms.slice(1);
  while (rest.length) {
    let bi = 0, bj = 0, bd = Infinity;
    for (let i = 0; i < rest.length; i++)
      for (let j = 0; j < connected.length; j++) {
        const d = Math.abs(rest[i].cx - connected[j].cx) + Math.abs(rest[i].cy - connected[j].cy);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    const a = rest.splice(bi, 1)[0], b = connected[bj];
    const wide = rng() < 0.35 ? 1 : 0; // часть коридоров двойной ширины
    carveCorridor(cells, w, h, a.cx, a.cy, b.cx, b.cy, rng() < 0.5, wide);
    connected.push(a);
  }
  // пара лишних связей — циклы, чтобы было куда убегать
  for (let i = 0; i < 2 + Math.floor(rooms.length / 6); i++) {
    const a = rooms[Math.floor(rng() * rooms.length)];
    const b = rooms[Math.floor(rng() * rooms.length)];
    if (a !== b) carveCorridor(cells, w, h, a.cx, a.cy, b.cx, b.cy, rng() < 0.5, 0);
  }

  // --- колонны/мебель в больших комнатах (укрытия) ---
  for (const r of rooms) {
    if (r.w >= 6 && r.h >= 4 && rng() < 0.75) {
      const n = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        const px = r.x + 1 + Math.floor(rng() * (r.w - 2));
        const py = r.y + 1 + Math.floor(rng() * (r.h - 2));
        cells[idx(px, py)] = CELL.WALL;
        if (rng() < 0.4 && px + 1 < r.x + r.w - 1) cells[idx(px + 1, py)] = CELL.WALL;
      }
    }
  }

  const solidWall = (x, y) => cells[idx(x, y)] === CELL.WALL;

  // --- старт: комната, ближайшая к углу ---
  let startRoom = rooms[0], best = Infinity;
  for (const r of rooms) {
    const d = Math.min(
      r.cx + r.cy, (w - r.cx) + r.cy, r.cx + (h - r.cy), (w - r.cx) + (h - r.cy)
    );
    if (d < best) { best = d; startRoom = r; }
  }
  const start = { x: startRoom.cx + 0.5, y: startRoom.cy + 0.5 };
  if (solidWall(startRoom.cx, startRoom.cy)) return null;

  const distFromStart = bfsDistances({ w, h }, start.x, start.y, solidWall);
  const dAt = (x, y) => distFromStart[Math.floor(y) * w + Math.floor(x)];

  // --- выход: в самой дальней комнате, на клетке у стены ---
  let exitRoom = null, bestD = -1;
  for (const r of rooms) {
    const d = dAt(r.cx + 0.5, r.cy + 0.5);
    if (d > bestD) { bestD = d; exitRoom = r; }
  }
  if (!exitRoom || bestD < 10) return null;
  // клетка выхода — стена, примыкающая к полу дальней комнаты
  let exit = null;
  const edges = [];
  for (let x = exitRoom.x; x < exitRoom.x + exitRoom.w; x++) {
    edges.push({ wx: x, wy: exitRoom.y - 1, fx: x, fy: exitRoom.y });
    edges.push({ wx: x, wy: exitRoom.y + exitRoom.h, fx: x, fy: exitRoom.y + exitRoom.h - 1 });
  }
  for (let y = exitRoom.y; y < exitRoom.y + exitRoom.h; y++) {
    edges.push({ wx: exitRoom.x - 1, wy: y, fx: exitRoom.x, fy: y });
    edges.push({ wx: exitRoom.x + exitRoom.w, wy: y, fx: exitRoom.x + exitRoom.w - 1, fy: y });
  }
  shuffle(edges, rng);
  for (const e of edges) {
    if (e.wx <= 0 || e.wy <= 0 || e.wx >= w - 1 || e.wy >= h - 1) continue;
    if (cells[idx(e.wx, e.wy)] !== CELL.WALL) continue;
    if (dAt(e.fx + 0.5, e.fy + 0.5) < 0) continue;
    cells[idx(e.wx, e.wy)] = CELL.EXIT;
    exit = { x: e.wx + 0.5, y: e.wy + 0.5, fx: e.fx + 0.5, fy: e.fy + 0.5 };
    break;
  }
  if (!exit) return null;

  // --- ключи: по разным комнатам, не в стартовой, подальше ---
  const keyRooms = rooms
    .filter(r => r !== startRoom)
    .sort((a, b) => dAt(b.cx + 0.5, b.cy + 0.5) - dAt(a.cx + 0.5, a.cy + 0.5));
  if (keyRooms.length < p.keys) return null;
  const keys = [];
  // мешаем верхнюю половину, чтобы ключи не липли к выходу
  const pool = keyRooms.slice(0, Math.max(p.keys, Math.ceil(keyRooms.length * 0.75)));
  shuffle(pool, rng);
  for (const r of pool) {
    if (keys.length >= p.keys) break;
    const spots = [];
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++)
        if (cells[idx(x, y)] === CELL.FLOOR && dAt(x + 0.5, y + 0.5) > 6) spots.push({ x, y });
    if (!spots.length) continue;
    const s = spots[Math.floor(rng() * spots.length)];
    keys.push({ x: s.x + 0.5, y: s.y + 0.5, taken: false });
  }
  if (keys.length < p.keys) return null;

  // --- шкафы: у стен комнат, не на ключах, не в проходах ---
  const wardrobes = [];
  const wardrobeSet = new Set();
  const wrooms = rooms.slice();
  shuffle(wrooms, rng);
  outer:
  for (let pass = 0; pass < 3; pass++) {
    for (const r of wrooms) {
      if (wardrobes.length >= p.wardrobes) break outer;
      const spots = [];
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) {
          if (cells[idx(x, y)] !== CELL.FLOOR) continue;
          const nWall = (solidWall(x - 1, y) ? 1 : 0) + (solidWall(x + 1, y) ? 1 : 0) +
                        (solidWall(x, y - 1) ? 1 : 0) + (solidWall(x, y + 1) ? 1 : 0);
          if (nWall < 1 || nWall > 2) continue;
          if (keys.some(k => Math.floor(k.x) === x && Math.floor(k.y) === y)) continue;
          if (Math.floor(start.x) === x && Math.floor(start.y) === y) continue;
          if (wardrobeSet.has(y * w + x)) continue;
          spots.push({ x, y });
        }
      if (!spots.length) continue;
      const s = spots[Math.floor(rng() * spots.length)];
      wardrobeSet.add(s.y * w + s.x);
      wardrobes.push({ x: s.x + 0.5, y: s.y + 0.5, traitor: false, used: false, open: false });
    }
  }
  if (wardrobes.length < Math.min(4, p.wardrobes)) return null;

  // предатель
  if (p.traitor || (p.traitorChance && rng() < p.traitorChance)) {
    const candidates = wardrobes.filter(wd => dAt(wd.x, wd.y) > 8);
    const t = candidates.length ? candidates[Math.floor(rng() * candidates.length)] : wardrobes[wardrobes.length - 1];
    t.traitor = true;
  }

  // --- финальная проверка связности с учётом шкафов как препятствий ---
  const solidFull = (x, y) => {
    const c = cells[idx(x, y)];
    if (c === CELL.WALL || c === CELL.EXIT) return true;
    return wardrobeSet.has(y * w + x);
  };
  const dist2 = bfsDistances({ w, h }, start.x, start.y, solidFull);
  const reach = (x, y) => dist2[Math.floor(y) * w + Math.floor(x)] >= 0;
  for (const k of keys) if (!reach(k.x, k.y)) return null;
  if (!reach(exit.fx, exit.fy)) return null;
  for (const wd of wardrobes) {
    const cx = Math.floor(wd.x), cy = Math.floor(wd.y);
    const adj = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx2, dy2]) => {
      const nx = cx + dx2, ny = cy + dy2;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return false;
      return cells[idx(nx, ny)] === CELL.FLOOR && !wardrobeSet.has(ny * w + nx) && dist2[ny * w + nx] >= 0;
    });
    if (!adj) return null;
  }

  // --- скрипучие половицы: приоритет узким проходам, там их не обойти ---
  const creaks = [];
  const creakSet = new Set();
  const inRoom = (x, y) => rooms.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  const corridorSpots = [], roomSpots = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (cells[idx(x, y)] !== CELL.FLOOR) continue;
      if (wardrobeSet.has(y * w + x)) continue;
      if (keys.some(k => Math.floor(k.x) === x && Math.floor(k.y) === y)) continue;
      // не в стартовой комнате — нечестно скрипеть сразу под ногами
      if (Math.abs(x - start.x) < 3 && Math.abs(y - start.y) < 3) continue;
      (inRoom(x, y) ? roomSpots : corridorSpots).push({ x, y });
    }
  }
  shuffle(corridorSpots, rng);
  shuffle(roomSpots, rng);
  for (const s of corridorSpots.concat(roomSpots)) {
    if (creaks.length >= p.creaks) break;
    // не лепим вплотную друг к другу
    if (creaks.some(c => Math.abs(c.x - s.x - 0.5) < 2 && Math.abs(c.y - s.y - 0.5) < 2)) continue;
    creakSet.add(s.y * w + s.x);
    creaks.push({ x: s.x + 0.5, y: s.y + 0.5, flash: 0 });
  }

  // --- маршруты монстров: центры комнат ---
  const waypoints = rooms
    .map(r => ({ x: r.cx + 0.5, y: r.cy + 0.5 }))
    .filter(pt => !solidFull(Math.floor(pt.x), Math.floor(pt.y)));
  if (waypoints.length < 5) return null;

  return { w, h, cells, start, exit, keys, wardrobes, wardrobeSet, creaks, creakSet, waypoints, rooms };
}

function carveCorridor(cells, w, h, x0, y0, x1, y1, xFirst, wide) {
  const idx = (x, y) => y * w + x;
  const carve = (x, y) => {
    if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
      cells[idx(x, y)] = CELL.FLOOR;
      if (wide && y + 1 < h - 1) cells[idx(x, y + 1)] = CELL.FLOOR;
    }
  };
  let x = x0, y = y0;
  if (xFirst) {
    while (x !== x1) { carve(x, y); x += Math.sign(x1 - x); }
    while (y !== y1) { carve(x, y); y += Math.sign(y1 - y); }
  } else {
    while (y !== y1) { carve(x, y); y += Math.sign(y1 - y); }
    while (x !== x1) { carve(x, y); x += Math.sign(x1 - x); }
  }
  carve(x1, y1);
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
