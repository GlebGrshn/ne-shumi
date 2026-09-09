// Игрок и два монстра.
// Слушатель: слепой, охотится только на звук. Стоишь — он проходит мимо.
// Смотритель: глухой, но видит далеко узким лучом и медленно поворачивается.
import { dist, clamp, normAngle, bfsPath, wallsBetween, losClear } from './utils.js';
import { PLAYER } from './config.js';

// ============================= ИГРОК ========================================
export function createPlayer(x, y) {
  return {
    x, y, r: PLAYER.r,
    dir: 0,
    moving: false, running: false,
    hidden: false, hideWardrobe: null, returnPos: null,
    stepT: 0,
    speedNow: 0,
    stamina: PLAYER.staminaMax,
    exhausted: false,   // выдохся — бежать нельзя, пока не отдышится
    pantT: 0,           // таймер шумного дыхания
    pantLeft: 0,        // сколько ещё секунд дышит громко
  };
}

export function updatePlayer(game, dt) {
  const p = game.player, inp = game.input;
  if (p.hidden) {
    p.moving = false; p.speedNow = 0;
    // в шкафу восстанавливаемся, но дыхание всё равно слышно
    p.stamina = Math.min(PLAYER.staminaMax, p.stamina + PLAYER.staminaRegenStand * dt);
    if (p.stamina >= PLAYER.staminaReady) p.exhausted = false;
    updatePanting(game, p, dt);
    return;
  }

  const mx = inp.moveX, my = inp.moveY;
  const mag = Math.hypot(mx, my);
  p.moving = mag > 0.05;
  const wantsRun = p.moving && inp.running;
  p.running = wantsRun && !p.exhausted && p.stamina > 0;

  // выносливость
  if (p.running) {
    p.stamina -= PLAYER.staminaDrain * dt;
    p.pantLeft = PLAYER.pantDuration;
    if (p.stamina <= 0) { p.stamina = 0; p.exhausted = true; }
  } else {
    const regen = p.moving ? PLAYER.staminaRegenWalk : PLAYER.staminaRegenStand;
    p.stamina = Math.min(PLAYER.staminaMax, p.stamina + regen * dt);
    if (p.exhausted && p.stamina >= PLAYER.staminaReady) p.exhausted = false;
  }

  if (p.moving) {
    const base = p.running ? PLAYER.runSpeed : PLAYER.walkSpeed * (0.55 + 0.45 * clamp(mag, 0, 1));
    p.speedNow = base;
    p.dir = Math.atan2(my, mx);
    game.moveEntity(p, mx / (mag || 1) * base * dt, my / (mag || 1) * base * dt);

    // шаги + шум
    p.stepT -= dt;
    if (p.stepT <= 0) {
      p.stepT = p.running ? PLAYER.stepIntervalRun : PLAYER.stepIntervalWalk;
      const silent = game.sneakers && p.running;
      game.onPlayerStep(p.running, silent);
      const radius = p.running ? (silent ? PLAYER.noiseRun * 0.25 : PLAYER.noiseRun) : PLAYER.noiseWalk;
      game.emitNoise(p.x, p.y, radius, p.running && !silent);
      // скрипучая половица под ногой — громко, даже если крадёшься
      game.checkCreak(p.x, p.y);
    }
  } else {
    p.speedNow = 0;
    p.stepT = 0.08;
  }

  updatePanting(game, p, dt);
}

// Загнанное дыхание: после бега слышно, и кроссовки от него не спасают.
function updatePanting(game, p, dt) {
  if (p.pantLeft > 0) p.pantLeft -= dt;
  const heavy = p.exhausted || p.pantLeft > 0;
  if (!heavy) { p.pantT = 0; return; }
  p.pantT -= dt;
  if (p.pantT <= 0) {
    p.pantT = PLAYER.pantInterval;
    game.onPant(p.exhausted);
    game.emitNoise(p.x, p.y, p.exhausted ? PLAYER.noisePant : PLAYER.noisePant * 0.6, false);
  }
}

