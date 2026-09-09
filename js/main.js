// Оркестратор: игровой цикл, состояния, ночи, подвал, реклама, сохранения.
import { CELL, cellAt, dist, clamp, wallsBetween, bfsDistances } from './utils.js';
import { PLAYER, VISION, ADS, nightParams, nightText } from './config.js';
import { generateMap } from './mapgen.js';
import { Sound } from './audio.js';
import { Input } from './input.js';
import { SDK } from './sdk.js';
import { buildBoard, beatenBy, renderBoard } from './board.js';
import { createPlayer, updatePlayer, createListener, createWatcher, updateListener, updateWatcher } from './entities.js';
import { createView, draw } from './render.js';
import { Sprites } from './sprites.js';

const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

const game = {
  state: 'menu', // menu | play | pause | over | ui (любой экран поверх)
  input: Input,
  save: null,
  boardRows: null,

  night: 1,
  params: null,
  map: null,
  player: null,
  monsters: [],
  seen: null,

  noises: [],   // шумы текущего кадра
  ripples: [],
  keysGot: 0,
  exitOpen: false,
  lives: 3,
  grace: 0,
  time: 0,
  scareT: 0,
  pendingOutcome: null,
  heartPulse: 0,
  hintT: 0,

  sneakers: false,
  extraLifeUsed: false,
  adTimer: 0,
  adCountdown: -1,
  adBusy: false,
  keyPingT: 0,
  keyPingCd: 0,

  basement: false,
  floor: 0,

  // --- коллизии -------------------------------------------------------------
  playerSolid(cx, cy) {
    const c = cellAt(game.map, cx, cy);
    if (c === CELL.WALL) return true;
    if (c === CELL.EXIT) return !game.exitOpen;
    return game.map.wardrobeSet.has(cy * game.map.w + cx);
  },
  monsterSolid(cx, cy) {
    const c = cellAt(game.map, cx, cy);
    if (c === CELL.WALL || c === CELL.EXIT) return true;
    return game.map.wardrobeSet.has(cy * game.map.w + cx);
  },
  moveEntity(ent, dx, dy) {
    const solid = ent.kind ? game.monsterSolid : game.playerSolid;
    // moveCircle со скольжением
    ent.x += dx; resolveAxis(ent, solid, true);
    ent.y += dy; resolveAxis(ent, solid, false);
  },

  // --- события от сущностей ---------------------------------------------------
  emitNoise(x, y, r, loud, fromPlayer = true) {
    // раскат грома накрывает игрока: его шум почти не доходит
    if (fromPlayer && game.thunderT > 0) r *= 0.15;
    game.noises.push({ x, y, r, loud: loud && r >= 6 });
    if (r >= 1.5) game.ripples.push({ x, y, r: 0.3, max: Math.min(r, 6), alpha: loud ? 0.8 : 0.4 });
  },
  onPlayerStep(running, silent) {
    Sound.playerStep(running, silent);
  },
  // скрипучая половица: громкий шум, кроссовки не спасают
  checkCreak(x, y) {
    const cx = Math.floor(x), cy = Math.floor(y);
    if (!game.map.creakSet.has(cy * game.map.w + cx)) return;
    const cr = game.map.creaks.find(c => Math.floor(c.x) === cx && Math.floor(c.y) === cy);
    if (cr) cr.flash = 1;
    Sound.creak();
    game.emitNoise(x, y, PLAYER.noiseCreak, true);
  },
  onPant(exhausted) {
    Sound.pant(exhausted);
  },
  // Он открыл шкаф, а там пусто — захлопнул и пошёл дальше.
  // Шкаф остаётся рабочим: страшно само то, что он их проверяет.
  onWardrobeChecked(m, wd) {
    wd.openT = 1.2;
    Sound.wardrobe();
  },
  onMonsterStep(m) {
    const d = dist(m.x, m.y, game.player.x, game.player.y);
    if (d > 14) return;
    const walls = wallsBetween(game.map, m.x, m.y, game.player.x, game.player.y);
    Sound.monsterStep(clamp(d / 13, 0, 1), walls);
  },
  onWardrobeOpened(m, wd) {
    const p = game.player;
    p.hidden = false;
    p.hideWardrobe = null;
    wd.heardBy = null;
    if (p.returnPos) { p.x = p.returnPos.x; p.y = p.returnPos.y; }
    onCaught(m);
  },
};

