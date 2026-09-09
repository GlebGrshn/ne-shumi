// Рендер: пол/стены, сущности, темнота с «памятью» карты,
// полигон видимости фонарика, луч Смотрителя, виньетка и пульс сердца.
import { CELL, cellAt, castRay, losClear, dist, normAngle, clamp, lerp } from './utils.js';
import { VISION } from './config.js';
import { buildTextures, alignPattern, TS } from './textures.js';
import { Sprites } from './sprites.js';

// Спрайты нарисованы с фиксированных ракурсов, поэтому НЕ вращаем —
// вид выбирается по направлению. Рисуем вертикально, с покачиванием на ходу.
function drawSprite(ctx, spr, x, y, size, opts = {}) {
  if (!spr) return false;
  const { bob = 0, flip = false, alpha = 1, lean = 0 } = opts;
  const scale = size / spr.height;
  const w = spr.width * scale, h = spr.height * scale;
  ctx.save();
  ctx.translate(x, y + bob);
  if (lean) ctx.rotate(lean);
  if (flip) ctx.scale(-1, 1);
  if (alpha !== 1) ctx.globalAlpha = alpha;
  // тень под ногами — «прибивает» фигуру к полу
  ctx.globalAlpha *= 1;
  ctx.drawImage(spr, -w / 2, -h * 0.62, w, h);
  ctx.restore();
  return true;
}

// Поза монстра по состоянию: концепты дали отдельные кадры на каждое.
// pre = 'L' (Слушатель) | 'W' (Смотритель)
function monsterSprite(m, pre) {
  const g = n => Sprites.get(pre + '_' + n);
  let img = null;
  switch (m.state) {
    case 'chase':
      img = g('attack') || g('alert'); break;
    case 'open':
      img = g('alert') || g('attack'); break;
    case 'investigate':
      img = pre === 'L' ? (g('move') || g('listen')) : (g('move') || g('track')); break;
    case 'search':
      img = pre === 'L' ? (g('listen') || g('turn')) : (g('notice') || g('track')); break;
  }
  if (img) return { img, flip: false };

  // патруль — направленный вид
  const dir = pre === 'W' ? (m.facing ?? m.dir) : m.dir;
  const d = Sprites.dirName(dir);
  if (d === 'front') return { img: g('front') || g('idle'), flip: false };
  if (d === 'back') return { img: g('back') || g('idle'), flip: false };
  const side = g('side') || g('idle');
  return { img: side, flip: d === 'left' };
}

