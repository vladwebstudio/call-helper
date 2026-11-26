// Прогін рушія по текстових розшифровках: node engine-test.mjs файл1.txt файл2.txt ...
// Рядки у форматі "[мм:сс] текст" або "[г:мм:сс] текст". Розмови в репозиторій не кладемо (персональні дані).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Engine } = require('../../docs/engine.js');

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const verbose = process.argv.includes('--v');
if (!files.length) { console.log('Вкажи файли розмов'); process.exit(1); }

function toSec(ts) { const p = ts.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; }

const total = {};
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n').map(l => l.match(/^\[([\d:]+)\]\s*(.*)$/)).filter(Boolean).map(m => ({ t: toSec(m[1]), s: m[2] }));
  const eng = new Engine();
  // шматки по ~5 секунд
  let chunk = '', start = lines[0]?.t || 0, now = 0;
  const flush = (t) => { if (chunk.trim()) { now = t * 1000; eng.feed(chunk, t, now); } chunk = ''; };
  for (const l of lines) { if (l.t - start >= 5) { flush(l.t); start = l.t; } chunk += ' ' + l.s; }
  flush(lines.at(-1)?.t || 0);
  console.log(`\n=== ${f.split('/').pop()}  (${lines.length} рядків)`);
  const byKind = {};
  for (const c of eng.visible()) {
    byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    total[c.id] = (total[c.id] || 0) + 1;
    console.log(`  [${c.kind.padEnd(9)}] ${c.title}  ×${c.count}${verbose ? '\n      «' + c.quote + '»' : ''}`);
  }
  console.log('  Теми:', eng.allTopics().map(t => (t.done ? '✓' : '·') + t.label).join('  '));
  console.log('  Цифри:', eng.money.slice(0, 8).map(m => m.text).join(' | '));
}
console.log('\n=== Скільки розмов (із ' + files.length + ') спрацював кожен пункт');
Object.entries(total).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k.padEnd(16) + v));
