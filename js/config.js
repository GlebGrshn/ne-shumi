// Кривая сложности. Самая хрупкая часть игры — трогать по одному числу за раз.

export const PLAYER = {
  r: 0.30,
  walkSpeed: 2.55,
  runSpeed: 5.2,
  // шум: радиусы слышимости действий (в клетках, до затухания стенами)
  noiseRun: 8.0,
  noiseWalk: 1.7,
  noiseWardrobe: 3.5,
  noiseKey: 1.2,
  noiseCreak: 6.5,      // скрипучая половица — громче обычного шага
  noisePant: 4.2,       // загнанное дыхание, когда выдохся
  stepIntervalWalk: 0.46,
  stepIntervalRun: 0.27,
  // выносливость: бежать бесконечно нельзя
  staminaMax: 4.2,
  staminaDrain: 1.0,
  staminaRegenWalk: 0.34,
  staminaRegenStand: 0.85,
  staminaReady: 1.2,
  pantInterval: 1.15,
  pantDuration: 4.0,
};

export const VISION = {
  coneRange: 7.0,
  coneHalf: 0.62,
  ambient: 3.4,
  memoryAlpha: 0.13,
};

// Насыщающаяся кривая 0..1: быстро растёт в начале и упирается в потолок.
// Благодаря ей 40-я ночь тяжелее 8-й, но игра остаётся проходимой.
const sat = (x, half) => (x <= 0 ? 0 : x / (x + half));

// ---------------------------------------------------------- модификаторы
// С 4-й ночи дом каждый раз ведёт себя по-своему. Выбор детерминированный:
// одна и та же ночь всегда одинаковая, но подряд одно и то же не повторяется.
export const MODIFIERS = {
  none: { id: 'none', name: '', desc: '' },
  storm: {
    id: 'storm', name: 'ГРОЗА',
    desc: 'Гром глушит твои шаги.\nНо вспышка молнии выдаёт тебя тому, кто видит.',
  },
  blackout: {
    id: 'blackout', name: 'ТЕМНО',
    desc: 'Фонарь почти сдох — светит вдвое ближе.\nЗато и они бродят медленнее.',
  },
  draft: {
    id: 'draft', name: 'СКВОЗНЯК',
    desc: 'Дом скрипит сам по себе.\nОн будет ходить на чужие звуки — если повезёт.',
  },
  twins: {
    id: 'twins', name: 'ИХ ДВОЕ',
    desc: 'Сегодня слушают в четыре уха.',
  },
  silence: {
    id: 'silence', name: 'ТИШИНА',
    desc: 'Музыка кончилась. Слышно только тебя.\nИ его.',
  },
};

// Мягкие модификаторы идут раньше, злые открываются позже.
const MOD_EARLY = ['draft', 'storm', 'blackout'];          // с 4-й ночи
const MOD_LATE = ['draft', 'storm', 'blackout', 'twins', 'silence']; // с 7-й

const modCache = new Map();

export function modifierFor(n) {
  if (n < 4) return MODIFIERS.none;
  if (n === 5) return MODIFIERS.none;   // ночь шкафа-предателя должна быть чистой
  if (modCache.has(n)) return modCache.get(n);

  let res;
  // каждая третья ночь — без модификатора, иначе приёмы превращаются в кашу
  if ((n - 4) % 3 === 2) {
    res = MODIFIERS.none;
  } else {
    const pool = n >= 7 ? MOD_LATE : MOD_EARLY;
    // предыдущий ненулевой — чтобы не повторяться подряд
    let prev = null;
    for (let k = n - 1; k >= 4 && k >= n - 4; k--) {
      const m = modifierFor(k);
      if (m.id !== 'none') { prev = m.id; break; }
    }
    let i = (n * 5 + ((n / 3) | 0)) % pool.length;
    if (pool[i] === prev) i = (i + 1) % pool.length;
    res = MODIFIERS[pool[i]];
  }
  modCache.set(n, res);
  return res;
}

