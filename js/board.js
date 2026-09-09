// «Те, кто заходил до тебя» — фейковый лидерборд.
// Правила из плана: записи подстраиваются под рекорд игрока, кто-то всегда
// на пару этажей выше, верхние 2–3 недосягаемы, первые забеги гарантированно
// бьют несколько строчек.

const TOP = [
  { name: 'тот, кто не вышел', floors: 66 },
  { name: 'Р. Кассандров', floors: 51 },
  { name: 'жилец из 4Б', floors: 44 },
];

const NAMES = [
  'Оля, 2019', 'предыдущий', 'Марат С.', 'настя :3', 'кто-то без имени',
  'сосед снизу', 'Витя, не ищи', 'последний из 7А', 'гость', 'она',
  'двое (вместе)', 'Т.', 'шумный', 'босиком', 'сторож', 'мальчик с 3 этажа',
  'та, что смеялась', 'без ботинок', 'ушёл в стену', 'Гриша (почти)',
];

// Генерирует/обновляет строки под рекорд игрока. Имена стабильны в сейве.
export function buildBoard(save) {
  const best = save.basementBest || 0;
  if (!save.boardNames) {
    const pool = NAMES.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    save.boardNames = pool.slice(0, 9);
  }
  const rows = TOP.map(t => ({ ...t, top: true }));
  const n = save.boardNames.length;
  save.boardNames.forEach((name, i) => {
    let floors;
    if (i === 0) floors = best + 2 + Math.floor(Math.random() * 2); // всегда есть куда тянуться
    else if (i === 1 && best >= 2) floors = best + 1;
    else {
      // разброс ниже рекорда; для новичка — нули и единицы, чтобы было кого обойти
      const cap = Math.max(1, best);
      floors = Math.floor(Math.pow((n - i) / n, 1.6) * cap);
      if (best === 0) floors = i < 4 ? 1 : 0;
    }
    rows.push({ name, floors, top: false });
  });
  rows.sort((a, b) => b.floors - a.floors);
  return rows;
}

// Кого обошли этим забегом (для «какой ты молодец»).
export function beatenBy(rows, oldBest, newBest) {
  if (newBest <= oldBest) return [];
  return rows.filter(r => !r.top && r.floors >= oldBest && r.floors < newBest).map(r => r.name);
}

export function renderBoard(container, rows, playerBest, playerHasRun) {
  container.innerHTML = '';
  const all = rows.slice();
  if (playerHasRun) all.push({ name: 'ТЫ', floors: playerBest, me: true });
  all.sort((a, b) => b.floors - a.floors || (a.me ? 1 : -1));
  for (const r of all) {
    const div = document.createElement('div');
    div.className = 'brow' + (r.me ? ' me' : '') + (r.top ? ' top' : '');
    const fl = r.floors === 0 ? 'не дошёл' : `этаж ${r.floors}`;
    div.innerHTML = `<span class="nm"></span><span class="fl"></span>`;
    div.querySelector('.nm').textContent = r.name;
    div.querySelector('.fl').textContent = fl;
    container.appendChild(div);
  }
  if (!playerHasRun) {
    const div = document.createElement('div');
    div.className = 'brow me';
    div.innerHTML = `<span class="nm">ТЫ</span><span class="fl">ещё наверху</span>`;
    container.appendChild(div);
  }
}