// ============================= БАЗА МОНСТРА =================================
function createMonster(kind, x, y) {
  return {
    kind, x, y, r: 0.34,
    dir: 0,
    state: 'wander',       // wander | investigate | chase | search | open
    target: null,          // {x,y}
    path: null, pathI: 0, repathT: 0,
    waitT: 0, searchT: 0, chaseKeepT: 0,
    stepT: 0,
    alertFlash: 0,         // визуальный сигнал «услышал/увидел»
    openTargetWardrobe: null,
    // watcher:
    facing: 0, scanDir: 1, lastSeen: null, seesPlayer: false, alertT: 0,
  };
}

export function createListener(x, y) { return createMonster('listener', x, y); }
export function createWatcher(x, y) { const m = createMonster('watcher', x, y); return m; }

function setPath(game, m, tx, ty) {
  m.target = { x: tx, y: ty };
  m.path = bfsPath(game.map, m.x, m.y, tx, ty, game.monsterSolid);
  m.pathI = 0;
  m.repathT = 0.6;
}

function followPath(game, m, speed, dt) {
  if (!m.path || m.pathI >= m.path.length) return true;
  const node = m.path[m.pathI];
  const dx = node.x - m.x, dy = node.y - m.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.15) { m.pathI++; return m.pathI >= m.path.length; }
  m.dir = Math.atan2(dy, dx);
  game.moveEntity(m, dx / d * speed * dt, dy / d * speed * dt);
  // шаги монстра — слышны сквозь стены, это и есть игра
  m.stepT -= dt;
  if (m.stepT <= 0) {
    m.stepT = clamp(0.55 - speed * 0.05, 0.22, 0.5);
    game.onMonsterStep(m);
  }
  return false;
}

// Ближайший необысканный шкаф в радиусе поиска.
function nearestUncheckedWardrobe(game, m) {
  let best = null, bd = 4.5;
  for (const wd of game.map.wardrobes) {
    if (wd.used) continue;
    if (m.checked && m.checked.has(wd)) continue;
    const d = dist(m.x, m.y, wd.x, wd.y);
    if (d < bd) { bd = d; best = wd; }
  }
  return best;
}

function pickWanderTarget(game, m) {
  const wp = game.map.waypoints;
  for (let i = 0; i < 8; i++) {
    const t = wp[Math.floor(Math.random() * wp.length)];
    if (dist(m.x, m.y, t.x, t.y) > 4) { setPath(game, m, t.x, t.y); return; }
  }
  setPath(game, m, wp[0].x, wp[0].y);
}