// Параметры ночи n (1..∞). Для подвала floor >= 1.
export function nightParams(n, basementFloor = 0) {
  const f = basementFloor;
  // прогресс по ночам и отдельно по этажам подвала
  const k = sat(n - 1, 4.5);            // n=1:0  n=8:0.61  n=20:0.81  n=60:0.93
  const bf = sat(f, 14);                // подвал добавляет сверх ночей
  const t = Math.min(0.97, k + bf * 0.45);

  const mod = f > 0 ? MODIFIERS.none : modifierFor(n);

  const p = {
    night: n,
    basement: f > 0,
    floor: f,
    mod,
    w: Math.round(Math.min(48, 26 + t * 26)),
    h: Math.round(Math.min(36, 19 + t * 19)),
    keys: Math.min(7, 2 + Math.round(t * 5.2)),
    // укрытий тоже становится больше — иначе поздние ночи превращаются в лотерею
    wardrobes: Math.round(6 + t * 12),
    creaks: Math.round(6 + t * 40),
    traitor: n === 5 && f === 0,
    traitorChance: f > 0 ? 0.18 : (n > 8 ? 0.22 : 0),
    listener: {
      wander: 1.75 + t * 0.75,
      investigate: 3.1 + t * 1.1,
      // потолок 5.05 против бега 5.2: догнать почти можно, но не мгновенно
      chase: Math.min(5.05, 4.15 + t * 1.15),
      hearMult: Math.min(1.65, 0.88 + t * 0.9),
      proximity: 1.25,
      lead: Math.min(0.6, t * 0.75),
      checkWardrobes: n >= 3 || f > 0,
    },
    watcher: (n >= 6 || f > 0) ? {
      patrol: 1.45 + t * 0.35,
      chase: Math.min(5.0, 4.5 + t * 0.6),
      range: Math.min(15, 10.5 + t * 5.5),
      half: 0.28,
      turnSpeed: 1.0 + t * 0.7,
      alertTime: Math.max(0.18, 0.45 - t * 0.3),
    } : null,
    // три жизни в начале, две дальше; ниже двух не опускаемся никогда
    lives: (n >= 6 || f > 0) ? 2 : 3,
  };

  // второй Слушатель вместо Смотрителя
  p.twinListener = mod.id === 'twins';

  if (mod.id === 'blackout') {
    p.visionScale = 0.55;
    p.listener.wander *= 0.8;
    p.listener.investigate *= 0.85;
    p.listener.chase *= 0.92;
    if (p.watcher) { p.watcher.range *= 0.7; p.watcher.patrol *= 0.85; }
  } else {
    p.visionScale = 1;
  }

  if (f > 0) {
    p.wardrobes = Math.max(10, p.wardrobes);
  }
  return p;
}

export const ADS = {
  interstitialInterval: 90,
  transitionMin: 45,
  calmDistance: 3,
  keyPingCooldown: 60,
  keyPingDuration: 5,
};

// Сюжетные тексты первых восьми ночей. Дальше — «дом не отпускает».
export const NIGHT_TEXTS = {
  1: 'Он слепой. Он слышит.\nШаг — тихо. Бег — как крик.\nСобери ключи и найди дверь.',
  2: 'Дверь за спиной оказалась не выходом.\nДыхание тоже слышно — отдышись стоя, так быстрее.',
  3: 'Он больше не верит шкафам.\nЕсли ищет рядом — откроет и посмотрит.',
  4: 'Дом стал больше. Половицы — старее.',
  5: 'Шкафы прячут.\nПочти все.',
  6: 'Их теперь двое. Второй не слышит вообще ничего.\nЗато смотрит. Не попадай в луч.\nЖизни только две.',
  7: 'Он выучил, как ты бегаешь.\nТеперь он бежит не за тобой, а туда, где ты будешь.',
  8: 'Восьмая дверь. За ней должно быть утро.',
};

export function nightText(n) {
  if (NIGHT_TEXTS[n]) return NIGHT_TEXTS[n];
  const late = [
    'Дом не отпустил. Комнаты снова другие.',
    'Ты уже не считаешь двери. Он тоже не считает.',
    'Каждая ночь — тот же дом, но он помнит больше.',
    'Утро не наступает. Ключи всё те же.',
    'Ты знаешь этот дом наизусть. Это не помогает.',
  ];
  return late[(n - 9) % late.length];
}