function resolveAxis(ent, solidFn, isX) {
  const r = ent.r;
  const minX = Math.floor(ent.x - r), maxX = Math.floor(ent.x + r);
  const minY = Math.floor(ent.y - r), maxY = Math.floor(ent.y + r);
  for (let cy = minY; cy <= maxY; cy++)
    for (let cx = minX; cx <= maxX; cx++) {
      if (!solidFn(cx, cy)) continue;
      const nx = clamp(ent.x, cx, cx + 1), ny = clamp(ent.y, cy, cy + 1);
      const ddx = ent.x - nx, ddy = ent.y - ny;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 >= r * r || d2 === 0) continue;
      const d = Math.sqrt(d2), push = r - d;
      if (isX) ent.x += (ddx / d) * push; else ent.y += (ddy / d) * push;
    }
}

let view = null;

// ============================ СТАРТ НОЧИ/ЭТАЖА ==============================
function setupLevel() {
  const p = game.params;
  game.map = generateMap(p);
  game.player = createPlayer(game.map.start.x, game.map.start.y);
  game.seen = new Uint8Array(game.map.w * game.map.h);
  game.keysGot = 0;
  game.exitOpen = false;
  game.noises = [];
  game.ripples = [];
  game.grace = 2.0;
  game.scareT = 0;
  game.pendingOutcome = null;
  game.keyPingT = 0;
  // состояние модификатора ночи
  game.stormT = 14 + Math.random() * 14;   // первая молния не сразу
  game.thunderT = 0;      // >0 — гром глушит игрока
  game.flashT = 0;        // >0 — вспышка молнии
  game.draftT = 4 + Math.random() * 6;
  spawnMonsters();
  updateHud();
}

function spawnMonsters() {
  const map = game.map;
  const d = bfsDistances(map, map.start.x, map.start.y, game.monsterSolid);
  const sorted = map.waypoints
    .map(wp => ({ wp, d: d[Math.floor(wp.y) * map.w + Math.floor(wp.x)] }))
    .filter(o => o.d > 6)
    .sort((a, b) => b.d - a.d);
  const far1 = sorted[0]?.wp || map.waypoints[0];
  const far2 = sorted[1]?.wp || map.waypoints[map.waypoints.length - 1];
  game.monsters = [createListener(far1.x, far1.y)];
  if (game.params.twinListener) game.monsters.push(createListener(far2.x, far2.y));
  else if (game.params.watcher) game.monsters.push(createWatcher(far2.x, far2.y));
}

function relocateMonstersFar() {
  const map = game.map;
  const d = bfsDistances(map, game.player.x, game.player.y, game.monsterSolid);
  const sorted = map.waypoints
    .map(wp => ({ wp, d: d[Math.floor(wp.y) * map.w + Math.floor(wp.x)] }))
    .filter(o => o.d > 6)
    .sort((a, b) => b.d - a.d);
  game.monsters.forEach((m, i) => {
    const wp = sorted[Math.min(i, sorted.length - 1)]?.wp || map.waypoints[0];
    m.x = wp.x; m.y = wp.y;
    m.state = 'wander'; m.path = null; m.target = null; m.openTargetWardrobe = null; m.lastSeen = null;
  });
}

function startNight(n) {
  game.basement = false;
  game.floor = 0;
  game.night = n;
  game.params = nightParams(n);
  game.lives = game.params.lives;
  game.extraLifeUsed = false;
  game.sneakers = false;
  setupLevel();
  hideAllScreens();
  $('nsTitle').textContent = `НОЧЬ ${n}`;
  const mod = game.params.mod;
  $('nsMod').textContent = mod.name || '';
  $('nsMod').classList.toggle('hidden', !mod.name);
  $('nsText').innerText = mod.desc || nightText(n);
  $('btnSneakers').classList.remove('hidden');
  show('nightStart');
  game.state = 'ui';
}

function startBasementRun() {
  game.basement = true;
  game.floor = 1;
  game.night = 8;
  game.params = nightParams(8, 1);
  game.lives = 3;
  game.extraLifeUsed = false;
  game.sneakers = false;
  setupLevel();
  hideAllScreens();
  $('nsTitle').textContent = 'ПОДВАЛ — ЭТАЖ 1';
  $('nsText').innerText = 'Этажи уходят вниз, пока ты жив.\nТри жизни на весь спуск. Дальше — таблица.';
  $('btnSneakers').classList.remove('hidden');
  show('nightStart');
  game.state = 'ui';
}

function nextBasementFloor() {
  game.floor++;
  game.params = nightParams(8, game.floor);
  game.sneakers = false;
  setupLevel();
  toast(`ЭТАЖ ${game.floor}`, 2);
  enterPlay();
}