// ============================= СЛУШАТЕЛЬ ====================================
export function updateListener(game, m, dt) {
  const p = game.player;
  const par = game.params.listener;
  m.alertFlash = Math.max(0, m.alertFlash - dt);

  // --- слух: обрабатываем шумы этого кадра ---
  if (!game.grace) {
    for (const n of game.noises) {
      const walls = wallsBetween(game.map, m.x, m.y, n.x, n.y);
      const eff = n.r * par.hearMult * Math.pow(0.55, walls);
      const d = dist(m.x, m.y, n.x, n.y);
      if (d > eff) continue;
      m.alertFlash = 0.7;
      const loud = n.loud || false;
      if (loud || m.state === 'chase') {
        m.state = 'chase';
        m.chaseKeepT = 3.5;
        setPath(game, m, n.x, n.y);
      } else {
        // тихий звук: идём посмотреть; повторный тихий за 2.5с — уже погоня
        if (m.state === 'investigate' && m._lastQuiet && game.time - m._lastQuiet < 2.5) {
          m.state = 'chase';
          m.chaseKeepT = 3.0;
          setPath(game, m, n.x, n.y);
        } else if (m.state !== 'open') {
          m.state = 'investigate';
          setPath(game, m, n.x, n.y);
        }
        m._lastQuiet = game.time;
      }
    }

    // --- чувство близости: слышит дыхание/шорох, если игрок ДВИЖЕТСЯ рядом ---
    if (!p.hidden && p.moving && dist(m.x, m.y, p.x, p.y) < par.proximity + (p.running ? 0.6 : 0)) {
      m.state = 'chase';
      m.chaseKeepT = 1.6;
      setPath(game, m, p.x, p.y);
      m.alertFlash = 0.7;
    }
  }

  // --- шкаф: если игрок спрятался у него на слуху, идёт открывать ---
  if (p.hidden && m.state === 'chase' && !m.openTargetWardrobe && p.hideWardrobe && p.hideWardrobe.heardBy === m) {
    m.state = 'open';
    m.openTargetWardrobe = p.hideWardrobe;
    setPath(game, m, p.hideWardrobe.x, p.hideWardrobe.y);
  }

  // --- состояния ---
  switch (m.state) {
    case 'wander': {
      if (!m.path || m.pathI >= (m.path?.length || 0)) {
        m.waitT -= dt;
        if (m.waitT <= 0) { pickWanderTarget(game, m); m.waitT = 1 + Math.random() * 2; }
      }
      followPath(game, m, par.wander, dt);
      break;
    }
    case 'investigate': {
      const done = followPath(game, m, par.investigate, dt);
      if (done) { m.state = 'search'; m.searchT = 4.5; m.waitT = 0; }
      break;
    }
    case 'chase': {
      m.chaseKeepT -= dt;
      const done = followPath(game, m, par.chase, dt);
      if (done || (m.chaseKeepT <= 0 && (!m.path || m.pathI >= m.path.length))) {
        m.state = 'search'; m.searchT = 6; m.waitT = 0;
      }
      break;
    }
    case 'search': {
      // обыскивает место: тычки вокруг + заглядывает в шкафы
      m.searchT -= dt;
      if (!m.path || m.pathI >= m.path.length) {
        m.waitT -= dt;
        if (m.waitT <= 0) {
          const wd = par.checkWardrobes ? nearestUncheckedWardrobe(game, m) : null;
          if (wd) {
            // пошёл открывать шкаф — если ты внутри, тебя найдут
            m.state = 'open';
            m.openTargetWardrobe = wd;
            m.suspectWardrobe = true;
            setPath(game, m, wd.x, wd.y);
            break;
          }
          const a = Math.random() * Math.PI * 2;
          const rr = 1.5 + Math.random() * 2.5;
          setPath(game, m, clamp(m.x + Math.cos(a) * rr, 1, game.map.w - 1), clamp(m.y + Math.sin(a) * rr, 1, game.map.h - 1));
          m.waitT = 0.7 + Math.random();
        }
      } else followPath(game, m, par.investigate * 0.8, dt);
      if (m.searchT <= 0) { m.state = 'wander'; m.checked = null; }
      break;
    }
    case 'open': {
      const wd = m.openTargetWardrobe;
      if (!wd) { m.state = 'search'; m.searchT = 4; break; }
      // на подозрении идёт медленнее — есть шанс выскочить и убежать
      const speed = m.suspectWardrobe ? par.investigate : par.chase;
      const done = followPath(game, m, speed, dt);
      if (done || dist(m.x, m.y, wd.x, wd.y) < 1.2) {
        if (p.hidden && p.hideWardrobe === wd) {
          game.onWardrobeOpened(m, wd); // поймал
        } else {
          game.onWardrobeChecked(m, wd); // пусто — скрип и дальше
          if (!m.checked) m.checked = new Set();
          m.checked.add(wd);
        }
        m.openTargetWardrobe = null;
        m.suspectWardrobe = false;
        m.state = 'search';
        m.searchT = Math.max(m.searchT, 2.5);
        m.waitT = 0.4;
      }
      break;
    }
  }

  // перепрокладка пути при погоне
  m.repathT -= dt;
  if (m.repathT <= 0 && m.target && (m.state === 'chase' || m.state === 'open')) {
    let tx = m.target.x, ty = m.target.y;
    // упреждение: если игрок шумит на бегу, целимся туда, где он будет
    if (m.state === 'chase' && par.lead > 0 && p.moving && !p.hidden) {
      const lead = par.lead * (p.running ? 1 : 0.4);
      const cand = { x: p.x + Math.cos(p.dir) * p.speedNow * lead, y: p.y + Math.sin(p.dir) * p.speedNow * lead };
      if (!game.monsterSolid(Math.floor(cand.x), Math.floor(cand.y))) { tx = cand.x; ty = cand.y; }
    }
    m.path = bfsPath(game.map, m.x, m.y, tx, ty, game.monsterSolid);
    m.pathI = 0;
    m.repathT = 0.55;
  }
}

