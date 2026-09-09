// Загрузка спрайтов из assets/. Файлы уже с альфой, но в них попали
// обрывки подписей с исходных листов — вычищаем, оставляя только самый
// крупный связный объект. Если ассетов нет, игра рисует векторную графику.

const A = 'assets/';
const P = A + 'player/';
const M = A + 'monsters/';

const MANIFEST = {
  // игрок: 4 направления + циклы
  idle_front: P + 'idle/player_idle_front.png',
  idle_back:  P + 'idle/player_idle_back.png',
  // ВНИМАНИЕ: в файлах «слева/справа» — это положение камеры, а не куда смотрит
  // персонаж. На «виде слева» он развёрнут вправо (носок ботинка вправо).
  // Ключи здесь названы по НАПРАВЛЕНИЮ ВЗГЛЯДА, поэтому файлы поменяны местами.
  idle_left:  P + 'idle/player_idle_right.png',
  idle_right: P + 'idle/player_idle_left.png',
  pick_up:    P + 'interactions/player_pick_up.png',
  door_open:  P + 'interactions/player_door_open.png',

  // Слушатель
  L_idle:   M + 'hearing/monster_hearing_idle.png',
  L_front:  M + 'hearing/monster_hearing_front.png',
  L_back:   M + 'hearing/monster_hearing_back.png',
  L_side:   M + 'hearing/monster_hearing_side.png',
  L_listen: M + 'hearing/monster_hearing_listen.png',
  L_turn:   M + 'hearing/monster_hearing_turn.png',
  L_move:   M + 'hearing/monster_hearing_move_to_sound.png',
  L_alert:  M + 'hearing/monster_hearing_alert.png',
  L_attack: M + 'hearing/monster_hearing_attack.png',
  L_scream: M + 'hearing/monster_hearing_scream.png',

  // Смотритель
  W_idle:   M + 'vision/monster_vision_idle.png',
  W_front:  M + 'vision/monster_vision_front.png',
  W_back:   M + 'vision/monster_vision_back.png',
  W_side:   M + 'vision/monster_vision_side.png',
  W_notice: M + 'vision/monster_vision_notice.png',
  W_track:  M + 'vision/monster_vision_track.png',
  W_move:   M + 'vision/monster_vision_move_to_target.png',
  W_alert:  M + 'vision/monster_vision_alert.png',
  W_attack: M + 'vision/monster_vision_attack.png',
  W_scream: M + 'vision/monster_vision_scream.png',
};

const SEQUENCES = {
  walk: { dir: P + 'walk/player_walk_', n: 8, pad: 2, ext: '.png' },
  run:  { dir: P + 'run/player_run_',  n: 6, pad: 2, ext: '.png' },
  crouch: { dir: P + 'crouch/player_crouch_', n: 4, pad: 2, ext: '.png' },
};

export const Sprites = {
  ready: false,
  img: {},
  seq: {},
  missing: [],

  async load() {
    const jobs = [];
    // монстров тянем сильнее игрока: они должны читаться первыми
    const gainFor = n => (n.startsWith('L_') || n.startsWith('W_'))
      ? (n.endsWith('_scream') ? 1.25 : 2.0) : 1.6;
    for (const [name, url] of Object.entries(MANIFEST)) {
      jobs.push(loadClean(url, gainFor(name)).then(c => { if (c) this.img[name] = c; else this.missing.push(name); }));
    }
    for (const [name, s] of Object.entries(SEQUENCES)) {
      this.seq[name] = [];
      for (let i = 1; i <= s.n; i++) {
        const num = String(i).padStart(s.pad, '0');
        const idx = i - 1;
        jobs.push(loadClean(s.dir + num + s.ext, 1.6).then(c => { if (c) this.seq[name][idx] = c; }));
      }
    }
    await Promise.all(jobs);
    for (const k of Object.keys(this.seq)) this.seq[k] = this.seq[k].filter(Boolean);
    this.ready = !!this.img.idle_front || !!this.img.L_idle;
    return this.ready;
  },

  get(name) { return this.img[name] || null; },
  frame(seqName, i) {
    const arr = this.seq[seqName];
    if (!arr || !arr.length) return null;
    return arr[((i % arr.length) + arr.length) % arr.length];
  },

  // Направление -> суффикс спрайта. В экранных координатах Y растёт вниз.
  dirName(dir) {
    const a = ((dir % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (a < Math.PI * 0.25 || a >= Math.PI * 1.75) return 'right';
    if (a < Math.PI * 0.75) return 'front';
    if (a < Math.PI * 1.25) return 'left';
    return 'back';
  },
};

function loadImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function loadClean(url, gain = 1) {
  const img = await loadImage(url);
  if (!img || !img.width) return null;
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  keepLargestBlob(ctx, cv.width, cv.height);
  if (gain !== 1) brighten(ctx, cv.width, cv.height, gain);
  return trim(cv);
}

// Концепты сняты в темноте, а поверх них ложится ещё и слой мрака —
// без подъёма яркости фигуры превращаются в чёрные кляксы.
function brighten(ctx, w, h, gain) {
  const im = ctx.getImageData(0, 0, w, h);
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) {
      const v = d[i + c] / 255;
      // мягкая кривая: тени тянем сильнее, чем света — иначе выгорает
      d[i + c] = Math.min(255, Math.round(255 * Math.pow(v, 1 / gain)));
    }
  }
  ctx.putImageData(im, 0, 0);
}

// Оставляет только самый крупный связный кусок непрозрачных пикселей.
// Так с картинок слетают обрывки подписей и одиночный мусор по краям.
function keepLargestBlob(ctx, w, h) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const ALPHA = 40;
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const stack = [];

  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || d[start * 4 + 3] <= ALPHA) continue;
    const id = sizes.length;
    let count = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      count++;
      const x = i % w, y = (i / w) | 0;
      // 8-связность: диагонали не рвут тонкие детали вроде пальцев
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (label[ni] !== -1 || d[ni * 4 + 3] <= ALPHA) continue;
          label[ni] = id;
          stack.push(ni);
        }
      }
    }
    sizes.push(count);
  }
  if (sizes.length <= 1) return;

  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  // всё, что не главный кусок и заметно мельче его, — стираем
  const cutoff = sizes[best] * 0.25;
  for (let i = 0; i < w * h; i++) {
    const l = label[i];
    if (l !== -1 && l !== best && sizes[l] < cutoff) d[i * 4 + 3] = 0;
  }
  ctx.putImageData(imgData, 0, 0);
}

function trim(cv) {
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = cv;
  const d = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (d[(y * w + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return null;
  const tw = maxX - minX + 1, th = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = tw; out.height = th;
  out.getContext('2d').drawImage(cv, minX, minY, tw, th, 0, 0, tw, th);
  return out;
}