function enterPlay() {
  hideAllScreens();
  SDK.hideBanner();
  $('hud').classList.add('on');
  game.state = 'play';
  game.hintT = game.night === 1 && !game.basement ? 10 : 0;
  Sound.unlock();
  Sound.startDrone();
  SDK.gameplayStart();
  updateHud();
}

// ============================ ИСХОДЫ ========================================
function onCaught(m) {
  if (game.grace > 0 || game.state !== 'play' || game.pendingOutcome) return;
  game.lives--;
  game.scareT = 0.9;
  game.heartPulse = 1;
  game.pendingOutcome = 'respawn';
  game.scareBy = m && m.kind === 'watcher' ? 'watcher' : 'listener';
  Sound.scare(true, game.scareBy);
  updateHud();
  game.player.hidden = false;
  game.player.hideWardrobe = null;
}

// вызывается из update, когда скример дотикал (игровое время, не setTimeout)
function resolveOutcome() {
  const o = game.pendingOutcome;
  game.pendingOutcome = null;
  if (game.lives <= 0) { gameOver(); return; }
  if (o === 'respawn') {
    const p = game.player;
    p.x = game.map.start.x; p.y = game.map.start.y;
    relocateMonstersFar();
    game.grace = 2.5;
    toast(`Он оттащил тебя ко входу. Ключи при тебе. ♥ ${game.lives}`, 3);
  }
  // 'traitor': игрок остаётся на месте, монстры уже идут на шум
}

function gameOver() {
  if (game.state === 'over') return;
  game.state = 'over';
  Sound.setBreath(0);   // музыка продолжается — обрыв на экранах звучит дёшево
  SDK.gameplayStop();
  hideAllScreens();
  if (game.basement) {
    // и в подвале даём выкупить одну жизнь — это самый ценный слот rewarded
    $('goText').innerText = `Этаж ${game.floor}. Он добрался.`;
    $('btnRetry').textContent = 'Сдаться';
    $('btnGoMenu').classList.add('hidden');
  } else {
    $('goText').innerText = `Ночь ${game.night}. Дом остаётся за ним.`;
    $('btnRetry').textContent = 'Начать ночь заново';
    $('btnGoMenu').classList.remove('hidden');
  }
  $('btnLifeAd').classList.toggle('hidden', game.extraLifeUsed);
  show('gameover');
}

function endBasementRun() {
  hideAllScreens();
  const floors = Math.max(0, game.floor - 1);
  const oldBest = game.save.basementBest || 0;
  const rows = game.boardRows || buildBoard(game.save);
  const beaten = beatenBy(rows, oldBest, floors);
  if (floors > oldBest) game.save.basementBest = floors;
  game.save.totalRuns = (game.save.totalRuns || 0) + 1;
  game.save.basementRuns = (game.save.basementRuns || 0) + 1;
  game.boardRows = buildBoard(game.save);
  saveGame();
  $('beTitle').textContent = floors === 0 ? 'ПОДВАЛ НЕ ПУСТИЛ' : `ПОДВАЛ: ЭТАЖ ${floors}`;
  const praise = $('bePraise');
  praise.innerHTML = '';
  for (const name of beaten) {
    const div = document.createElement('div');
    div.className = 'praise';
    div.textContent = `Ты спустился глубже, чем «${name}»`;
    praise.appendChild(div);
  }
  if (floors > oldBest && oldBest > 0 && !beaten.length) {
    const div = document.createElement('div');
    div.className = 'praise';
    div.textContent = 'Твой личный рекорд.';
    praise.appendChild(div);
  }
  $('beText').innerText = floors > 0 ? 'Внизу стало тише. Это не к добру.' : 'Первый этаж съел все три жизни.';
  show('basementEnd');
  maybeInterstitialOnScreen();
}

function nightComplete() {
  if (game.basement) {
    nextBasementFloor();
    maybeMidLevelAdReset();
    return;
  }
  Sound.setBreath(0);
  Sound.win();
  SDK.gameplayStop();
  game.state = 'ui';
  hideAllScreens();
  const done = game.night;
  game.save.night = Math.max(game.save.night || 1, done + 1);
  game.save.bestNight = Math.max(game.save.bestNight || 0, done);
  if (done >= 8) game.save.basementUnlocked = true;
  saveGame();

  // восьмая ночь — конец главы, но не конец игры: дом не отпускает
  if (done === 8) {
    show('win');
    refreshMenu();
    return;
  }
  $('transTitle').textContent = `НОЧЬ ${done} ПРОЙДЕНА`;
  $('transText').innerText =
    done === 4 ? 'Половина. Дом это заметил.'
    : done > 8 ? `Ты пережил ${done}. Дверь снова ведёт внутрь.`
    : 'Дверь захлопнулась за спиной. До рассвета далеко.';
  show('trans');
  maybeInterstitialOnScreen();
}

