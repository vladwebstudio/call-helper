/* Помічник розмови: мікрофон -> WAV 16 кГц по 5 с -> /api/transcribe -> рушій правил -> картки.
 * Нічого не зберігається: «Завершити» повністю очищає стан.
 */
(function () {
  'use strict';

  const SEG_S = 5;             // довжина шматка, секунд
  const SILENCE = 0.004;       // нижче цього рівня шматок вважається тишею і не відправляється
  const MAX_QUEUE = 3;         // якщо сервер не встигає: старі шматки відкидаємо, щоб підказки були «зараз»

  const $ = (s) => document.querySelector(s);
  const KINDS = PATTERNS.KINDS;
  const engine = new Engine.Engine();

  const S = {
    live: false, paused: false, demo: false,
    t0: 0, pausedAt: 0, pausedTotal: 0,
    newestTop: true,
    stream: null, ctx: null, proc: null, src: null, chunks: [], samples: 0, sr: 48000,
    queue: [], busy: false, behind: false,
    wake: null, timer: null, demoTimers: [], shown: new Map()
  };

  /* ---------- допоміжне ---------- */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mmss = (sec) => { sec = Math.max(0, Math.floor(sec)); return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); };
  const elapsed = () => S.live ? ((S.paused ? S.pausedAt : performance.now()) - S.t0 - S.pausedTotal) / 1000 : 0;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hide');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hide'), ms || 2200);
  }

  /* ---------- перевірка сервера ---------- */
  async function ping() {
    const set = (id, ok, text) => { const li = $(id); li.className = ok ? 'ok' : 'bad'; li.querySelector('span').textContent = text; };
    try {
      const r = await fetch('/api/ping', { cache: 'no-store' });
      const j = await r.json();
      set('#st-net', true, 'Сервер працює');
      set('#st-stt', !!j.stt, j.stt ? 'Розпізнавання мови: готово (' + j.provider + ')' : 'Розпізнавання мови не підключене');
      $('#idle-msg').textContent = j.stt ? '' : (j.hint || '');
    } catch (e) {
      set('#st-net', false, 'Немає зв\'язку із сервером'); set('#st-stt', false, 'Запусти start.command');
    }
    const sec = $('#st-sec');
    if (!window.isSecureContext) { sec.classList.remove('hide'); sec.className = 'bad'; sec.querySelector('span').textContent = 'Мікрофон потребує https або localhost'; }
  }

  /* ---------- екрани ---------- */
  function show(id) { ['#screen-idle', '#screen-live'].forEach((s) => $(s).classList.toggle('hide', s !== id)); window.scrollTo(0, 0); }

  /* ---------- рендер ---------- */
  function render() {
    const list = engine.visible().slice();
    list.sort((a, b) => (S.shown.get(b.id) || 0) - (S.shown.get(a.id) || 0));
    if (!S.newestTop) list.reverse();
    $('#empty').classList.toggle('hide', list.length > 0);
    $('#cards').innerHTML = list.map((c) => {
      const k = KINDS[c.kind];
      const fresh = c._fresh ? ' fresh' : ''; c._fresh = false;
      return `<article class="card k-${c.kind}${fresh}" data-id="${c.id}">
        <div class="c-top"><span class="tag">${k.label}</span><span class="meta">${mmss(c.t)}${c.count > 1 ? ' · ×' + c.count : ''}</span><button class="x" data-act="x" aria-label="Прибрати">✕</button></div>
        <h2>${esc(c.title)}</h2>
        <p class="quote">«${esc(c.quote)}»</p>
        ${c.tip ? `<p class="tip"><b>Як відповісти:</b> ${esc(c.tip)}</p>` : ''}
        <ul class="qs">${c.q.map((q, i) => `<li><button class="q${q.asked ? ' asked' : ''}${q.auto ? ' auto' : ''}" data-act="q" data-i="${i}"><i></i><span>${esc(q.text)}</span></button></li>`).join('')}</ul>
      </article>`;
    }).join('');
    renderTopics();
  }

  function renderTopics() {
    const t = engine.allTopics().map((x) => `<span class="chip${x.done ? ' done' : ''}">${esc(x.label)}</span>`).join('');
    const m = engine.money.slice(-3).map((x) => `<span class="chip money">${esc(x.text)}</span>`).join('');
    $('#topics').innerHTML = t + m;
  }

  function addTranscript(text, t) {
    const body = $('#tr-body');
    const p = document.createElement('p');
    p.innerHTML = `<time>${mmss(t)}</time>${esc(text)}`;
    body.appendChild(p); body.scrollTop = body.scrollHeight;
    $('#line').textContent = text;
  }

  function handleEvents(events) {
    let changed = false, loud = false;
    for (const e of events) {
      if (e.type === 'new' || e.type === 'resurface') { S.shown.set(e.card.id, Date.now()); e.card._fresh = true; loud = true; changed = true; }
      else if (e.type === 'bump' || e.type === 'asked' || e.type === 'topic' || e.type === 'money') changed = true;
    }
    if (changed) render();
    if (loud && navigator.vibrate) navigator.vibrate(45);
  }

  /* ---------- розпізнавання ---------- */
  function ingest(text, t) {
    if (!text) return;
    addTranscript(text, t);
    handleEvents(engine.feed(text, t, Date.now()));
  }

  async function pump() {
    if (S.busy || !S.queue.length || !S.live) return;
    S.busy = true;
    const job = S.queue.shift();
    try {
      const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: job.blob });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      if (S.live) ingest(j.text, job.t);
    } catch (e) {
      $('#line').textContent = 'Помилка розпізнавання: ' + e.message;
    } finally {
      S.busy = false;
      if (S.queue.length) pump();
    }
  }

  function enqueue(blob, t) {
    S.queue.push({ blob, t });
    while (S.queue.length > MAX_QUEUE) { S.queue.shift(); S.behind = true; }
    if (S.behind) { $('#line').textContent = 'Сервер не встигає, частину мови пропущено'; S.behind = false; }
    pump();
  }

  /* ---------- мікрофон -> WAV ---------- */
  function floatTo16kWav(chunks, srcRate) {
    let n = 0; chunks.forEach((c) => (n += c.length));
    const all = new Float32Array(n); let o = 0; chunks.forEach((c) => { all.set(c, o); o += c.length; });
    let sum = 0; for (let i = 0; i < n; i += 4) sum += all[i] * all[i];
    const rms = Math.sqrt(sum / (n / 4));
    const ratio = srcRate / 16000, outLen = Math.floor(n / ratio);
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(n - 1, i0 + 1), f = pos - i0;
      const v = Math.max(-1, Math.min(1, all[i0] * (1 - f) + all[i1] * f));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    w(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return { blob: new Blob([buf], { type: 'audio/wav' }), rms };
  }

  async function startMic() {
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    S.ctx = new AC(); S.sr = S.ctx.sampleRate;
    if (S.ctx.state === 'suspended') await S.ctx.resume();
    S.src = S.ctx.createMediaStreamSource(S.stream);
    S.proc = S.ctx.createScriptProcessor(4096, 1, 1);
    const mute = S.ctx.createGain(); mute.gain.value = 0;
    S.src.connect(S.proc); S.proc.connect(mute); mute.connect(S.ctx.destination);
    S.chunks = []; S.samples = 0; let segStart = 0;
    S.proc.onaudioprocess = (e) => {
      if (!S.live || S.paused) return;
      const d = new Float32Array(e.inputBuffer.getChannelData(0));
      let s = 0; for (let i = 0; i < d.length; i += 8) s += d[i] * d[i];
      $('#mic-lvl').style.width = Math.min(100, Math.sqrt(s / (d.length / 8)) * 900) + '%';
      if (S.samples === 0) segStart = elapsed();
      S.chunks.push(d); S.samples += d.length;
      if (S.samples >= S.sr * SEG_S) {
        const { blob, rms } = floatTo16kWav(S.chunks, S.sr);
        S.chunks = []; S.samples = 0;
        if (rms >= SILENCE) enqueue(blob, segStart);
      }
    };
  }

  function stopMic() {
    try { S.proc && (S.proc.onaudioprocess = null, S.proc.disconnect()); } catch (e) {}
    try { S.src && S.src.disconnect(); } catch (e) {}
    try { S.stream && S.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { S.ctx && S.ctx.close(); } catch (e) {}
    S.proc = S.src = S.stream = S.ctx = null; S.chunks = []; S.samples = 0;
  }

  async function lockScreen() { try { if (navigator.wakeLock) S.wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
  function unlockScreen() { try { S.wake && S.wake.release(); } catch (e) {} S.wake = null; }
  document.addEventListener('visibilitychange', () => {
    if (!S.live) return;
    if (document.visibilityState === 'visible') { lockScreen(); if (S.ctx && S.ctx.state === 'suspended') S.ctx.resume(); }
  });

  /* ---------- життєвий цикл розмови ---------- */
  function resetUI() {
    engine.reset(); S.shown.clear(); S.queue = []; S.busy = false;
    $('#cards').innerHTML = ''; $('#tr-body').innerHTML = ''; $('#line').textContent = 'Чекаю на мову…';
    $('#empty').classList.remove('hide'); $('#mic-lvl').style.width = '0';
    $('#btn-pause').textContent = 'Пауза'; $('#rec').classList.remove('off');
    renderTopics();
  }

  function begin() {
    resetUI();
    S.live = true; S.paused = false; S.pausedTotal = 0; S.t0 = performance.now();
    show('#screen-live');
    clearInterval(S.timer); S.timer = setInterval(() => { $('#timer').textContent = mmss(elapsed()); }, 500);
    $('#timer').textContent = '00:00';
    lockScreen();
  }

  async function startCall() {
    if (!window.isSecureContext || !navigator.mediaDevices) { $('#idle-msg').textContent = 'Мікрофон працює тільки через https або localhost. На телефоні відкрий адресу з https://.'; return; }
    try { begin(); await startMic(); }
    catch (e) { S.live = false; show('#screen-idle'); $('#idle-msg').textContent = 'Немає доступу до мікрофона: ' + e.message; stopMic(); clearInterval(S.timer); unlockScreen(); }
  }

  function endCall() {
    S.live = false; S.demo = false;
    S.demoTimers.forEach(clearTimeout); S.demoTimers = [];
    clearInterval(S.timer); stopMic(); unlockScreen();
    resetUI();                       // повне очищення: нічого не зберігаємо
    show('#screen-idle'); ping();
  }

  /* ---------- демо ---------- */
  const DEMO = [
    [1, 'Добрий день, мене звати Оксана, я викладаю шахи дітям.'],
    [5, 'Реклама в мене не працює, толку нуль, ліди дорогі і не купують.'],
    [10, 'Клієнтів мало, так, вони не записуються на заняття.'],
    [16, 'І ще я працюю в іншій школі, часу майже немає, дитина вдома.'],
    [22, 'Я ніколи не знімала відео, соромлюсь камери.'],
    [28, 'Ну і скільки це коштує, яка вартість?'],
    [34, 'Мені дорого, думала буде в районі півтори тисячі.'],
    [40, 'Мені треба подумати, переспати з цією думкою.'],
    [46, 'Потрібно порадитись з чоловіком.'],
    [52, 'А якщо не вийде, ви гарантуєте результат?'],
    [58, 'Чи можна оплатити частинами?']
  ];
  function startDemo() {
    begin(); S.demo = true;
    $('#line').textContent = 'Демо: фрази подаються без мікрофона';
    DEMO.forEach(([sec, text]) => S.demoTimers.push(setTimeout(() => { if (S.live) ingest(text, elapsed()); }, sec * 1000)));
  }

  /* ---------- кнопки ---------- */
  $('#btn-new').onclick = startCall;
  $('#btn-demo').onclick = startDemo;
  $('#btn-end').onclick = () => $('#sheet').classList.remove('hide');
  $('#sh-cancel').onclick = () => $('#sheet').classList.add('hide');
  $('#sh-end').onclick = () => { $('#sheet').classList.add('hide'); endCall(); toast('Готово, усе очищено'); };
  $('#sh-copy').onclick = async () => {
    const txt = engine.summary(elapsed());
    try { await navigator.clipboard.writeText(txt); toast('Підсумок скопійовано'); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Підсумок скопійовано'); } catch (_) { toast('Не вдалось скопіювати'); } ta.remove(); }
  };
  $('#btn-pause').onclick = () => {
    if (!S.live) return;
    S.paused = !S.paused;
    if (S.paused) { S.pausedAt = performance.now(); S.chunks = []; S.samples = 0; }
    else S.pausedTotal += performance.now() - S.pausedAt;
    $('#btn-pause').textContent = S.paused ? 'Далі' : 'Пауза';
    $('#rec').classList.toggle('off', S.paused);
    $('#line').textContent = S.paused ? 'Пауза' : 'Слухаю…';
  };
  $('#btn-order').onclick = () => { S.newestTop = !S.newestTop; $('#btn-order').textContent = S.newestTop ? '↑ нові' : '↓ нові'; render(); };

  $('#cards').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]'); if (!btn) return;
    const card = engine.cards.find((c) => c.id === btn.closest('.card').dataset.id && !c.dismissed); if (!card) return;
    if (btn.dataset.act === 'x') card.dismissed = true;
    else { const q = card.q[+btn.dataset.i]; q.asked = !q.asked; q.auto = false; }
    render();
  });

  ping();
  setInterval(() => { if (!S.live) ping(); }, 8000);
})();