// ============================= СМОТРИТЕЛЬ ===================================
export function updateWatcher(game, m, dt) {
  const p = game.player;
  const par = game.params.watcher;
  m.alertFlash = Math.max(0, m.alertFlash - dt);

  // --- зрение: узкий луч, стены перекрывают ---
  let sees = false;
  if (!p.hidden && !game.grace) {
    const d = dist(m.x, m.y, p.x, p.y);
    if (d < par.range) {
      const ang = Math.atan2(p.y - m.y, p.x - m.x);
      if (Math.abs(normAngle(ang - m.facing)) < par.half && losClear(game.map, m.x, m.y, p.x, p.y)) {
        sees = true;
      }
    }
  }
  m.seesPlayer = sees;

  if (sees) {
    m.lastSeen = { x: p.x, y: p.y };
    if (m.state !== 'chase') {
      m.alertT += dt;
      m.alertFlash = 0.5;
      if (m.alertT > par.alertTime) { m.state = 'chase'; }
    }
  } else {
    m.alertT = Math.max(0, m.alertT - dt * 2);
  }

  switch (m.state) {
    case 'chase': {
      m.chaseHold = Math.max(0, (m.chaseHold || 0) - dt);
      if (sees) {
        setPathDirect(game, m, p.x, p.y);
        followPath(game, m, par.chase, dt);
        m.facing = m.dir;
      } else if (m.lastSeen) {
        if (!m.target || m.target.x !== m.lastSeen.x) setPath(game, m, m.lastSeen.x, m.lastSeen.y);
        const done = followPath(game, m, par.chase * 0.9, dt);
        m.facing = m.dir;
        // не бросаем цель, пока держится «удержание» — иначе разовая наводка
        // (например, вспышка молнии) схлопывается за один кадр
        if (done && m.chaseHold <= 0) { m.state = 'search'; m.searchT = 5; m.lastSeen = null; }
        else if (done) { m.repathT = 0; }
      } else if (m.chaseHold <= 0) { m.state = 'search'; m.searchT = 5; }
      break;
    }
    case 'search': {
      m.searchT -= dt;
      // стоит и сканирует лучом
      m.facing += par.turnSpeed * 1.6 * m.scanDir * dt;
      if (Math.random() < dt * 0.5) m.scanDir *= -1;
      if (m.searchT <= 0) m.state = 'wander';
      break;
    }
    default: { // wander = патруль
      if (!m.path || m.pathI >= (m.path?.length || 0)) {
        m.waitT -= dt;
        // на точке: медленно водит лучом
        m.facing += par.turnSpeed * m.scanDir * dt;
        if (Math.random() < dt * 0.3) m.scanDir *= -1;
        if (m.waitT <= 0) { pickWanderTarget(game, m); m.waitT = 2 + Math.random() * 3; }
      } else {
        followPath(game, m, par.patrol, dt);
        // луч смотрит по ходу движения, слегка плавает
        m.facing += normAngle(m.dir - m.facing) * Math.min(1, dt * 3);
      }
      break;
    }
  }

  m.repathT -= dt;
  if (m.repathT <= 0 && m.state === 'chase' && m.target) {
    m.path = bfsPath(game.map, m.x, m.y, m.target.x, m.target.y, game.monsterSolid);
    m.pathI = 0; m.repathT = 0.5;
  }
}

function setPathDirect(game, m, tx, ty) {
  // при прямой видимости идём напрямик, без клеточного пути
  if (losClear(game.map, m.x, m.y, tx, ty)) {
    m.target = { x: tx, y: ty };
    m.path = [{ x: tx, y: ty }];
    m.pathI = 0;
  } else {
    setPath(game, m, tx, ty);
  }
}