// interstitial на экранах-перебивках (между ночами / после подвала)
function maybeInterstitialOnScreen() {
  if (game.adTimer < ADS.transitionMin) return;
  const timerEl = $('transTimer');
  const nextBtn = $('btnNext');
  let left = 3;
  timerEl.classList.remove('hidden');
  nextBtn.disabled = true;
  $('btnBeRetry').disabled = true;
  timerEl.textContent = `реклама через ${left}…`;
  const iv = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(iv);
      timerEl.textContent = '';
      game.adBusy = true;
      SDK.showInterstitial(() => {
        game.adBusy = false;
        game.adTimer = 0;
        timerEl.classList.add('hidden');
        nextBtn.disabled = false;
        $('btnBeRetry').disabled = false;
      });
    } else timerEl.textContent = `реклама через ${left}…`;
  }, 1000);
}

function maybeMidLevelAdReset() {
  // между этажами подвала interstitial не вставляем — там нет экрана-паузы,
  // таймер продолжает тикать и сработает в спокойный момент
}

// ============================ ЦИКЛ ==========================================
let lastT = 0;
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
  lastT = t;
  if (game.state === 'play' && !game.adBusy) update(dt);
  else Sound.update(dt, 0);   // в меню и на паузе музыка живёт своей жизнью
  if (view && game.map) draw(game, view);
}

function update(dt) {
  game.time += dt;
  game.grace = Math.max(0, game.grace - dt);
  game.heartPulse = Math.max(0, game.heartPulse - dt * 2.2);
  if (game.scareT > 0) {
    game.scareT -= dt;
    if (game.scareT <= 0 && game.pendingOutcome) resolveOutcome();
    return; // стоп-кадр скримера
  }

  Input.update();
  if (Input.consumePause()) { pauseGame(); return; }

  updatePlayer(game, dt);

  for (const m of game.monsters) {
    if (m.kind === 'listener') updateListener(game, m, dt);
    else updateWatcher(game, m, dt);
  }

  // фазы анимации спрайтов
  const pl = game.player;
  pl.animT = (pl.animT || 0) + (pl.moving ? dt * (pl.running ? 13 : 7.5) : 0);
  pl.animFrame = Math.floor(pl.animT);
  for (const m of game.monsters) {
    const sp = m.state === 'chase' || m.state === 'open' ? 11 : 6;
    m.animT = (m.animT || 0) + dt * sp;
    m.animFrame = Math.floor(m.animT);
  }
  // шумы, изданные после этой точки (шкафы, ключи), монстры услышат в следующем кадре
  game.noises = [];

  const p = game.player;

  // поимка
  if (!p.hidden && game.grace <= 0) {
    for (const m of game.monsters) {
      if (dist(m.x, m.y, p.x, p.y) < 0.55) { onCaught(m); return; }
    }
  }
  // шкаф: монстр, который знает, где ты, дошёл и открыл
  if (p.hidden && p.hideWardrobe) {
    for (const m of game.monsters) {
      if (m.kind !== 'listener') continue;
      if (m.openTargetWardrobe === p.hideWardrobe && dist(m.x, m.y, p.x, p.y) < 1.05) {
        game.onWardrobeOpened(m, p.hideWardrobe);
        return;
      }
    }
  }

  // ключи
  for (const k of game.map.keys) {
    if (!k.taken && dist(k.x, k.y, p.x, p.y) < 0.5) {
      k.taken = true;
      game.keysGot++;
      Sound.keyPickup();
      game.emitNoise(p.x, p.y, PLAYER.noiseKey, false);
      updateHud();
      if (game.keysGot >= game.map.keys.length) {
        game.exitOpen = true;
        Sound.doorUnlock();
        toast('Щёлкнул замок. Дверь открыта.', 3.5);
      } else {
        toast(`Ключ ${game.keysGot} из ${game.map.keys.length}`, 1.6);
      }
    }
  }

  // выход
  if (game.exitOpen && dist(game.map.exit.x, game.map.exit.y, p.x, p.y) < 0.75) {
    nightComplete();
    return;
  }

  // взаимодействие
  handleInteract();

  // сердце/дыхание
  let nd = Infinity;
  for (const m of game.monsters) nd = Math.min(nd, dist(m.x, m.y, p.x, p.y));
  const bpm = clamp(150 - nd * 8.5, 52, 152);
  const strong = Sound.heartbeat(dt, bpm, clamp(1 - nd / 15, 0.1, 1));
  if (strong && nd < 9) game.heartPulse = clamp(1 - nd / 10, 0.2, 1);
  const listener = game.monsters.find(m => m.kind === 'listener');
  Sound.setBreath(listener ? clamp(1 - dist(listener.x, listener.y, p.x, p.y) / 4, 0, 1) : 0);

  // музыка: слой тревоги растёт по близости и особенно в погоне
  const chasing = game.monsters.some(m => m.state === 'chase' || m.state === 'open');
  const tension = clamp(Math.max(1 - nd / 11, chasing ? 0.75 : 0), 0, 1);
  // «тишина»: музыку убираем совсем — остаются только он и ты
  Sound.setMusicLevel(game.params.mod.id === 'silence' ? 0 : 1);
  Sound.update(dt, tension);

  // круги шума
  for (const rp of game.ripples) {
    rp.r += dt * 7;
    rp.alpha -= dt * (rp.r > rp.max ? 3 : 0.9);
  }
  game.ripples = game.ripples.filter(rp => rp.alpha > 0);
  for (const cr of game.map.creaks) if (cr.flash > 0) cr.flash -= dt * 1.6;
  for (const wd of game.map.wardrobes) if (wd.openT > 0) wd.openT -= dt;

  updateStaminaBar();
  updateModifier(dt);

  // подсказка
  if (game.hintT > 0) {
    game.hintT -= dt;
    const el = $('hint');
    el.textContent = Input.isTouchDevice
      ? 'Веди пальцем — идти. Дальше от точки касания — бег. Бег слышно.'
      : 'WASD — идти · Shift — бег (его слышно) · E — шкаф/дверь';
    el.style.opacity = game.hintT < 1 ? game.hintT : 1;
    if (game.hintT <= 0) el.textContent = '';
  }

  // реклама в спокойный момент
  game.adTimer += dt;
  updateInterstitialInLevel(dt);

  // подсветка ключей
  game.keyPingT = Math.max(0, game.keyPingT - dt);
  game.keyPingCd = Math.max(0, game.keyPingCd - dt);
  const kbtn = $('btnKeyAd');
  const canPing = game.keysGot < game.map.keys.length && game.keyPingCd <= 0 && game.time > 10;
  kbtn.classList.toggle('hidden', !canPing);
}

