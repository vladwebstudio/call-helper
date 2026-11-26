/* Рушій правил: текст розмови -> картки (біль / заперечення / сумнів / сигнал) + питання.
 * Працює в браузері і в Node (для тестів). Без ШІ і без мережі.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./patterns.js'));
  else root.Engine = factory(root.PATTERNS);
})(typeof self !== 'undefined' ? self : this, function (P) {

  const MAP = { 'ё': 'е', 'ы': 'и', 'э': 'е', 'і': 'и', 'ї': 'и', 'є': 'е', 'ґ': 'г', 'ъ': '', 'ь': '', "'": '', '’': '', 'ʼ': '', '`': '', '´': '' };

  function normChar(c) {
    c = c.toLowerCase();
    return Object.prototype.hasOwnProperty.call(MAP, c) ? MAP[c] : c;
  }

  /* Нормалізація з картою позицій (щоб знайти цитату в оригіналі) */
  function normMap(raw) {
    let out = ' ';
    const idx = [0];
    for (let i = 0; i < raw.length; i++) {
      let c = normChar(raw[i]);
      if (c === '') continue;
      if (!/[a-zа-яіїєґ0-9Ѐ-ӿ]/i.test(c)) c = ' ';
      if (c === ' ' && out[out.length - 1] === ' ') continue;
      if (c === out[out.length - 1] && /[а-яіїєґ]/.test(c)) continue;   // подвоєні літери (нн, сс) стискаємо: «неуверенность» = «неуверенось»
      out += c; idx.push(i);
    }
    if (out[out.length - 1] !== ' ') { out += ' '; idx.push(raw.length - 1); }
    return { text: out, idx };
  }

  function norm(s) { return normMap(String(s || '')).text; }

  /* Компіляція шаблонів: нормалізуємо літери, "<" = початок слова */
  function compile(src) {
    const n = Array.from(src).map(ch => (ch === '<' ? '\u0001' : (Object.prototype.hasOwnProperty.call(MAP, ch) ? MAP[ch] : ch))).join('').replace(/\u0001/g, '\\s').replace(/([а-яіїєґ])\1+/g, '$1');
    return new RegExp(n, 'i');
  }

  const ITEMS = P.ITEMS.map(it => ({
    ...it,
    re: it.pats.map(compile),
    neg: (it.neg || []).map(compile)
  }));
  const TOPICS = P.TOPICS.map(t => ({ ...t, re: t.pats.map(compile) }));
  const MONEY_RE = new RegExp(Array.from(P.MONEY).map(ch => (Object.prototype.hasOwnProperty.call(MAP, ch) ? MAP[ch] : ch)).join(''), 'ig');

  function words(s) { return norm(s).trim().split(' ').filter(Boolean); }
  function stems(s) { return words(s).filter(w => w.length >= 4).map(w => w.slice(0, 5)); }

  function quoteAt(raw, rawIdx, rawLen) {
    let a = Math.max(0, rawIdx - 55), b = Math.min(raw.length, rawIdx + rawLen + 70);
    while (a > 0 && raw[a] !== ' ') a--;
    while (b < raw.length && raw[b] !== ' ') b++;
    let q = raw.slice(a, b).trim();
    if (a > 0) q = '… ' + q;
    if (b < raw.length) q += ' …';
    return q;
  }

  class Engine {
    constructor(opts) {
      opts = opts || {};
      this.resurfaceMs = opts.resurfaceMs || 90000;
      this.reset();
    }

    reset() {
      this.tail = ' ';           // нормалізований хвіст попередніх шматків
      this.recent = [];          // останні 2 шматки (нормалізовані) для пошуку заданих питань
      this.full = '';            // весь нормалізований текст (для тем)
      this.cards = [];           // {id,kind,title,tip,quote,t,count,lastAt,q:[{text,asked}],dismissed}
      this.topics = {};          // id -> true
      this.money = [];           // [{text,t}]
      this.log = [];             // сирі шматки
    }

    /* Подати новий шматок тексту (t = секунд від початку розмови). Повертає події: [{type,card}] */
    feed(raw, t, now) {
      raw = String(raw || '').trim();
      if (!raw) return [];
      now = now || Date.now();
      this.log.push({ t, text: raw });
      const events = [];

      const nm = normMap(raw);
      const joined = this.tail + nm.text.slice(1);          // хвіст + новий текст
      const base = this.tail.length;                          // все, що закінчується до base, вже було оброблено

      /* 1. Картки */
      for (const it of ITEMS) {
        let best = null;
        for (const re of it.re) {
          const m = re.exec(joined);
          if (!m) continue;
          const end = m.index + m[0].length;
          if (end <= base) continue;                          // повністю в старому хвості
          const win = joined.slice(Math.max(0, m.index - 70), Math.min(joined.length, end + 50));
          if (it.neg.some(n => n.test(win))) continue;        // говорить Влад, а не клієнт
          if (!best || m.index < best.index) best = { index: m.index, len: m[0].length };
        }
        if (!best) continue;

        /* цитата з оригіналу (якщо збіг у новому тексті; інакше беремо весь шматок) */
        let quote = raw.length > 170 ? raw.slice(0, 170) + ' …' : raw;
        const rel = best.index - base + 1;                    // позиція в nm.text
        if (rel >= 0 && rel < nm.idx.length) {
          const rawStart = nm.idx[Math.min(Math.max(rel, 0), nm.idx.length - 1)] || 0;
          quote = quoteAt(raw, rawStart, best.len);
        }

        const existing = this.cards.find(c => c.id === it.id && !c.dismissed);
        if (existing) {
          existing.count += 1;
          if (now - existing.lastAt > this.resurfaceMs) {
            existing.quote = quote; existing.t = t; existing.lastAt = now;
            events.push({ type: 'resurface', card: existing });
          } else {
            existing.lastAt = now;
            events.push({ type: 'bump', card: existing });
          }
        } else {
          const card = {
            id: it.id, kind: it.kind, title: it.title, tip: it.tip || '',
            quote, t, count: 1, lastAt: now, dismissed: false,
            q: it.q.map(x => ({ text: x, asked: false, _s: stems(x) }))
          };
          this.cards.push(card);
          events.push({ type: 'new', card });
        }
      }

      /* 2. Теми (чіпи «Бракує») */
      for (const tp of TOPICS) {
        if (this.topics[tp.id]) continue;
        if (tp.re.some(re => re.test(joined))) { this.topics[tp.id] = true; events.push({ type: 'topic', topic: tp.id }); }
      }

      /* 3. Цифри */
      MONEY_RE.lastIndex = 0;
      let mm;
      while ((mm = MONEY_RE.exec(nm.text)) !== null) {
        const rawI = nm.idx[Math.min(mm.index, nm.idx.length - 1)] || 0;
        const txt = raw.slice(rawI, Math.min(raw.length, rawI + mm[0].length + 6)).trim();
        if (!this.money.some(x => x.text === txt)) { this.money.push({ text: txt, t }); events.push({ type: 'money' }); }
      }

      /* 4. Автовідмітка заданих питань (Влад вимовив питання вголос) */
      const windowWords = new Set(
        (this.recent.join(' ') + ' ' + nm.text).split(' ').filter(w => w.length >= 4).map(w => w.slice(0, 5))
      );
      for (const c of this.cards) {
        if (c.dismissed) continue;
        for (const q of c.q) {
          if (q.asked || !q._s.length) continue;
          let hit = 0;
          for (const s of q._s) if (windowWords.has(s)) hit++;
          if (hit >= Math.max(3, Math.ceil(q._s.length * 0.6))) { q.asked = true; q.auto = true; events.push({ type: 'asked', card: c, q }); }
        }
      }

      this.full += nm.text;
      this.tail = joined.slice(-160);
      this.recent.push(nm.text); if (this.recent.length > 2) this.recent.shift();
      return events;
    }

    visible() { return this.cards.filter(c => !c.dismissed); }

    missingTopics() { return TOPICS.filter(t => !this.topics[t.id]).map(t => ({ id: t.id, label: t.label })); }
    allTopics() { return TOPICS.map(t => ({ id: t.id, label: t.label, done: !!this.topics[t.id] })); }

    summary(elapsedSec) {
      const mins = Math.round((elapsedSec || 0) / 60);
      const kinds = { pain: 'Болі', objection: 'Заперечення', doubt: 'Сумніви', signal: 'Сигнали' };
      let s = `# Підсумок розмови (${mins} хв)\n\n`;
      for (const k of Object.keys(kinds)) {
        const list = this.visible().filter(c => c.kind === k);
        if (!list.length) continue;
        s += `## ${kinds[k]}\n`;
        for (const c of list) {
          s += `- **${c.title}**${c.count > 1 ? ` (×${c.count})` : ''}: «${c.quote}»\n`;
          const notAsked = c.q.filter(q => !q.asked).map(q => q.text);
          if (notAsked.length) s += `  - Не заданo: ${notAsked.join(' / ')}\n`;
        }
        s += '\n';
      }
      if (this.money.length) s += `## Цифри\n${this.money.map(m => '- ' + m.text).join('\n')}\n\n`;
      const miss = this.missingTopics().map(t => t.label);
      if (miss.length) s += `## Не з'ясовано\n${miss.join(', ')}\n`;
      return s.trim() + '\n';
    }
  }

  return { Engine, norm, stems, ITEMS, TOPICS };
});