function shadowBlob(ctx, x, y, S, strength = 0.4) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x, y + S * 0.12, S * 0.34, S * 0.16, 0, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(x, y + S * 0.12, 0, x, y + S * 0.12, S * 0.34);
  g.addColorStop(0, `rgba(0,0,0,${strength})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
}

export function createView(canvas) {
  const view = {
    canvas,
    ctx: canvas.getContext('2d'),
    dark: document.createElement('canvas'),
    tex: buildTextures(),
    W: 0, H: 0, S: 48, dpr: 1,
  };
  view.dctx = view.dark.getContext('2d');
  const resize = () => {
    view.dpr = Math.min(2, window.devicePixelRatio || 1);
    view.W = window.innerWidth; view.H = window.innerHeight;
    canvas.width = Math.max(1, Math.round(view.W * view.dpr));
    canvas.height = Math.max(1, Math.round(view.H * view.dpr));
    view.dark.width = canvas.width; view.dark.height = canvas.height;
    // Размер клетки. На вытянутом (телефонном) экране считаем от длинной
    // стороны, иначе освещённый круг занимает узкую полосу, а сверху и снизу
    // остаются чёрные поля. Ландшафт не трогаем — там баланс уже подобран.
    const minD = Math.min(view.W, view.H), maxD = Math.max(view.W, view.H);
    let s = minD / 12.5;
    if (view.H > view.W) s = Math.max(s, maxD / 15);
    view.S = clamp(s, 36, 110);
  };
  // страница может загрузиться до того, как контейнер получит размер,
  // поэтому проверяем габариты каждый кадр, а не только по событию
  view.checkResize = () => {
    if (view.W !== window.innerWidth || view.H !== window.innerHeight ||
        view.dpr !== Math.min(2, window.devicePixelRatio || 1)) resize();
  };
  window.addEventListener('resize', resize);
  resize();
  return view;
}

const COLORS = {
  floorA: '#26243a', floorB: '#232136',
  wall: '#413d5c', wallEdge: '#524d75', wallDark: '#2c2942',
  wardrobe: '#4d3b2a', wardrobeDoor: '#5d4834', wardrobeEdge: '#6d5137',
  key: '#e8c65a',
  exitLocked: '#5c2430', exitOpen: '#3f7a4d',
  player: '#9aa4c8',
  listener: '#cfc4b8', listenerDark: '#8d8478',
  watcher: '#37273f',
};

export function draw(game, view) {
  view.checkResize();
  const { ctx, dctx, W, H, S, dpr } = view;
  const p = game.player;
  const camX = p.x, camY = p.y;
  const w2sx = x => (x - camX) * S + W / 2;
  const w2sy = y => (y - camY) * S + H / 2;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#07060c';
  ctx.fillRect(0, 0, W, H);

  const map = game.map;
  if (!map) return;
  visionScale = game.params ? (game.params.visionScale || 1) : 1;

  const minCX = Math.max(0, Math.floor(camX - W / 2 / S) - 1);
  const maxCX = Math.min(map.w - 1, Math.ceil(camX + W / 2 / S) + 1);
  const minCY = Math.max(0, Math.floor(camY - H / 2 / S) - 1);
  const maxCY = Math.min(map.h - 1, Math.ceil(camY + H / 2 / S) + 1);

  // --- пол: один проход текстурным паттерном, выровненным по мировой сетке ---
  const originX = w2sx(0), originY = w2sy(0);
  const floorTex = game.basement ? view.tex.concrete : view.tex.floor;
  ctx.fillStyle = alignPattern(ctx, floorTex, originX, originY, S);
  ctx.beginPath();
  for (let cy = minCY; cy <= maxCY; cy++)
    for (let cx = minCX; cx <= maxCX; cx++)
      if (map.cells[cy * map.w + cx] === CELL.FLOOR)
        ctx.rect(w2sx(cx), w2sy(cy), S + 1, S + 1);
  ctx.fill();

  // --- стены: текстура + грани для псевдообъёма ---
  ctx.fillStyle = alignPattern(ctx, view.tex.wall, originX, originY, S);
  ctx.beginPath();
  for (let cy = minCY; cy <= maxCY; cy++)
    for (let cx = minCX; cx <= maxCX; cx++)
      if (map.cells[cy * map.w + cx] === CELL.WALL)
        ctx.rect(w2sx(cx), w2sy(cy), S + 1, S + 1);
  ctx.fill();

  for (let cy = minCY; cy <= maxCY; cy++) {
    for (let cx = minCX; cx <= maxCX; cx++) {
      const c = map.cells[cy * map.w + cx];
      const x = w2sx(cx), y = w2sy(cy);
      if (c === CELL.WALL) {
        if (cellAt(map, cx, cy + 1) !== CELL.WALL) {
          const g = ctx.createLinearGradient(0, y + S * 0.72, 0, y + S + 1);
          g.addColorStop(0, 'rgba(0,0,0,0)');
          g.addColorStop(1, 'rgba(0,0,0,0.55)');
          ctx.fillStyle = g;
          ctx.fillRect(x, y + S * 0.72, S + 1, S * 0.28 + 1);
        }
        if (cellAt(map, cx, cy - 1) !== CELL.WALL) {
          ctx.fillStyle = 'rgba(190,182,220,0.13)';
          ctx.fillRect(x, y, S + 1, S * 0.09);
        }
      } else if (c === CELL.EXIT) {
        drawExit(ctx, x, y, S, game.exitOpen, game.time, view);
      }
    }
  }

  // --- скрипучие половицы: видно только вблизи, в свете фонаря ---
  for (const cr of map.creaks) {
    const x = w2sx(cr.x - 0.5), y = w2sy(cr.y - 0.5);
    if (x < -S || x > W + S || y < -S || y > H + S) continue;
    drawCreak(ctx, x, y, S, cr, game.time);
  }

  // --- шкафы ---
  for (const wd of map.wardrobes) {
    const cx = Math.floor(wd.x), cy = Math.floor(wd.y);
    if (cx < minCX || cx > maxCX || cy < minCY || cy > maxCY) continue;
    drawWardrobe(ctx, w2sx(cx), w2sy(cy), S, wd, game, view);
  }

  // --- ключи ---
  for (const k of map.keys) {
    if (k.taken) continue;
    const x = w2sx(k.x), y = w2sy(k.y);
    if (x < -S || x > W + S || y < -S || y > H + S) continue;
    drawKey(ctx, x, y, S, game.time);
  }

  // --- монстры (рисуем только если реально видны игроку) ---
  for (const m of game.monsters) {
    if (!isVisibleToPlayer(game, m)) continue;
    if (m.kind === 'listener') drawListener(ctx, w2sx(m.x), w2sy(m.y), S, m, game.time);
    else drawWatcherBody(ctx, w2sx(m.x), w2sy(m.y), S, m);
  }

  // --- игрок ---
  if (!p.hidden) drawPlayer(ctx, W / 2, H / 2, S, p);

  // --- круги шума ---
  for (const rp of game.ripples) {
    ctx.beginPath();
    ctx.arc(w2sx(rp.x), w2sy(rp.y), rp.r * S, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(200,190,230,${rp.alpha * 0.35})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // === ТЕМНОТА =============================================================
  dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dctx.globalCompositeOperation = 'source-over';
  dctx.fillStyle = 'rgba(2,2,6,0.985)';
  dctx.fillRect(0, 0, W, H);

  // вспышка молнии: на долю секунды видно весь дом
  const flash = game.flashT > 0 ? Math.min(1, game.flashT / 0.5) : 0;
  if (flash > 0) {
    dctx.globalCompositeOperation = 'destination-out';
    // мерцание в два всплеска, как настоящий разряд
    const strobe = flash * (0.55 + 0.45 * Math.abs(Math.sin(game.time * 42)));
    dctx.fillStyle = `rgba(0,0,0,${strobe * 0.9})`;
    dctx.fillRect(0, 0, W, H);
  }

  // память карты: разведанные клетки чуть проступают
  dctx.globalCompositeOperation = 'destination-out';
  dctx.fillStyle = `rgba(0,0,0,${VISION.memoryAlpha})`;
  for (let cy = minCY; cy <= maxCY; cy++) {
    for (let cx = minCX; cx <= maxCX; cx++) {
      if (game.seen[cy * map.w + cx]) {
        dctx.fillRect(w2sx(cx) - 0.5, w2sy(cy) - 0.5, S + 1.5, S + 1.5);
      }
    }
  }

  // полигон видимости
  if (!p.hidden) {
    const pts = buildVisibility(game, p);
    const grad = dctx.createRadialGradient(W / 2, H / 2, S * 0.4, W / 2, H / 2, VISION.coneRange * visionScale * S);
    grad.addColorStop(0, 'rgba(0,0,0,0.99)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.9)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    dctx.fillStyle = grad;
    dctx.beginPath();
    dctx.moveTo(w2sx(pts[0].x), w2sy(pts[0].y));
    for (let i = 1; i < pts.length; i++) dctx.lineTo(w2sx(pts[i].x), w2sy(pts[i].y));
    dctx.closePath();
    dctx.fill();
  } else {
    // из шкафа видно чуть-чуть через щель
    const grad = dctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 2.2 * S);
    grad.addColorStop(0, 'rgba(0,0,0,0.7)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    dctx.fillStyle = grad;
    dctx.beginPath();
    dctx.arc(W / 2, H / 2, 2.2 * S, 0, Math.PI * 2);
    dctx.fill();
  }
  dctx.globalCompositeOperation = 'source-over';

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(view.dark, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // === ПОВЕРХ ТЕМНОТЫ ======================================================
  // луч Смотрителя светится в темноте — его видно издалека, это честно
  for (const m of game.monsters) {
    if (m.kind !== 'watcher') continue;
    drawWatcherBeam(ctx, game, m, w2sx, w2sy, S);
  }

  // подсветка ключей за рекламу — сквозь стены
  if (game.keyPingT > 0) {
    const pulse = 0.5 + 0.5 * Math.sin(game.time * 8);
    for (const k of map.keys) {
      if (k.taken) continue;
      const x = w2sx(k.x), y = w2sy(k.y);
      ctx.beginPath();
      ctx.arc(x, y, S * (0.4 + pulse * 0.25), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(232,198,90,${0.5 + pulse * 0.4})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      drawKey(ctx, x, y, S, game.time);
    }
  }

  // индикатор опасности у края экрана + стрелка к выходу
  drawEdgeIndicators(ctx, game, W, H, S);

  // виньетка + красный пульс сердца
  drawVignette(ctx, game, W, H);

  // скример
  if (game.scareT > 0) drawScare(ctx, game, W, H);
}

// --- видимость -------------------------------------------------------------
// Масштаб зрения: модификатор «темно» сажает батарейку фонаря.
let visionScale = 1;

function rangeAt(delta) {
  const edge = 0.35;
  const cone = VISION.coneRange * visionScale;
  const amb = VISION.ambient * (0.55 + visionScale * 0.45);
  if (delta < VISION.coneHalf) return cone;
  if (delta < VISION.coneHalf + edge) {
    const t = (delta - VISION.coneHalf) / edge;
    return lerp(cone, amb, t * t * (3 - 2 * t));
  }
  return amb;
}

function buildVisibility(game, p) {
  const N = 120;
  const pts = [];
  const map = game.map;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const maxR = rangeAt(Math.abs(normAngle(a - p.dir)));
    const d = Math.min(castRay(map, p.x, p.y, a, maxR + 0.4), maxR);
    pts.push({ x: p.x + Math.cos(a) * (d + 0.25), y: p.y + Math.sin(a) * (d + 0.25) });
    // отмечаем разведанные клетки
    for (let s = 0.5; s < d; s += 0.7) {
      const cx = Math.floor(p.x + Math.cos(a) * s), cy = Math.floor(p.y + Math.sin(a) * s);
      if (cx >= 0 && cy >= 0 && cx < map.w && cy < map.h) game.seen[cy * map.w + cx] = 1;
    }
    const ex = Math.floor(p.x + Math.cos(a) * d), ey = Math.floor(p.y + Math.sin(a) * d);
    if (ex >= 0 && ey >= 0 && ex < map.w && ey < map.h) game.seen[ey * map.w + ex] = 1;
  }
  return pts;
}

function isVisibleToPlayer(game, m) {
  const p = game.player;
  if (p.hidden) return dist(p.x, p.y, m.x, m.y) < 2.2 && losClear(game.map, p.x, p.y, m.x, m.y);
  const d = dist(p.x, p.y, m.x, m.y);
  const ang = Math.atan2(m.y - p.y, m.x - p.x);
  const allowed = rangeAt(Math.abs(normAngle(ang - p.dir)));
  return d < allowed + 0.3 && losClear(game.map, p.x, p.y, m.x, m.y);
}

// --- спрайты ----------------------------------------------------------------
function drawPlayer(ctx, x, y, S, p) {
  // спрайт, если ассеты загружены
  if (Sprites.ready) {
    const d = Sprites.dirName(p.dir);
    // идём «на камеру» — гоняем полноценный цикл; иначе направленный вид + покачивание
    let spr = null, flip = false;
    if (p.moving && d === 'front') {
      spr = Sprites.frame(p.running ? 'run' : 'walk', p.animFrame);
    }
    if (!spr) {
      spr = Sprites.get('idle_' + d);
      if (!spr && d === 'right') { spr = Sprites.get('idle_left'); flip = true; }
      if (!spr && d === 'left') { spr = Sprites.get('idle_right'); flip = true; }
    }
    if (spr) {
      const phase = p.animT || 0;
      const bob = p.moving ? Math.sin(phase * Math.PI) * S * (p.running ? 0.05 : 0.03) : 0;
      const lean = p.moving && d !== 'front' ? Math.sin(phase * Math.PI) * 0.03 : 0;
      shadowBlob(ctx, x, y, S, 0.45);
      drawSprite(ctx, spr, x, y, S * 1.55, { bob, flip, lean });
      // пятно фонаря — читается, куда он смотрит
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const gx = x + Math.cos(p.dir) * S * 0.42, gy = y + Math.sin(p.dir) * S * 0.42;
      const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, S * 0.3);
      g.addColorStop(0, 'rgba(255,225,160,0.4)');
      g.addColorStop(1, 'rgba(255,225,160,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(gx, gy, S * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      return;
    }
  }
  const r = S * 0.30;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(p.dir);
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.05, r * 0.85, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#1b1a26';
  ctx.fill();
  ctx.strokeStyle = COLORS.player;
  ctx.lineWidth = 2;
  ctx.stroke();
  // руки с фонариком вперёд
  ctx.fillStyle = COLORS.player;
  ctx.fillRect(r * 0.5, -r * 0.28, r * 0.75, r * 0.2);
  ctx.fillRect(r * 0.5, r * 0.1, r * 0.75, r * 0.2);
  ctx.fillStyle = '#ffe9a8';
  ctx.fillRect(r * 1.2, -r * 0.12, r * 0.3, r * 0.24);
  ctx.restore();
}

function drawListener(ctx, x, y, S, m, time) {
  if (Sprites.ready) {
    const spr = monsterSprite(m, 'L');
    if (spr.img) {
      const bob = Math.sin((m.animT || 0) * Math.PI) * S * 0.045;
      shadowBlob(ctx, x, y, S, 0.5);
      drawSprite(ctx, spr.img, x, y, S * 1.95, { bob, flip: spr.flip });
      if (m.state === 'chase' || m.state === 'open') ring(ctx, x, y, S * 0.85, `rgba(212,60,80,${0.4 + 0.3 * Math.sin(time * 10)})`);
      else if (m.state === 'investigate' || m.state === 'search') ring(ctx, x, y, S * 0.8, 'rgba(220,190,90,0.3)');
      return;
    }
  }
  const r = S * 0.34;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(m.dir);
  // тень
  ctx.beginPath();
  ctx.ellipse(0, r * 0.35, r * 1.4, r * 0.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();
  // вытянутое тело-голова
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.5, r * 0.85, 0, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.listener;
  ctx.fill();
  ctx.strokeStyle = COLORS.listenerDark;
  ctx.lineWidth = 2;
  ctx.stroke();
  // огромные уши — веера по бокам, подрагивают при тревоге
  const tw = m.alertFlash > 0 ? Math.sin(time * 30) * 0.12 : 0;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(-r * 0.2, side * (r * 0.95 + tw * r), r * 0.7, r * 0.55, side * (0.6 + tw), 0, Math.PI * 2);
    ctx.fillStyle = COLORS.listener;
    ctx.fill();
    ctx.strokeStyle = COLORS.listenerDark;
    ctx.stroke();
    // внутреннее ухо
    ctx.beginPath();
    ctx.ellipse(-r * 0.2, side * r * 0.95, r * 0.35, r * 0.25, side * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = '#6d6357';
    ctx.fill();
  }
  // зашитые глаза — стежки крестиками
  ctx.strokeStyle = '#4a4238';
  ctx.lineWidth = 1.5;
  for (const side of [-1, 1]) {
    const ex = r * 0.75, ey = side * r * 0.3;
    ctx.beginPath();
    ctx.moveTo(ex - r * 0.18, ey - r * 0.12); ctx.lineTo(ex + r * 0.18, ey + r * 0.12);
    ctx.moveTo(ex - r * 0.18, ey + r * 0.12); ctx.lineTo(ex + r * 0.18, ey - r * 0.12);
    ctx.moveTo(ex, ey - r * 0.16); ctx.lineTo(ex, ey + r * 0.16);
    ctx.stroke();
  }
  ctx.restore();
  // кольцо состояния
  if (m.state === 'chase' || m.state === 'open') ring(ctx, x, y, S * 0.75, `rgba(212,60,80,${0.4 + 0.3 * Math.sin(time * 10)})`);
  else if (m.state === 'investigate' || m.state === 'search') ring(ctx, x, y, S * 0.7, 'rgba(220,190,90,0.35)');
}

function drawWatcherBody(ctx, x, y, S, m) {
  if (Sprites.ready) {
    const spr = monsterSprite(m, 'W');
    if (spr.img) {
      const bob = Math.sin((m.animT || 0) * Math.PI) * S * 0.04;
      shadowBlob(ctx, x, y, S, 0.5);
      drawSprite(ctx, spr.img, x, y, S * 1.95, { bob, flip: spr.flip });
      return;
    }
  }
  const r = S * 0.36;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.1, r * 1.1, 0, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.watcher;
  ctx.fill();
  ctx.strokeStyle = '#584169';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawWatcherBeam(ctx, game, m, w2sx, w2sy, S) {
  const par = game.params.watcher;
  if (!par) return;
  const N = 22;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const a = m.facing - par.half + (i / N) * par.half * 2;
    const d = Math.min(castRay(game.map, m.x, m.y, a, par.range), par.range);
    pts.push({ x: m.x + Math.cos(a) * d, y: m.y + Math.sin(a) * d });
  }
  const mx = w2sx(m.x), my = w2sy(m.y);
  const chase = m.state === 'chase' || m.seesPlayer;
  const grad = ctx.createRadialGradient(mx, my, 0, mx, my, par.range * S);
  grad.addColorStop(0, chase ? 'rgba(255,60,40,0.34)' : 'rgba(255,70,50,0.22)');
  grad.addColorStop(1, 'rgba(255,60,40,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(mx, my);
  for (const pt of pts) ctx.lineTo(w2sx(pt.x), w2sy(pt.y));
  ctx.closePath();
  ctx.fill();
  // глаз светится всегда, даже в полной темноте
  ctx.beginPath();
  ctx.arc(mx + Math.cos(m.facing) * S * 0.18, my + Math.sin(m.facing) * S * 0.18, S * 0.11, 0, Math.PI * 2);
  ctx.fillStyle = '#ffefe8';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(mx + Math.cos(m.facing) * S * 0.22, my + Math.sin(m.facing) * S * 0.22, S * 0.05, 0, Math.PI * 2);
  ctx.fillStyle = '#d4302a';
  ctx.fill();
}

function drawWardrobe(ctx, x, y, S, wd, game, view) {
  const pad = S * 0.05;
  const w = S - pad * 2;
  // корпус — деревянная текстура
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + pad, y + pad, w, w);
  ctx.clip();
  ctx.fillStyle = alignPattern(ctx, view.tex.wood, x + pad, y + pad, S);
  ctx.fillRect(x + pad, y + pad, w, w);
  ctx.restore();
  // объём: свет сверху, тень снизу
  const g = ctx.createLinearGradient(0, y + pad, 0, y + pad + w);
  g.addColorStop(0, 'rgba(255,225,180,0.14)');
  g.addColorStop(0.45, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = g;
  ctx.fillRect(x + pad, y + pad, w, w);
  ctx.strokeStyle = '#2a1f14';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + pad, y + pad, w, w);

  const isMine = game.player.hidden && game.player.hideWardrobe === wd;
  if (wd.used || isMine || wd.openT > 0) {
    // приоткрыт — чёрная щель с градиентом вглубь
    const sg = ctx.createLinearGradient(x + S * 0.38, 0, x + S * 0.62, 0);
    sg.addColorStop(0, 'rgba(0,0,0,0.35)');
    sg.addColorStop(0.5, 'rgba(0,0,0,0.92)');
    sg.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = sg;
    ctx.fillRect(x + S * 0.38, y + pad, S * 0.24, w);
  } else {
    // филёнки дверец
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + pad * 2.4, y + pad * 2.4, S / 2 - pad * 3, w - pad * 2.8);
    ctx.strokeRect(x + S / 2 + pad * 0.6, y + pad * 2.4, S / 2 - pad * 3, w - pad * 2.8);
    // щель между дверцами и ручки
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x + S / 2 - 1, y + pad, 2, w);
    ctx.fillStyle = '#d8c48a';
    ctx.fillRect(x + S / 2 - pad * 1.5, y + S * 0.46, pad * 0.9, S * 0.09);
    ctx.fillRect(x + S / 2 + pad * 0.6, y + S * 0.46, pad * 0.9, S * 0.09);
  }
}

function drawCreak(ctx, x, y, S, cr, time) {
  // расшатанная доска: чуть светлее, с гвоздями и тенью по контуру
  ctx.save();
  ctx.globalAlpha = 0.5;
  const g = ctx.createLinearGradient(0, y, 0, y + S);
  g.addColorStop(0, 'rgba(150,120,90,0.22)');
  g.addColorStop(1, 'rgba(90,70,55,0.12)');
  ctx.fillStyle = g;
  ctx.fillRect(x + 1, y + S * 0.18, S - 2, S * 0.64);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 1, y + S * 0.18, S - 2, S * 0.64);
  // гвозди
  ctx.fillStyle = 'rgba(220,205,180,0.5)';
  for (const fx of [0.16, 0.84]) {
    for (const fy of [0.28, 0.72]) {
      ctx.beginPath();
      ctx.arc(x + S * fx, y + S * fy, S * 0.028, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  // если только что скрипнула — вспышка
  if (cr.flash > 0) {
    ctx.strokeStyle = `rgba(230,200,150,${cr.flash * 0.55})`;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x + 1, y + S * 0.18, S - 2, S * 0.64);
  }
}

function drawKey(ctx, x, y, S, time) {
  const glow = 0.5 + 0.5 * Math.sin(time * 3);
  ctx.beginPath();
  ctx.arc(x, y, S * 0.32, 0, Math.PI * 2);
  const grad = ctx.createRadialGradient(x, y, 0, x, y, S * 0.32);
  grad.addColorStop(0, `rgba(232,198,90,${0.25 + glow * 0.15})`);
  grad.addColorStop(1, 'rgba(232,198,90,0)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.6);
  ctx.strokeStyle = COLORS.key;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(-S * 0.08, 0, S * 0.07, 0, Math.PI * 2);
  ctx.moveTo(-S * 0.01, 0); ctx.lineTo(S * 0.14, 0);
  ctx.moveTo(S * 0.08, 0); ctx.lineTo(S * 0.08, S * 0.05);
  ctx.moveTo(S * 0.13, 0); ctx.lineTo(S * 0.13, S * 0.06);
  ctx.stroke();
  ctx.restore();
}

function drawExit(ctx, x, y, S, open, time, view) {
  const tex = view && view.tex.door;

  if (open) {
    // за открытой дверью — ночь во дворе: глубина, туман, лунная полоса
    const op = { x: x + S * 0.3, w: S * 0.7 + 1 };   // проём справа от створки
    ctx.save();
    ctx.beginPath();
    ctx.rect(op.x, y, op.w, S + 1);
    ctx.clip();

    // в глубине почти чёрно, ближе к порогу — холодный отсвет неба
    const bg = ctx.createLinearGradient(0, y, 0, y + S);
    bg.addColorStop(0, '#05080c');
    bg.addColorStop(0.55, '#0b141b');
    bg.addColorStop(1, '#1b2b31');
    ctx.fillStyle = bg;
    ctx.fillRect(op.x, y, op.w, S + 1);

    // туман: пара мягких полос, медленно плывут
    for (let i = 0; i < 2; i++) {
      const fy = y + S * (0.35 + i * 0.3) + Math.sin(time * 0.4 + i * 2) * S * 0.06;
      const fg = ctx.createLinearGradient(0, fy - S * 0.12, 0, fy + S * 0.12);
      fg.addColorStop(0, 'rgba(150,190,200,0)');
      fg.addColorStop(0.5, `rgba(150,190,200,${0.07 - i * 0.02})`);
      fg.addColorStop(1, 'rgba(150,190,200,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(op.x, fy - S * 0.12, op.w, S * 0.24);
    }

    // лунная полоса, падающая на порог
    const mg = ctx.createLinearGradient(op.x, 0, op.x + op.w, 0);
    mg.addColorStop(0, 'rgba(190,225,235,0)');
    mg.addColorStop(0.45, 'rgba(190,225,235,0.16)');
    mg.addColorStop(0.75, 'rgba(190,225,235,0.05)');
    mg.addColorStop(1, 'rgba(190,225,235,0)');
    ctx.fillStyle = mg;
    ctx.fillRect(op.x, y + S * 0.58, op.w, S * 0.42);
    ctx.restore();

    // распахнутая створка — под углом, с тенью на полотне
    if (tex) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, S * 0.3, S + 1);
      ctx.clip();
      ctx.fillStyle = alignPattern(ctx, tex, x, y, S);
      ctx.fillRect(x, y, S * 0.3, S + 1);
      const dsh = ctx.createLinearGradient(x, 0, x + S * 0.3, 0);
      dsh.addColorStop(0, 'rgba(0,0,0,0.25)');
      dsh.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = dsh;
      ctx.fillRect(x, y, S * 0.3, S + 1);
      ctx.restore();
    }

    // отсвет наружу на пол комнаты — дышит
    const glow = 0.6 + 0.4 * Math.sin(time * 1.7);
    const g = ctx.createRadialGradient(x + S * 0.65, y + S / 2, 0, x + S * 0.65, y + S / 2, S * 1.7);
    g.addColorStop(0, `rgba(150,200,215,${0.2 * glow})`);
    g.addColorStop(0.35, `rgba(120,175,195,${0.09 * glow})`);
    g.addColorStop(1, 'rgba(120,175,195,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - S * 1.4, y - S * 1.4, S * 3.8, S * 3.8);

    // косяк: тёплое дерево слева, светлая грань справа — без неонового контура
    ctx.fillStyle = 'rgba(20,14,10,0.85)';
    ctx.fillRect(x + S * 0.28, y, S * 0.05, S + 1);
    ctx.fillStyle = 'rgba(210,225,230,0.22)';
    ctx.fillRect(x + S - 2, y, 2, S + 1);
    ctx.fillRect(x, y, S + 1, 2);
    return;
  }

  // --- заперта ---
  if (tex) {
    ctx.fillStyle = alignPattern(ctx, tex, x, y, S);
    ctx.fillRect(x, y, S + 1, S + 1);
  } else {
    ctx.fillStyle = '#4e3722';
    ctx.fillRect(x, y, S + 1, S + 1);
  }
  // объём: свет сверху, тень снизу
  const sh = ctx.createLinearGradient(0, y, 0, y + S);
  sh.addColorStop(0, 'rgba(255,220,170,0.1)');
  sh.addColorStop(0.5, 'rgba(0,0,0,0)');
  sh.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = sh;
  ctx.fillRect(x, y, S + 1, S + 1);

  // накладка замка
  const lx = x + S * 0.5, ly = y + S * 0.5;
  ctx.fillStyle = '#2f2b36';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(lx - S * 0.13, ly - S * 0.17, S * 0.26, S * 0.34, S * 0.04)
                : ctx.rect(lx - S * 0.13, ly - S * 0.17, S * 0.26, S * 0.34);
  ctx.fill();
  ctx.strokeStyle = '#6d6676';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // скважина
  ctx.fillStyle = '#08060a';
  ctx.beginPath();
  ctx.arc(lx, ly - S * 0.04, S * 0.055, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(lx - S * 0.025, ly - S * 0.02);
  ctx.lineTo(lx + S * 0.025, ly - S * 0.02);
  ctx.lineTo(lx + S * 0.04, ly + S * 0.11);
  ctx.lineTo(lx - S * 0.04, ly + S * 0.11);
  ctx.closePath();
  ctx.fill();
  // холодная полоска света из щели — намёк, что снаружи выход
  ctx.fillStyle = 'rgba(150,200,190,0.16)';
  ctx.fillRect(x + S * 0.04, y + S * 0.04, S * 0.03, S * 0.92);
}

function ring(ctx, x, y, r, style) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = style;
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// --- рамки-индикаторы --------------------------------------------------------
function drawEdgeIndicators(ctx, game, W, H, S) {
  const p = game.player;
  const R = Math.min(W, H) * 0.42;
  // ближайший монстр
  let nearest = null, nd = Infinity;
  for (const m of game.monsters) {
    const d = dist(p.x, p.y, m.x, m.y);
    if (d < nd) { nd = d; nearest = m; }
  }
  if (nearest && nd < 8) {
    const ang = Math.atan2(nearest.y - p.y, nearest.x - p.x);
    const alpha = (1 - nd / 8) * (0.35 + game.heartPulse * 0.45);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, R, ang - 0.45, ang + 0.45);
    ctx.strokeStyle = `rgba(212,60,80,${alpha})`;
    ctx.lineWidth = 7 + game.heartPulse * 5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  // выход, когда открыт
  if (game.exitOpen && game.map) {
    const e = game.map.exit;
    const d = dist(p.x, p.y, e.x, e.y);
    if (d > 5) {
      const ang = Math.atan2(e.y - p.y, e.x - p.x);
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, R + 14, ang - 0.2, ang + 0.2);
      ctx.strokeStyle = 'rgba(122,200,139,0.5)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
  ctx.lineCap = 'butt';
}

function drawVignette(ctx, game, W, H) {
  const R = Math.max(W, H) * 0.75;
  const danger = clamp(game.heartPulse, 0, 1);
  const grad = ctx.createRadialGradient(W / 2, H / 2, R * 0.45, W / 2, H / 2, R);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, `rgba(${Math.floor(20 + danger * 70)},0,10,${0.55 + danger * 0.25})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

function drawScare(ctx, game, W, H) {
  const t = game.scareT; // 0.9 -> 0
  const a = clamp(t / 0.9, 0, 1);
  ctx.fillStyle = `rgba(8,2,4,${a * 0.85})`;
  ctx.fillRect(0, 0, W, H);

  // фотолицо из концептов: влетает рывком и трясётся
  const face = Sprites.get(game.scareBy === 'watcher' ? 'W_scream' : 'L_scream');
  if (face) {
    const grow = 1 - a;                       // 0 в начале -> 1 в конце
    const zoom = 1.05 + grow * 0.5;
    const shake = a * 9;
    // заполняем экран целиком: обрезки исходника уезжают за кадр
    const cover = Math.max(W / face.width, H / face.height) * zoom;
    const sw = face.width * cover;
    const sh = face.height * cover;
    const faceAlpha = Math.min(1, (1 - a) * 3.2 + 0.25);
    // непрозрачная подложка: в исходнике есть дыры в альфе, сквозь них
    // иначе видно геймплей и весь эффект рассыпается
    ctx.fillStyle = `rgba(6,2,3,${faceAlpha})`;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.globalAlpha = faceAlpha;
    ctx.translate(W / 2 + (Math.random() - 0.5) * shake, H / 2 + (Math.random() - 0.5) * shake);
    ctx.drawImage(face, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
    // красная вспышка по краям
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(120,0,12,${0.5 + a * 0.4})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  // лицо Слушателя крупно
  const s = Math.min(W, H) * (0.55 + (1 - a) * 0.25);
  const x = W / 2, y = H / 2;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.32, s * 0.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.listener;
  ctx.fill();
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * s * 0.38, -s * 0.05, s * 0.18, s * 0.28, side * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.listener;
    ctx.fill();
  }
  ctx.strokeStyle = '#3a3228';
  ctx.lineWidth = s * 0.015;
  for (const side of [-1, 1]) {
    const ex = side * s * 0.13, ey = -s * 0.1;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(ex + i * s * 0.028, ey - s * 0.04);
      ctx.lineTo(ex + i * s * 0.028 + s * 0.015, ey + s * 0.04);
      ctx.stroke();
    }
  }
  // рот-шов
  ctx.beginPath();
  ctx.moveTo(-s * 0.1, s * 0.22);
  ctx.quadraticCurveTo(0, s * 0.28, s * 0.1, s * 0.22);
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}