// interstitial внутри уровня: таймер натикал → ждём спокойный момент
let midCountdown = -1;
function updateInterstitialInLevel(dt) {
  if (game.adTimer < ADS.interstitialInterval) return;
  const calm = isCalm();
  if (midCountdown < 0) {
    if (!calm) return;
    midCountdown = 3;
    toast('реклама через 3…', 1.2);
    return;
  }
  const before = Math.ceil(midCountdown);
  midCountdown -= dt;
  if (!calm) { midCountdown = -1; return; } // погоня началась — отложили
  const after = Math.ceil(midCountdown);
  if (after < before && after > 0) toast(`реклама через ${after}…`, 1.2);
  if (midCountdown <= 0) {
    midCountdown = -1;
    // паузу, звук и adBusy берут на себя хуки SDK.setAdHooks
    SDK.showInterstitial(() => { game.adTimer = 0; });
  }
}

function isCalm() {
  if (game.scareT > 0) return false;
  for (const m of game.monsters) {
    if (m.state === 'chase' || m.state === 'open') return false;
    if (dist(m.x, m.y, game.player.x, game.player.y) < ADS.calmDistance) return false;
  }
  return true;
}

// ============================ ВЗАИМОДЕЙСТВИЕ ================================
function handleInteract() {
  const p = game.player;
  const btn = $('btnAct');
  let action = null, label = '';

  if (p.hidden) {
    action = 'unhide'; label = 'Выйти из шкафа';
  } else {
    let bestWd = null, bd = Infinity;
    for (const wd of game.map.wardrobes) {
      if (wd.used) continue;
      const d = dist(wd.x, wd.y, p.x, p.y);
      if (d < 1.25 && d < bd) { bd = d; bestWd = wd; }
    }
    if (bestWd) { action = 'hide'; label = 'Спрятаться'; game._nearWd = bestWd; }
    else if (!game.exitOpen && dist(game.map.exit.x, game.map.exit.y, p.x, p.y) < 1.4) {
      action = 'door'; label = 'Дверь';
    }
  }

  btn.classList.toggle('on', !!action && Input.isTouchDevice);
  if (action) btn.textContent = label;

  const pressed = Input.consumeInteract(); // снимаем нажатие всегда, чтобы не «залипало»
  if (pressed && action) {
    if (action === 'unhide') unhide();
    else if (action === 'hide') hideIn(game._nearWd);
    else if (action === 'door') toast(`Заперто. Ключей ${game.keysGot} из ${game.map.keys.length}.`, 2.5);
  }
}

function hideIn(wd) {
  const p = game.player;
  if (wd.traitor) {
    // шкаф-предатель: ночь 5 и случайно в подвале
    wd.traitor = false; wd.used = true;
    game.map.wardrobeSet.delete(Math.floor(wd.y) * game.map.w + Math.floor(wd.x));
    Sound.scare(true, 'listener');
    game.scareT = 0.9;
    game.heartPulse = 1;
    game.pendingOutcome = 'traitor';
    game.scareBy = 'listener';
    game.emitNoise(wd.x, wd.y, 10, true);
    game.lives--;
    updateHud();
    toast('Этот шкаф был занят.', 3);
    return;
  }
  p.returnPos = { x: p.x, y: p.y };
  p.hidden = true;
  p.hideWardrobe = wd;
  p.x = wd.x; p.y = wd.y;
  Sound.wardrobe();
  game.emitNoise(wd.x, wd.y, PLAYER.noiseWardrobe, false);
  // кто «запомнил», что ты туда залез
  wd.heardBy = null;
  for (const m of game.monsters) {
    if (m.kind === 'listener') {
      const walls = wallsBetween(game.map, m.x, m.y, wd.x, wd.y);
      const eff = PLAYER.noiseWardrobe * game.params.listener.hearMult * Math.pow(0.55, walls);
      const heard = dist(m.x, m.y, wd.x, wd.y) < eff;
      if ((m.state === 'chase' || m.state === 'open') || (heard && m.state === 'investigate')) {
        wd.heardBy = m;
        m.openTargetWardrobe = wd;
        m.state = 'open';
        m.target = { x: wd.x, y: wd.y };
        m.path = null; m.repathT = 0;
      }
    } else if (m.seesPlayer) {
      m.openTargetWardrobe = wd;
      m.lastSeen = { x: wd.x, y: wd.y };
      m.state = 'chase';
      m.target = { x: wd.x, y: wd.y };
      m.path = null; m.repathT = 0;
    }
  }
}

function unhide() {
  const p = game.player;
  const wd = p.hideWardrobe;
  p.hidden = false;
  p.hideWardrobe = null;
  if (wd) wd.heardBy = null;
  for (const m of game.monsters) if (m.openTargetWardrobe === wd) m.openTargetWardrobe = null;
  if (p.returnPos) { p.x = p.returnPos.x; p.y = p.returnPos.y; p.returnPos = null; }
  Sound.wardrobe();
  game.emitNoise(p.x, p.y, PLAYER.noiseWardrobe, false);
}

// ============================ UI ============================================
function hideAllScreens() {
  ['menu', 'pause', 'intro', 'nightStart', 'trans', 'gameover', 'win', 'basementEnd', 'board'].forEach(hide);
  $('hud').classList.remove('on');
}

function updateHud() {
  $('lives').textContent = '♥'.repeat(Math.max(0, game.lives)) + '♡'.repeat(Math.max(0, 3 - game.lives));
  $('keysLbl').textContent = game.map ? `Ключи: ${game.keysGot}/${game.map.keys.length}` : '';
  $('nightLbl').textContent = game.basement ? `Подвал — этаж ${game.floor}` : `Ночь ${game.night}`;
}

// Модификаторы ночи: гроза и сквозняк живут своей жизнью и меняют правила.
function updateModifier(dt) {
  const mod = game.params.mod;
  game.thunderT = Math.max(0, game.thunderT - dt);
  game.flashT = Math.max(0, game.flashT - dt);

  if (mod.id === 'storm') {
    game.stormT -= dt;
    if (game.stormT <= 0) {
      game.stormT = 26 + Math.random() * 22;
      game.flashT = 0.5;                     // вспышка — сначала свет
      game.thunderT = 2.2;                   // потом раскат, он и глушит
      Sound.thunder();
      // молния выдаёт тебя тому, кто видит: он мгновенно знает, где ты
      for (const m of game.monsters) {
        if (m.kind !== 'watcher' || game.player.hidden) continue;
        if (dist(m.x, m.y, game.player.x, game.player.y) > 16) continue;
        m.lastSeen = { x: game.player.x, y: game.player.y };
        m.state = 'chase';
        m.chaseHold = 4;          // наводка держится, даже если путь не сразу
        m.alertFlash = 0.6;
        m.target = null;
        m.path = null; m.repathT = 0;
      }
    }
  }

  if (mod.id === 'draft') {
    game.draftT -= dt;
    if (game.draftT <= 0) {
      game.draftT = 6 + Math.random() * 9;
      // дом скрипит сам: ложный шум подальше от игрока
      const wp = game.map.waypoints;
      let best = null, bd = 0;
      for (let i = 0; i < 6; i++) {
        const c = wp[Math.floor(Math.random() * wp.length)];
        const d = dist(c.x, c.y, game.player.x, game.player.y);
        if (d > bd) { bd = d; best = c; }
      }
      if (best && bd > 5) {
        game.emitNoise(best.x, best.y, 7, true, false);   // не от игрока
        game.ripples.push({ x: best.x, y: best.y, r: 0.3, max: 5, alpha: 0.5 });
        Sound.creakDistant();
      }
    }
  }
}

function updateStaminaBar() {
  const p = game.player;
  const fill = $('stamFill');
  const bar = $('stamBar');
  const pct = clamp(p.stamina / PLAYER.staminaMax, 0, 1);
  fill.style.width = (pct * 100) + '%';
  bar.classList.toggle('low', p.exhausted);
  // прячем полоску, когда полная и игрок не бежит — не мозолит глаза
  bar.classList.toggle('faded', pct >= 1 && !p.running);
}

let toastTimer = null;
function toast(text, secs) {
  const el = $('toast');
  el.textContent = text;
  el.style.opacity = 1;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = 0; }, secs * 1000);
}

function pauseGame() {
  if (game.state !== 'play') return;
  game.state = 'pause';
  SDK.gameplayStop();
  $('btnSneakersP').classList.toggle('hidden', game.sneakers);
  show('pause');
}

function resumeGame() {
  hide('pause');
  game.state = 'play';
  lastT = performance.now();
  SDK.gameplayStart();
}

function toMenu() {
  game.state = 'menu';
  Sound.setBreath(0);
  SDK.gameplayStop();
  SDK.showBanner();
  hideAllScreens();
  refreshMenu();
  show('menu');
}

function refreshMenu() {
  const s = game.save;
  const n = s.night || 1;
  $('btnPlay').textContent = n === 1 ? 'Начать' : `Продолжить — ночь ${n}`;
  if (s.basementUnlocked) {
    $('btnBasement').classList.remove('hidden');
    $('basementBest').textContent = s.basementBest ? `рекорд: этаж ${s.basementBest}` : 'там ещё никого из твоих';
  }
  $('btnMute').textContent = Sound.muted ? '🔇' : '🔊';
}

function openBoard() {
  game.boardRows = game.boardRows || buildBoard(game.save);
  renderBoard($('boardList'), game.boardRows, game.save.basementBest || 0, (game.save.basementBest || 0) > 0 || (game.save.basementRuns || 0) > 0);
  hideAllScreens();
  show('board');
}

function saveGame() {
  game.save.muted = Sound.muted;
  SDK.save(game.save);
}

// ============================ КНОПКИ ========================================
function wireUI() {
  // первый клик по странице разблокирует звук и заводит музыку меню
  const wake = () => {
    Sound.unlock();
    Sound.loadClips();          // подхватит assets/audio/, если файлы положили
    if (!Sound.muted) Sound.startDrone();
    window.removeEventListener('pointerdown', wake);
    window.removeEventListener('keydown', wake);
  };
  window.addEventListener('pointerdown', wake);
  window.addEventListener('keydown', wake);

  $('btnIntroGo').onclick = () => { game.save.seenIntro = true; saveGame(); startNight(1); };
  $('btnIntroSkip').onclick = () => $('intro').classList.add('fast');

  $('btnPlay').onclick = () => {
    Sound.unlock();
    // первый запуск — сначала вступление
    if (!game.save.seenIntro && (game.save.night || 1) === 1) {
      hideAllScreens();
      $('intro').classList.remove('fast');
      show('intro');
      game.state = 'ui';
      return;
    }
    startNight(game.save.night || 1);
  };
  $('btnBasement').onclick = () => { Sound.unlock(); startBasementRun(); };
  $('btnBoard').onclick = () => openBoard();
  $('btnBoardBack').onclick = () => {
    hide('board');
    if (game.state === 'menu') show('menu');
    else show('basementEnd');
  };

  $('btnGo').onclick = () => enterPlay();
  $('btnSneakers').onclick = () => {
    SDK.showRewarded(ok => {
      if (ok) {
        game.sneakers = true;
        $('btnSneakers').classList.add('hidden');
        toast('Кроссовки надеты. Бег беззвучен до конца ночи.', 3);
      }
    });
  };
  $('btnSneakersP').onclick = () => {
    SDK.showRewarded(ok => {
      if (ok) {
        game.sneakers = true;
        $('btnSneakersP').classList.add('hidden');
      }
    });
  };

  $('btnNext').onclick = () => startNight(game.night + 1);
  $('btnWinMenu').onclick = () => toMenu();
  $('btnWinNext').onclick = () => startNight(9);

  $('btnRetry').onclick = () => {
    if (game.basement) { endBasementRun(); return; }
    startNight(game.night);
  };
  $('btnGoMenu').onclick = () => toMenu();
  $('btnLifeAd').onclick = () => {
    SDK.showRewarded(ok => {
      if (!ok) return;
      game.extraLifeUsed = true;
      game.lives = 1;
      hideAllScreens();
      game.player.x = game.map.start.x; game.player.y = game.map.start.y;
      game.player.hidden = false; game.player.hideWardrobe = null;
      relocateMonstersFar();
      game.grace = 2.5;
      enterPlay();
    });
  };

  $('btnBeRetry').onclick = () => startBasementRun();
  $('btnBeMenu').onclick = () => toMenu();
  $('btnBeBoard').onclick = () => { hide('basementEnd'); openBoard(); };

  $('btnResume').onclick = () => resumeGame();
  $('btnQuit').onclick = () => toMenu();
  $('btnPause').onclick = () => pauseGame();
  $('btnMute').onclick = () => {
    Sound.unlock();
    Sound.setMuted(!Sound.muted);
    $('btnMute').textContent = Sound.muted ? '🔇' : '🔊';
    saveGame();
  };
  $('btnKeyAd').onclick = () => {
    if (game.state !== 'play') return;
    SDK.showRewarded(ok => {
      if (ok) {
        game.keyPingT = ADS.keyPingDuration;
        game.keyPingCd = ADS.keyPingCooldown;
        $('btnKeyAd').classList.add('hidden');
      }
    });
  };
  $('btnAct').onclick = () => { Input.interactPressed = true; };

  // Требование Яндекса: при потере фокуса гасим звук и ставим игру на паузу.
  const suspend = () => {
    Sound.setSuspended(true);
    if (game.state === 'play') pauseGame();
  };
  const resume = () => {
    // мут игрока уважаем — снимаем только системное приглушение
    Sound.setSuspended(false);
  };
  // Только visibilitychange и события SDK. window.blur сюда не годится:
  // на Яндексе игра живёт в iframe, и клик мимо неё гасил бы звук прямо
  // посреди игры.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspend(); else resume();
  });
  SDK.onPauseResume(suspend, resume);

  // реклама: глушим звук и останавливаем геймплей на время показа
  SDK.setAdHooks(
    () => { game.adBusy = true; Sound.setSuspended(true); SDK.gameplayStop(); },
    () => {
      game.adBusy = false;
      Sound.setSuspended(false);
      lastT = performance.now();          // чтобы не прилетел гигантский dt
      if (game.state === 'play') SDK.gameplayStart();
    }
  );
}

// ============================ BOOT ==========================================
async function boot() {
  view = createView($('cv'));
  Input.init($('cv'));
  wireUI();

  // ассеты необязательны: без них игра рисует векторную графику
  await Sprites.load();

  await SDK.init();
  const loaded = await SDK.load();
  game.save = loaded || { night: 1, basementBest: 0, basementUnlocked: false, totalRuns: 0 };
  if (game.save.muted) Sound.setMuted(true);
  game.boardRows = buildBoard(game.save);

  refreshMenu();
  SDK.ready();
  SDK.showBanner();
  window.__game = game; // отладка
  window.__view = view;
  window.__step = (dt, frames = 1) => { // ручной прогон кадров для тестов
    for (let i = 0; i < frames; i++) {
      if (game.state === 'play' && !game.adBusy) update(dt);
      if (view && game.map) draw(game, view);
    }
  };
  requestAnimationFrame(loop);
}

boot();
