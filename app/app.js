/* Training Tracker — offline-first PWA client
 *
 * Everything the app shows lives in localStorage:
 *   tt.snapshot   last full `bootstrap` response from the Apps Script backend
 *   tt.sessions   sessions logged on this device (each exercise flagged synced/unsynced)
 *   tt.outbox     queued non-session mutations (plan status, strength start)
 *   tt.meta       lastPull / lastPush timestamps
 *
 * Sync = push unsynced sessions & outbox → pull a fresh snapshot → reconcile.
 * Every write carries a client-generated id so retries never duplicate rows.
 */
(function () {
  'use strict';

  // ============================================================
  // UTILS
  // ============================================================
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MON3 = MONTHS.map((m) => m.slice(0, 3));
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayIso() { return isoOf(new Date()); }
  function dateOf(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
  function fmtShort(iso) { if (!iso) return ''; const d = dateOf(iso); return MON3[d.getMonth()] + ' ' + d.getDate(); }
  function fmtLong(iso) { if (!iso) return ''; const d = dateOf(iso); return DOW[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate(); }
  function addDays(iso, n) { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d); }
  function mondayOf(iso) { const d = dateOf(iso); const off = (d.getDay() + 6) % 7; d.setDate(d.getDate() - off); return isoOf(d); }
  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  const STREAK_MIN = 2;                 // sessions per week needed to keep the streak
  const exKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  let toastTimer;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2200);
  }

  // ============================================================
  // STORE
  // ============================================================
  const Store = {
    get(k, def) { try { const v = localStorage.getItem('tt.' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem('tt.' + k, JSON.stringify(v)); } catch (e) { toast('Storage full — export & clear cache'); } },
    del(k) { localStorage.removeItem('tt.' + k); }
  };
  let apiUrl = Store.get('apiUrl', '');
  let snapshot = Store.get('snapshot', null);
  let sessions = Store.get('sessions', []);          // local sessions
  let outbox = Store.get('outbox', []);
  let meta = Store.get('meta', { lastPull: 0, lastPush: 0 });
  const saveSessions = () => Store.set('sessions', sessions);
  const saveOutbox = () => Store.set('outbox', outbox);
  const saveMeta = () => Store.set('meta', meta);

  // ============================================================
  // CLASSIFY / PARSE (mirrors the backend)
  // ============================================================
  const TYPE_KEYWORDS = {
    cardio: ['run', 'jog', 'cycle', 'bike', 'cardio', 'treadmill', 'rowing', 'elliptical', 'swim', 'walk'],
    legs: ['squat', 'leg press', 'leg ext', 'leg curl', 'calf', 'lunge', 'hip', 'glute', 'abduct', 'adduct', 'rdl', 'deadlift', 'step up', 'step down', 'tib raise'],
    push: ['bench', 'chest press', 'shoulder press', 'tricep', 'lateral raise', 'overhead press', 'ohp', 'push', 'dip', 'db press', 'incline press', 'decline press', 'military press', 'fly', 'flye', 'skull crusher', 'pushdown'],
    pull: ['pull', 'row', 'chin', 'lat pulldown', 'curl', 'face pull', 'rear delt', 'shrug', 'bicep', 'hammer', 'preacher', 'back extension']
  };
  const kwHit = (text, kws) => kws.some((k) => new RegExp('(^|[^a-z])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text));
  function classify(name) {
    const n = String(name || '').toLowerCase();
    if (kwHit(n, ['lunge'])) return 'legs';
    for (const t of ['cardio', 'legs', 'push', 'pull']) if (kwHit(n, TYPE_KEYWORDS[t])) return t;
    return 'other';
  }
  const isCompound = (name) => kwHit(String(name || '').toLowerCase(), ['bench', 'squat', 'deadlift', 'row', 'pull up', 'pulldown', 'chin', 'overhead press', 'ohp', 'shoulder press', 'chest press', 'leg press', 'rdl', 'incline press']);
  const restFor = (name) => (isCompound(name) ? 240 : 120);

  // "W:14.5x10, 19.5x8, 24.5x8x2, x5" → [{weight, reps, count, warmup}]
  function parseSets(str) {
    const out = [];
    let lastW = null;
    String(str || '').replace(/\([^)]*\)/g, '').split(/[,;]/).forEach((tok) => {
      tok = tok.trim(); if (!tok) return;
      const warm = /^w\s*:/i.test(tok);
      tok = tok.replace(/^w\s*:/i, '').trim();
      let m = tok.match(/^(bw|\d+(?:\.\d+)?)\s*x\s*(\d+)(?:\s*x\s*(\d+))?/i);
      if (m) {
        const w = /^bw/i.test(m[1]) ? 0 : parseFloat(m[1]);
        lastW = w;
        out.push({ weight: w, reps: +m[2], count: m[3] ? +m[3] : 1, warmup: warm });
        return;
      }
      m = tok.match(/^x\s*(\d+)(?:\s*x\s*(\d+))?/i);        // "x5" continues previous weight
      if (m && lastW != null) out.push({ weight: lastW, reps: +m[1], count: m[2] ? +m[2] : 1, warmup: warm });
    });
    return out;
  }
  function topSet(str) {
    const s = parseSets(str).filter((x) => !x.warmup && x.reps > 0);
    if (!s.length) return null;
    return s.reduce((a, b) => (b.weight > a.weight ? b : a));
  }
  function parseRun(text) {
    const s = String(text || '');
    const mk = s.match(/(\d+(?:[.,]\d+)?)\s*k(?:m)?\b/i);
    const mp = s.match(/@\s*(?:pace\s*)?(\d{1,2})[.:'](\d{2})\b/i);
    return { km: mk ? parseFloat(mk[1].replace(',', '.')) : null, pace: mp ? mp[1] + ':' + mp[2] : '', paceSec: mp ? +mp[1] * 60 + +mp[2] : null };
  }
  function parseRange(setsReps) {           // "2 × 5-7" → {sets:2, lo:5, hi:7}
    const m = String(setsReps || '').match(/(\d+)\s*[×x]\s*(\d+)(?:\s*[-–]\s*(\d+))?/);
    return m ? { sets: +m[1], lo: +m[2], hi: m[3] ? +m[3] : +m[2] } : null;
  }
  function parseIncrement(inc) {            // "+2.5 kg" → 2.5 ; "+1 pin" → null (unknown kg)
    const s = String(inc || '');
    if (/pin/i.test(s)) return null;
    const m = s.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  // ============================================================
  // MERGED DATA (snapshot + local)
  // ============================================================
  const Data = {
    strengthByKey() {
      const m = {};
      ((snapshot && snapshot.strengthPlan) || []).forEach((p) => { m[exKey(p.exercise)] = p; });
      return m;
    },
    // Exercise map: snapshot exercises + rows from local sessions the server hasn't returned yet.
    exercises() {
      const map = {};
      const seenRow = new Set();
      ((snapshot && snapshot.exercises) || []).forEach((e) => {
        const k = e.key || exKey(e.name);
        map[k] = { key: k, name: e.name, type: e.type, restSec: e.restSec, history: e.history.slice(), strength: e.strength || null, aliases: e.aliases || [e.name] };
        e.history.forEach((h) => { if (h.clientId) seenRow.add(h.clientId); });
      });
      const strength = this.strengthByKey();
      sessions.forEach((s) => s.exercises.forEach((x) => {
        if (seenRow.has(x.clientId)) return;
        const k = exKey(x.exercise);
        if (!map[k]) map[k] = { key: k, name: x.exercise, type: classify(x.exercise), restSec: restFor(x.exercise), history: [], strength: strength[k] || null, aliases: [x.exercise] };
        map[k].history.unshift({ iso: s.iso, date: fmtShort(s.iso), exercise: x.exercise, sets: x.sets, notes: x.notes, sessionType: s.sessionType, local: true, pending: !x.synced });
      }));
      Object.values(map).forEach((e) => e.history.sort((a, b) => (b.iso || '').localeCompare(a.iso || '')));
      return map;
    },
    exerciseList() { return Object.values(this.exercises()).sort((a, b) => a.name.localeCompare(b.name)); },
    // Sessions, newest first. A local session replaces the server copy with the same clientId.
    sessions() {
      const localIds = new Set(sessions.map((s) => s.clientId));
      const out = ((snapshot && snapshot.sessions) || [])
        .filter((s) => !(s.clientId && localIds.has(s.clientId)))
        .map((s) => ({ iso: s.iso, sessionType: s.sessionType, label: s.sessionLabel, rows: s.rows || s.exercises.map((n) => ({ exercise: n })), local: false, pending: 0, startRow: s.startRow }));
      sessions.forEach((s) => out.push({
        iso: s.iso, sessionType: s.sessionType, label: s.label || s.sessionType, local: true, complete: s.complete,
        clientId: s.clientId, pending: s.exercises.filter((x) => !x.synced).length,
        rows: s.exercises.map((x) => ({ exercise: x.exercise, sets: x.sets, notes: x.notes, pending: !x.synced }))
      }));
      return out.filter((s) => s.rows.length).sort((a, b) => (b.iso || '').localeCompare(a.iso || ''));
    },
    runs() {
      const out = [];
      this.sessions().forEach((s) => s.rows.forEach((r) => {
        if (classify(r.exercise) !== 'cardio') return;
        const p = parseRun(r.sets); out.push({ iso: s.iso, km: p.km, pace: p.pace, paceSec: p.paceSec, raw: r.sets, notes: r.notes });
      }));
      return out;
    },
    plan() { return (snapshot && snapshot.plan) || null; },
    planRow(iso) { const p = this.plan(); return p ? p.rows.find((r) => r.iso === iso) : null; },
    // Local overrides for plan statuses queued in the outbox.
    planStatus(row) {
      const q = outbox.filter((m) => m.action === 'updatePlanStatus' && m.payload.date === row.iso).pop();
      return q ? q.payload.status : row.status;
    },
    stats() { return (snapshot && (snapshot.stats || snapshot.sheet8)) || { frequency: {}, nextAfter: {}, typeFrequency: {} }; },
    activeSession() { return sessions.find((s) => !s.complete) || null; },
    pendingCount() {
      return sessions.reduce((n, s) => n + s.exercises.filter((x) => !x.synced).length, 0) + outbox.length;
    },
    // A week counts toward the streak only with STREAK_MIN sessions or more.
    // The current week is skipped (not broken) while it's still in progress.
    weekStreak() {
      const counts = {};
      this.sessions().forEach((s) => { if (s.iso) { const w = mondayOf(s.iso); counts[w] = (counts[w] || 0) + 1; } });
      let w = mondayOf(todayIso()), n = 0;
      if ((counts[w] || 0) < STREAK_MIN) w = addDays(w, -7);
      while ((counts[w] || 0) >= STREAK_MIN) { n++; w = addDays(w, -7); }
      return n;
    }
  };

  // ============================================================
  // API + SYNC
  // ============================================================
  const Sync = { busy: false, error: '', listeners: [] };
  Sync.onChange = (fn) => Sync.listeners.push(fn);
  const notify = () => Sync.listeners.forEach((fn) => fn());

  async function call(action, payload) {
    if (!apiUrl) throw new Error('No API URL set (More → Settings)');
    const url = apiUrl + (apiUrl.includes('?') ? '&' : '?') + 'action=' + encodeURIComponent(action);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(url, {
        method: payload ? 'POST' : 'GET',
        // text/plain avoids a CORS preflight, which Apps Script can't answer.
        headers: payload ? { 'Content-Type': 'text/plain;charset=utf-8' } : {},
        body: payload ? JSON.stringify(payload) : undefined,
        redirect: 'follow', signal: ctrl.signal
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    } finally { clearTimeout(t); }
  }

  function reconcile() {
    if (!snapshot) return;
    const byId = {};
    (snapshot.sessions || []).forEach((s) => { if (s.clientId) byId[s.clientId] = s; });
    sessions = sessions.filter((s) => {
      const srv = byId[s.clientId];
      if (srv) {
        s.startRow = srv.startRow;
        const rowIds = new Set((srv.rows || []).map((r) => r.clientId).filter(Boolean));
        s.exercises.forEach((x) => { if (rowIds.has(x.clientId)) x.synced = true; });
      }
      const allSynced = s.exercises.every((x) => x.synced);
      // Drop fully-synced, finished sessions the server now owns; keep everything else.
      return !(srv && s.complete && allSynced);
    });
    saveSessions();
  }

  Sync.pull = async function () {
    const snap = await call('bootstrap');
    if (!snap.ok) throw new Error('Bad bootstrap response');
    snapshot = snap; Store.set('snapshot', snap);
    meta.lastPull = Date.now(); saveMeta();
    reconcile();
  };

  Sync.push = async function () {
    // Sessions in creation order so the sheet stays roughly chronological.
    for (const s of sessions.slice().sort((a, b) => a.createdAt - b.createdAt)) {
      const pending = s.exercises.filter((x) => !x.synced);
      if (!pending.length) continue;
      if (!s.startRow) {
        const res = await call('addSession', {
          clientId: s.clientId, date: s.iso, sessionType: s.label || s.sessionType,
          entries: pending.map((x) => ({ clientId: x.clientId, exercise: x.exercise, sets: x.sets, notes: x.notes || '' }))
        });
        s.startRow = res.startRow;
        // A duplicate means an earlier attempt landed but the reply was lost — rows exist for these ids.
        pending.forEach((x) => { x.synced = true; });
        saveSessions();
      } else {
        for (const x of pending) {
          await call('appendExercise', { startRow: s.startRow, clientId: x.clientId, exercise: x.exercise, sets: x.sets, notes: x.notes || '' });
          x.synced = true; saveSessions();
        }
      }
    }
    while (outbox.length) {
      const m = outbox[0];
      await call(m.action, m.payload);
      outbox.shift(); saveOutbox();
    }
    meta.lastPush = Date.now(); saveMeta();
  };

  Sync.run = async function (opts) {
    opts = opts || {};
    if (Sync.busy) return;
    if (!apiUrl) { Sync.error = 'Set the API URL in More'; notify(); return; }
    if (!navigator.onLine) { Sync.error = ''; notify(); if (!opts.silent) toast('Offline — will sync when connected'); return; }
    Sync.busy = true; Sync.error = ''; notify();
    try {
      if (!opts.pullOnly) await Sync.push();
      await Sync.pull();
      if (!opts.silent) toast('Synced ✓');
    } catch (e) {
      Sync.error = e.message || String(e);
      if (!opts.silent) toast('Sync failed: ' + Sync.error, 4000);
    } finally { Sync.busy = false; notify(); }
  };

  function queue(action, payload) {
    outbox.push({ id: uid(), action, payload, createdAt: Date.now() });
    saveOutbox(); notify();
    if (navigator.onLine) Sync.run({ silent: true });
  }

  // ============================================================
  // SESSION LOGGING (local-first)
  // ============================================================
  const Log = {
    start(iso, type, label) {
      const s = { clientId: uid(), iso, sessionType: type, label: label || cap(type), exercises: [], startRow: null, complete: false, createdAt: Date.now() };
      sessions.push(s); saveSessions(); return s;
    },
    addExercise(s, exercise, sets, notes) {
      s.exercises.push({ clientId: uid(), exercise: exercise.trim(), sets: sets.trim(), notes: (notes || '').trim(), synced: false });
      saveSessions(); notify();
      if (navigator.onLine) Sync.run({ silent: true });
    },
    removeExercise(s, clientId) {
      const x = s.exercises.find((e) => e.clientId === clientId);
      if (!x || x.synced) return false;          // already in the sheet — edit there
      s.exercises = s.exercises.filter((e) => e.clientId !== clientId);
      saveSessions(); notify(); return true;
    },
    finish(s) {
      s.complete = true; saveSessions(); notify();
      if (!s.exercises.length) { sessions = sessions.filter((x) => x !== s); saveSessions(); }
      if (navigator.onLine) Sync.run({ silent: true });
    },
    discard(s) { sessions = sessions.filter((x) => x !== s); saveSessions(); notify(); }
  };
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

  // Double progression: top of the range on all working sets → bump Start.
  function progressionFor(exercise, setsStr) {
    const st = Data.strengthByKey()[exKey(exercise)];
    if (!st) return null;
    const range = parseRange(st.setsReps);
    if (!range) return null;
    const flat = [];
    parseSets(setsStr).filter((x) => !x.warmup).forEach((x) => { for (let i = 0; i < x.count; i++) flat.push(x); });
    const working = flat.slice(-range.sets);
    if (working.length < range.sets) return null;
    const hit = working.every((x) => x.reps >= range.hi);
    const w = Math.max(...working.map((x) => x.weight));
    const inc = parseIncrement(st.increment);
    const assist = /assist/i.test(st.start + ' ' + st.increment);
    let newStart = null;
    if (hit && inc != null && w > 0) {
      const unit = st.start.replace(/^[\d.,\s]+/, '') || 'kg';
      const val = Math.round((assist ? w - inc : w + inc) * 100) / 100;
      newStart = val + ' ' + unit;
    }
    return { plan: st, range, hit, topWeight: w, newStart };
  }

  // ============================================================
  // VIEWS
  // ============================================================
  const view = $('#view');
  const routes = {};
  let lastExerciseCtx = { search: '', type: '' };

  function typeTag(t) { return `<span class="tag ${esc(t || 'other')}">${esc(t || 'other')}</span>`; }

  function summarizeRows(rows) {
    return rows.map((r) => esc(r.exercise)).slice(0, 4).join(' · ') + (rows.length > 4 ? ` +${rows.length - 4}` : '');
  }

  // ---------- HOME ----------
  routes.home = () => {
    const plan = Data.plan();
    const today = todayIso();
    const todayRow = Data.planRow(today);
    const active = Data.activeSession();
    const all = Data.sessions();
    const weekStart = mondayOf(today);
    const thisWeek = all.filter((s) => s.iso >= weekStart);
    const weekKm = Data.runs().filter((r) => r.iso >= weekStart).reduce((a, r) => a + (r.km || 0), 0);
    const planWeek = plan && plan.weeks.find((w) => w.isoStart <= today && today <= w.isoEnd);
    const overdue = plan ? plan.rows.filter((r) => r.iso < today && !Data.planStatus(r) && !/rest/i.test(r.session)).length : 0;

    let html = '';
    if (!snapshot) {
      html += `<div class="banner ${apiUrl ? 'warn' : 'info'}">${apiUrl ? 'No data yet — connect to the internet and tap Sync.' : 'Welcome! Set your Apps Script URL in <a href="#settings"><b>More</b></a>, then Sync to load your sheet.'}</div>`;
    }
    if (active) {
      html += `<div class="card"><h2>In progress</h2>
        <div class="row between"><div><h3>${typeTag(active.sessionType)} ${esc(active.label)}</h3><div class="muted small">${esc(fmtLong(active.iso))} · ${active.exercises.length} exercise${active.exercises.length === 1 ? '' : 's'}</div></div>
        <a class="btn primary" href="#log">Resume</a></div></div>`;
    }

    // Today's plan
    html += `<div class="card"><h2>Today · ${esc(fmtLong(today))}</h2>`;
    if (todayRow) {
      const st = Data.planStatus(todayRow);
      html += `<div class="row between"><h3>${esc(todayRow.session)}</h3>${st ? `<span class="tag status ${esc(st)}">${esc(st)}</span>` : ''}</div>
        <div class="stack small">
          ${todayRow.runKm ? `<div>🏃 <b>${todayRow.runKm} km</b>${todayRow.targetPace ? ` · ${esc(todayRow.targetPace)}` : ''}</div>` : ''}
          ${todayRow.lift ? `<div>🏋️ <b>${esc(todayRow.lift)}</b></div>` : ''}
          ${todayRow.notes ? `<div class="muted">${esc(todayRow.notes)}</div>` : ''}
          <div class="muted">Week ${esc(todayRow.week)} · ${esc(todayRow.phase)}</div>
        </div>
        <hr class="sep">
        <div class="row wrap">
          ${!/rest/i.test(todayRow.session) && !active ? `<a class="btn primary" href="#log">Start session</a>` : ''}
          <button class="btn sm" data-plan-status="${todayRow.iso}" data-status="DONE">Mark done</button>
          <button class="btn sm ghost" data-plan-status="${todayRow.iso}" data-status="SKIPPED">Skip</button>
          ${st ? `<button class="btn sm ghost" data-plan-status="${todayRow.iso}" data-status="">Clear</button>` : ''}
        </div>`;
    } else {
      html += `<div class="muted">No plan entry for today.</div>${active ? '' : '<div style="margin-top:10px"><a class="btn primary" href="#log">Start session</a></div>'}`;
    }
    html += `</div>`;

    // Stats
    html += `<div class="card"><div class="row">
      <div class="stat"><div class="big">${Data.weekStreak()}</div><div class="muted small">week streak<br>(${STREAK_MIN}+ sessions)</div></div>
      <div class="stat"><div class="big">${thisWeek.length}</div><div class="muted small">sessions this week</div></div>
      <div class="stat"><div class="big">${Math.round(weekKm * 10) / 10}<span class="muted" style="font-size:14px">${planWeek ? '/' + planWeek.totalKm : ''}</span></div><div class="muted small">km this week</div></div>
    </div></div>`;

    if (plan && plan.next && plan.next.iso !== today) {
      html += `<div class="card"><h2>Next up</h2><div class="row between"><div><b>${esc(plan.next.session)}</b> <span class="muted small">${esc(fmtLong(plan.next.iso))}</span>
        <div class="small muted">${plan.next.runKm ? plan.next.runKm + ' km · ' + esc(plan.next.targetPace) : esc(plan.next.lift || plan.next.notes)}</div></div><a class="btn sm" href="#plan">Plan</a></div></div>`;
    }
    if (overdue) html += `<div class="banner warn">${overdue} past plan session${overdue === 1 ? '' : 's'} not marked. <a href="#plan"><b>Review →</b></a></div>`;

    // Recent
    const recent = all.filter((s) => !(s.local && !s.complete)).slice(0, 4);
    html += `<div class="card"><h2>Recent</h2><div class="list">` + (recent.length ? recent.map((s) => `
      <a class="item" href="#history">${typeTag(s.sessionType)}<div><div class="title">${esc(fmtLong(s.iso))}${s.pending ? ' <span class="tag pending">pending</span>' : ''}</div><div class="sub">${summarizeRows(s.rows)}</div></div><div class="right">${s.rows.length}</div></a>`).join('') : '<div class="empty">No sessions yet</div>') + `</div></div>`;

    html += renderCalendar();

    view.innerHTML = html;
    wireCalendar();
  };

  // ---------- CALENDAR ----------
  let calMonth = null;      // 'YYYY-MM' being shown
  let calSelected = null;   // iso of the tapped day

  function renderCalendar() {
    const today = todayIso();
    const ym = calMonth || today.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;     // Monday-first grid
    const byDay = {};
    Data.sessions().forEach((s) => { if (s.iso && s.iso.slice(0, 7) === ym) (byDay[s.iso] = byDay[s.iso] || []).push(s); });
    const plan = Data.plan();
    const sel = calSelected || today;

    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<div class="cal-cell empty"></div>';
    for (let d = 1; d <= days; d++) {
      const iso = ym + '-' + pad2(d);
      const ss = byDay[iso] || [];
      const pr = plan && plan.rows.find((r) => r.iso === iso);
      const planned = pr && iso > today && !/rest/i.test(pr.session);
      const cls = ['cal-cell', iso === today ? 'today' : '', iso === sel ? 'selected' : '', ss.length ? 'has' : '', planned ? 'planned' : ''].join(' ');
      cells += `<button class="${cls}" data-day="${iso}"><span class="n">${d}</span><span class="dots">${ss.slice(0, 3).map((x) => `<i class="dot ${esc(x.sessionType)}"></i>`).join('') || (planned ? '<i class="dot plan"></i>' : '')}</span></button>`;
    }

    // Detail for the selected day
    const selSessions = Data.sessions().filter((x) => x.iso === sel);
    const selPlan = plan && plan.rows.find((r) => r.iso === sel);
    let detail = `<div class="cal-detail"><div class="row between"><b>${esc(fmtLong(sel))}</b>${sel === today ? '<span class="muted small">today</span>' : ''}</div>`;
    if (selSessions.length) {
      detail += selSessions.map((x) => `<div class="cal-sess">${typeTag(x.sessionType)} <span class="small">${summarizeRows(x.rows)}</span>${x.pending ? ' <span class="tag pending">pending</span>' : ''}</div>`).join('');
    }
    if (selPlan) {
      const st = Data.planStatus(selPlan);
      detail += `<div class="cal-plan small"><span class="muted">Plan:</span> <b>${esc(selPlan.session)}</b>${selPlan.runKm ? ` · ${selPlan.runKm} km${selPlan.targetPace ? ' @ ' + esc(selPlan.targetPace) : ''}` : ''}${st ? ` <span class="tag status ${esc(st)}">${esc(st)}</span>` : ''}</div>`;
    }
    if (!selSessions.length && !selPlan) detail += `<div class="muted small">Nothing logged.</div>`;
    detail += `</div>`;

    return `<div class="card cal">
      <div class="row between cal-head">
        <button class="btn sm ghost" data-cal="-1">‹</button>
        <h3>${MONTHS[m - 1]} ${y}</h3>
        <button class="btn sm ghost" data-cal="1">›</button>
      </div>
      <div class="cal-grid cal-dow">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<div>${d}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend small muted"><i class="dot push"></i>push <i class="dot pull"></i>pull <i class="dot legs"></i>legs <i class="dot cardio"></i>cardio <i class="dot plan"></i>planned</div>
      ${detail}
    </div>`;
  }

  function wireCalendar() {
    $$('[data-cal]').forEach((b) => { b.onclick = () => {
      const ym = calMonth || todayIso().slice(0, 7);
      const [y, m] = ym.split('-').map(Number);
      const d = new Date(y, m - 1 + Number(b.dataset.cal), 1);
      calMonth = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
      routes.home();
    }; });
    $$('[data-day]').forEach((b) => { b.onclick = () => { calSelected = b.dataset.day; routes.home(); }; });
  }

  // ---------- LOG ----------
  const logState = { exercise: '', sets: '', notes: '', type: '', iso: '', label: '', runLabel: 'Easy Run', runKm: '', runPace: '',
    // set-by-set entry
    setsList: [], setMode: 'warmup', w: '', r: '', setNote: '', freeText: false };
  const WARMUP_REST = 60;

  // Pick an exercise: reset the set builder and prefill weight/reps from the
  // last top working set (or the PPL start weight for a first-timer).
  function selectExercise(name) {
    logState.exercise = name.trim();
    logState.setsList = []; logState.setMode = 'warmup'; logState.setNote = ''; logState.sets = ''; logState.notes = '';
    logState.w = ''; logState.r = '';
    const ex = Data.exercises()[exKey(name)];
    const top = ex && ex.history[0] ? topSet(ex.history[0].sets) : null;
    if (top) { logState.w = top.weight || ''; logState.r = top.reps; }
    else {
      const st = Data.strengthByKey()[exKey(name)];
      const startW = st && !/assist/i.test(st.start) ? parseFloat(st.start) : NaN;
      const range = st && parseRange(st.setsReps);
      if (!isNaN(startW)) logState.w = startW;
      if (range) logState.r = range.lo;
    }
    stopTimer();
    render();
  }

  // "W:14.5x10, 19.5x8, 24.5x8x2 (note)" from the list of logged sets —
  // identical consecutive sets collapse into the "xN" form the sheet uses.
  function buildSetsString(list) {
    const toks = [];
    list.forEach((st) => {
      const w = st.weight == null ? 'BW' : String(st.weight);
      const prev = toks[toks.length - 1];
      if (prev && !prev.note && !st.note && prev.w === w && prev.reps === st.reps && prev.warmup === st.warmup) { prev.count++; return; }
      toks.push({ w, reps: st.reps, count: 1, warmup: st.warmup, note: st.note || '' });
    });
    return toks.map((t) => (t.warmup ? 'W:' : '') + t.w + 'x' + t.reps + (t.count > 1 ? 'x' + t.count : '') + (t.note ? ' (' + t.note + ')' : '')).join(', ');
  }
  let timer = { end: 0, id: 0, total: 0 };

  routes.log = () => {
    const active = Data.activeSession();
    if (!active) return renderNewSession();
    renderActiveSession(active);
  };

  function renderNewSession() {
    const today = todayIso();
    const todayRow = Data.planRow(today);
    if (!logState.iso) logState.iso = today;
    if (!logState.type) {
      const hint = todayRow ? (todayRow.lift || todayRow.session) : '';
      logState.type = /push/i.test(hint) ? 'push' : /pull/i.test(hint) ? 'pull' : /leg/i.test(hint) ? 'legs' : /run|jog|race|tempo|interval/i.test(hint) ? 'cardio' : 'push';
    }
    const types = ['push', 'pull', 'legs', 'cardio', 'other'];
    view.innerHTML = `
      <div class="card"><h2>New session</h2>
        <div class="field"><label>Date</label><input type="date" id="ns-date" value="${esc(logState.iso)}" max="${today}"></div>
        <div class="field"><label>Type</label><div class="chips">${types.map((t) => `<button class="chip ${logState.type === t ? 'active' : ''}" data-type="${t}">${cap(t)}</button>`).join('')}</div></div>
        ${todayRow && logState.iso === today ? `<div class="banner info small">Plan today: <b>${esc(todayRow.session)}</b>${todayRow.runKm ? ` · ${todayRow.runKm} km @ ${esc(todayRow.targetPace)}` : ''}${todayRow.notes ? ` — ${esc(todayRow.notes)}` : ''}</div>` : ''}
        <button class="btn primary block" id="ns-start">Start ${esc(cap(logState.type))} session</button>
      </div>
      <div class="card small muted">Sessions are saved on this phone as you go and pushed to the sheet automatically when you're online.</div>`;
    $('#ns-date').onchange = (e) => { logState.iso = e.target.value || today; };
    $$('[data-type]').forEach((b) => { b.onclick = () => { logState.type = b.dataset.type; renderNewSession(); }; });
    $('#ns-start').onclick = () => {
      const label = logState.type === 'cardio' ? 'Cardio' : cap(logState.type);
      Log.start(logState.iso, logState.type, label);
      logState.exercise = ''; logState.sets = ''; logState.notes = '';
      render();
    };
  }

  function suggestions(session) {
    const stats = Data.stats();
    const exMap = Data.exercises();
    const names = Object.keys(exMap).map((k) => exMap[k].name);
    const done = new Set(session.exercises.map((x) => exKey(x.exercise)));
    const last = session.exercises.length ? session.exercises[session.exercises.length - 1].exercise : null;
    const score = {};
    names.forEach((n) => {
      if (done.has(exKey(n))) return;
      const tf = stats.typeFrequency[n] || {};
      const inType = tf[session.sessionType] || 0;
      const total = stats.frequency[n] || exMap[exKey(n)].history.length || 0;
      let s = inType * 3 + (exMap[exKey(n)].type === session.sessionType ? 2 : 0) + Math.min(total, 10) * 0.1;
      if (last && stats.nextAfter[last] && stats.nextAfter[last][n]) s += stats.nextAfter[last][n] * 5;
      if (s > 0) score[n] = s;
    });
    return Object.keys(score).sort((a, b) => score[b] - score[a]).slice(0, 8);
  }

  function renderActiveSession(s) {
    const exMap = Data.exercises();
    const sugg = suggestions(s);
    const cur = logState.exercise;
    const curEx = cur ? exMap[exKey(cur)] : null;
    const rest = curEx ? curEx.restSec : restFor(cur);
    const strength = cur ? Data.strengthByKey()[exKey(cur)] : null;
    const isRun = s.sessionType === 'cardio' || classify(cur) === 'cardio';
    const allNames = Object.values(exMap).map((e) => e.name).sort();

    let html = `<div class="card">
      <div class="row between"><div>${typeTag(s.sessionType)} <b>${esc(s.label)}</b><div class="muted small">${esc(fmtLong(s.iso))}${s.startRow ? ` · sheet row ${s.startRow}` : ' · not yet in sheet'}</div></div>
      <button class="btn sm" id="finish-session">Finish session</button></div>`;
    if (s.exercises.length) {
      html += `<hr class="sep"><div class="list">` + s.exercises.map((x) => `
        <div class="item" data-reuse="${esc(x.clientId)}"><div class="grow"><div class="title">${esc(x.exercise)} ${x.synced ? '' : '<span class="tag pending">pending</span>'}</div><div class="sub">${esc(x.sets)}${x.notes ? ' — ' + esc(x.notes) : ''}</div></div>
        ${x.synced ? '' : `<button class="btn sm ghost danger" data-del="${esc(x.clientId)}">✕</button>`}</div>`).join('') + `</div>`;
    }
    html += `</div>`;

    // Exercise entry
    html += `<div class="card"><h2>${cur ? 'Exercise' : 'Add exercise'}</h2>
      <div class="field"><input type="search" id="ex-name" list="ex-list" placeholder="Search or type an exercise…" value="${esc(cur)}" autocomplete="off">
      <datalist id="ex-list">${allNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>`;
    if (!cur && sugg.length) html += `<div class="chips" style="margin-bottom:10px">${sugg.map((n) => `<button class="chip" data-pick="${esc(n)}">${esc(n)}</button>`).join('')}</div>`;
    if (isRun && !cur) html += `<div class="chips" style="margin-bottom:10px"><button class="chip" data-pick="Run">Run</button></div>`;

    if (cur) {
      // history + strength context
      const hist = curEx ? curEx.history.slice(0, 3) : [];
      if (strength) {
        html += `<div class="banner info small">🎯 <b>${esc(strength.setsReps)}</b> · start <b>${esc(strength.start)}</b> · ${esc(strength.increment)}${strength.notes ? `<div class="muted">${esc(strength.notes)}</div>` : ''}</div>`;
      }
      html += `<div class="lastperf"><div class="lbl">Last performances</div>` + (hist.length
        ? hist.map((h) => `<div class="lp"><span class="d">${esc(fmtShort(h.iso) || h.date)}</span><span class="v">${esc(h.sets)}</span></div>`).join('')
        : '<div class="muted small">First time logging this one.</div>') + `</div>`;

      if (classify(cur) === 'cardio') {
        const labels = ['Easy Run', 'Long Run', 'Recovery Jog', 'Tempo', 'Interval', 'Race'];
        html += `<div class="field"><label>Session</label><div class="chips">${labels.map((l) => `<button class="chip ${logState.runLabel === l ? 'active' : ''}" data-runlabel="${l}">${l}</button>`).join('')}</div></div>
          <div class="row"><div class="field grow"><label>Distance (km)</label><input type="number" step="0.01" inputmode="decimal" id="run-km" value="${esc(logState.runKm)}" placeholder="5.03"></div>
          <div class="field grow"><label>Pace (min:sec /km)</label><input type="text" inputmode="numeric" id="run-pace" value="${esc(logState.runPace)}" placeholder="7:36"></div></div>
          <div class="field"><label>Notes</label><input type="text" id="ex-notes" value="${esc(logState.notes)}" placeholder="optional"></div>
          <button class="btn primary block" id="finish-ex">Finish exercise</button>`;
      } else if (logState.freeText) {
        html += `<div class="field"><label>Sets — weight x reps[, …] (W: = warm-up)</label><input type="text" id="ex-sets" value="${esc(logState.sets)}" placeholder="W:14.5x10, 19.5x8, 24.5x8x2" autocomplete="off"></div>
          <div class="field"><label>Notes</label><input type="text" id="ex-notes" value="${esc(logState.notes)}" placeholder="optional"></div>
          <div id="timer-box"></div>
          <div class="row" style="margin-top:10px"><button class="btn grow" id="rest-btn">⏱ Rest ${rest / 60} min</button><button class="btn primary grow" id="finish-ex">Finish exercise</button></div>
          <div style="margin-top:8px"><button class="btn sm ghost" id="toggle-free">← set-by-set entry</button></div>`;
      } else {
        const list = logState.setsList;
        const nW = list.filter((x) => x.warmup).length, nK = list.length - nW;
        const mode = logState.setMode;
        html += `
          <div class="seg"><button class="${mode === 'warmup' ? 'active' : ''}" data-mode="warmup">Warmup <span class="cnt">${nW}</span></button><button class="${mode === 'working' ? 'active' : ''}" data-mode="working">Working <span class="cnt">${nK}</span></button></div>
          ${list.length ? `<div class="setlist">${list.map((x, i) => `<div class="setrow ${x.warmup ? 'warm' : ''}"><span class="idx">${x.warmup ? 'W' : '#' + (list.slice(0, i + 1).filter((y) => !y.warmup).length)}</span><span class="v">${x.weight == null ? 'BW' : x.weight + ' kg'} × ${x.reps}</span>${x.note ? `<span class="muted small">${esc(x.note)}</span>` : ''}<button class="btn sm ghost danger" data-delset="${i}">✕</button></div>`).join('')}</div>` : ''}
          <div class="setcard ${mode}">
            <div class="row between"><span class="setcard-title">${mode.toUpperCase()} SET</span><span class="muted small">Set #${(mode === 'warmup' ? nW : nK) + 1}</span></div>
            <div class="row">
              <div class="field grow"><label>Weight (kg)</label><input type="number" step="0.5" inputmode="decimal" id="set-w" placeholder="kg / BW" value="${esc(logState.w)}"></div>
              <div class="field grow"><label>Reps</label><input type="number" inputmode="numeric" id="set-r" value="${esc(logState.r)}" placeholder="10"></div>
            </div>
            <div class="steppers">
              <button data-dw="-2.5">−2.5</button><button data-dw="-0.5">−0.5</button><button data-dw="0.5">+0.5</button><button data-dw="2.5">+2.5</button>
              <span class="grow"></span>
              <button data-dr="-1">−1</button><button data-dr="1">+1</button>
            </div>
            <div class="field"><label>Note (optional)</label><input type="text" id="set-note" value="${esc(logState.setNote)}" placeholder="e.g. ds 14×6, felt strong, failed"></div>
            <div id="timer-box"></div>
            <button class="btn primary block" id="finish-set">Finish set → Rest ${mode === 'warmup' ? WARMUP_REST + 's' : rest / 60 + ' min'}</button>
          </div>
          <div class="field" style="margin-top:10px"><label>Exercise note (optional)</label><input type="text" id="ex-notes" value="${esc(logState.notes)}" placeholder="goes in the Notes column"></div>
          <button class="btn primary block bigbtn" id="finish-ex" ${list.length ? '' : 'disabled'}>FINISH EXERCISE<span>${nK} working set${nK === 1 ? '' : 's'}${nW ? ` · ${nW} warm-up` : ''}</span></button>
          <div style="margin-top:8px"><button class="btn sm ghost" id="toggle-free">type sets as text instead</button></div>`;
      }
      html += `<div style="margin-top:8px"><button class="btn sm ghost" id="clear-ex">← change exercise</button></div>`;
    }
    html += `</div>`;
    html += `<div class="card"><button class="btn ghost danger sm" id="discard-session">Discard session</button></div>`;
    view.innerHTML = html;

    // wiring
    const nameEl = $('#ex-name');
    nameEl.onchange = () => { if (nameEl.value.trim()) selectExercise(nameEl.value); };
    nameEl.onkeydown = (e) => { if (e.key === 'Enter' && nameEl.value.trim()) selectExercise(nameEl.value); };
    $$('[data-pick]').forEach((b) => { b.onclick = () => selectExercise(b.dataset.pick); });
    $$('[data-runlabel]').forEach((b) => { b.onclick = () => { logState.runLabel = b.dataset.runlabel; render(); }; });
    $$('[data-del]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); if (Log.removeExercise(s, b.dataset.del)) render(); }; });
    $$('[data-reuse]').forEach((el) => { el.onclick = () => { const x = s.exercises.find((e) => e.clientId === el.dataset.reuse); if (x) selectExercise(x.exercise); }; });
    if ($('#ex-sets')) $('#ex-sets').oninput = (e) => { logState.sets = e.target.value; };
    if ($('#ex-notes')) $('#ex-notes').oninput = (e) => { logState.notes = e.target.value; };
    if ($('#run-km')) $('#run-km').oninput = (e) => { logState.runKm = e.target.value; };
    if ($('#run-pace')) $('#run-pace').oninput = (e) => { logState.runPace = e.target.value; };
    if ($('#clear-ex')) $('#clear-ex').onclick = () => { logState.exercise = ''; logState.sets = ''; logState.notes = ''; logState.setsList = []; stopTimer(); render(); };
    if ($('#rest-btn')) $('#rest-btn').onclick = () => startTimer(rest);
    if ($('#finish-ex')) $('#finish-ex').onclick = () => finishExercise(s);
    if ($('#toggle-free')) $('#toggle-free').onclick = () => { logState.freeText = !logState.freeText; render(); };
    // set builder
    $$('[data-mode]').forEach((b) => { b.onclick = () => { logState.setMode = b.dataset.mode; render(); }; });
    $$('[data-delset]').forEach((b) => { b.onclick = () => { logState.setsList.splice(+b.dataset.delset, 1); render(); }; });
    const wEl = $('#set-w'), rEl = $('#set-r'), nEl = $('#set-note');
    if (wEl) wEl.oninput = () => { logState.w = wEl.value; };
    if (rEl) rEl.oninput = () => { logState.r = rEl.value; };
    if (nEl) nEl.oninput = () => { logState.setNote = nEl.value; };
    $$('[data-dw]').forEach((b) => { b.onclick = () => { const v = Math.max(0, Math.round(((parseFloat(logState.w) || 0) + Number(b.dataset.dw)) * 100) / 100); logState.w = v; wEl.value = v; }; });
    $$('[data-dr]').forEach((b) => { b.onclick = () => { const v = Math.max(1, (parseInt(logState.r, 10) || 0) + Number(b.dataset.dr)); logState.r = v; rEl.value = v; }; });
    if ($('#finish-set')) $('#finish-set').onclick = () => {
      const reps = parseInt(logState.r, 10);
      if (!reps || reps < 1) return toast('Enter reps');
      const wRaw = String(logState.w).trim();
      const weight = wRaw === '' || /^bw$/i.test(wRaw) ? null : parseFloat(wRaw);
      if (weight !== null && isNaN(weight)) return toast('Weight must be a number (blank = bodyweight)');
      logState.setsList.push({ weight, reps, warmup: logState.setMode === 'warmup', note: logState.setNote.trim() });
      logState.setNote = '';
      if (navigator.vibrate) navigator.vibrate(30);
      render();
      startTimer(logState.setMode === 'warmup' ? WARMUP_REST : rest);
    };
    $('#finish-session').onclick = () => finishSession(s);
    $('#discard-session').onclick = () => { if (confirm('Discard this session? Exercises already pushed to the sheet stay there.')) { Log.discard(s); logState.exercise = ''; render(); } };
    drawTimer();
    if (nameEl && !cur) nameEl.focus();
  }

  function finishExercise(s) {
    const name = logState.exercise.trim();
    if (!name) return toast('Pick an exercise');
    let sets, notes = logState.notes.trim();
    if (classify(name) === 'cardio') {
      const km = parseFloat(logState.runKm);
      if (!km) return toast('Enter the distance');
      let pace = logState.runPace.trim().replace('.', ':');
      if (pace && !/^\d{1,2}:\d{2}$/.test(pace)) return toast('Pace like 7:36');
      sets = `${logState.runLabel} · ${km}k${pace ? ' @' + pace : ''}`;
      // Mirror the run onto today's plan row as DONE with a summary.
      const pr = Data.planRow(s.iso);
      if (pr && Data.planStatus(pr) !== 'DONE' && /run|jog|tempo|interval|race/i.test(pr.session)) {
        queue('updatePlanStatus', { date: pr.iso, status: 'DONE', notes: `Done · ${km}km${pace ? ' @ ' + pace + '/km' : ''}` });
      }
    } else if (logState.freeText) {
      sets = logState.sets.trim();
      if (!sets) return toast('Enter your sets');
    } else {
      if (!logState.setsList.length) return toast('Log at least one set');
      sets = buildSetsString(logState.setsList);
    }
    Log.addExercise(s, name, sets, notes);

    const prog = classify(name) === 'cardio' ? null : progressionFor(name, sets);
    if (prog && prog.hit) {
      if (prog.newStart && confirm(`🎉 Top of range on all sets. Move ${name} start to ${prog.newStart} in the Strength tab?`)) {
        queue('updateStrengthStart', { exercise: prog.plan.exercise, start: prog.newStart });
        toast(`Start → ${prog.newStart}`);
      } else if (!prog.newStart) toast(`🎉 Top of range — add ${prog.plan.increment} next time`, 3500);
    }
    logState.exercise = ''; logState.sets = ''; logState.notes = ''; logState.runKm = ''; logState.runPace = '';
    logState.setsList = []; logState.setMode = 'warmup'; logState.setNote = '';
    stopTimer();
    render();
  }

  function finishSession(s) {
    if (!s.exercises.length) { if (confirm('No exercises logged. Discard session?')) { Log.discard(s); render(); } return; }
    const pr = Data.planRow(s.iso);
    Log.finish(s);
    if (pr && Data.planStatus(pr) !== 'DONE' && !/rest/i.test(pr.session)) {
      const lift = pr.lift || pr.session;
      if (confirm(`Mark today's plan (${lift}) as DONE?`)) {
        queue('updatePlanStatus', { date: pr.iso, status: 'DONE', notes: `Done · ${s.exercises.length} exercises` });
      }
    }
    logState.exercise = ''; logState.type = ''; logState.iso = '';
    toast(navigator.onLine ? 'Session saved — syncing' : 'Session saved offline');
    location.hash = '#home';
  }

  function startTimer(sec) {
    stopTimer();
    timer = { end: Date.now() + sec * 1000, total: sec, id: setInterval(drawTimer, 250) };
    drawTimer();
  }
  function stopTimer() { clearInterval(timer.id); timer = { end: 0, id: 0, total: 0 }; }
  function drawTimer() {
    const box = $('#timer-box'); if (!box) return;
    if (!timer.end) { box.innerHTML = ''; return; }
    const left = Math.max(0, Math.round((timer.end - Date.now()) / 1000));
    box.innerHTML = `<div class="timer ${left === 0 ? 'done' : ''}"><span>${left === 0 ? 'Rest done — go!' : 'Resting'}</span><span class="t">${Math.floor(left / 60)}:${pad2(left % 60)}</span><button class="btn sm ghost" id="timer-x">✕</button></div>`;
    $('#timer-x').onclick = stopTimer;
    if (left === 0) { clearInterval(timer.id); timer.id = 0; if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]); beep(); }
  }
  function beep() {
    try { const ac = new (window.AudioContext || window.webkitAudioContext)(); const o = ac.createOscillator(); const g = ac.createGain(); o.connect(g); g.connect(ac.destination); o.frequency.value = 880; g.gain.value = 0.15; o.start(); o.stop(ac.currentTime + 0.35); } catch (e) {}
  }

  // ---------- HISTORY ----------
  routes.history = () => {
    const all = Data.sessions().filter((s) => !(s.local && !s.complete));
    if (!all.length) { view.innerHTML = '<div class="empty">No sessions yet.</div>'; return; }
    const byMonth = {};
    all.forEach((s) => { const k = (s.iso || '').slice(0, 7) || 'undated'; (byMonth[k] = byMonth[k] || []).push(s); });
    view.innerHTML = Object.keys(byMonth).sort().reverse().map((k) => {
      const [y, m] = k.split('-');
      return `<div class="card"><h2>${m ? MONTHS[+m - 1] + ' ' + y : 'Undated'} <span class="muted">· ${byMonth[k].length}</span></h2>` +
        byMonth[k].map((s) => `<details class="week"><summary>${typeTag(s.sessionType)}&nbsp;${esc(fmtLong(s.iso))}${s.pending ? ' <span class="tag pending">pending</span>' : ''}<span class="muted small">${s.rows.length} ex</span></summary>
          <table class="hist" style="margin:0 12px 10px">${s.rows.map((r) => `<tr><td style="width:auto;color:var(--text)"><a href="#exercise/${exKey(r.exercise)}">${esc(r.exercise)}</a></td><td>${esc(r.sets || '')}${r.notes ? `<div class="muted small">${esc(r.notes)}</div>` : ''}</td></tr>`).join('')}</table></details>`).join('') + `</div>`;
    }).join('');
  };

  // ---------- EXERCISES ----------
  routes.exercises = () => {
    const list = Data.exerciseList();
    const types = ['', 'push', 'pull', 'legs', 'cardio', 'other'];
    const q = lastExerciseCtx.search.toLowerCase();
    const shown = list.filter((e) => (!lastExerciseCtx.type || e.type === lastExerciseCtx.type) && (!q || e.name.toLowerCase().includes(q)));
    view.innerHTML = `<div class="card">
      <div class="field"><input type="search" id="ex-search" placeholder="Search ${list.length} exercises…" value="${esc(lastExerciseCtx.search)}"></div>
      <div class="chips">${types.map((t) => `<button class="chip ${lastExerciseCtx.type === t ? 'active' : ''}" data-ft="${t}">${t ? cap(t) : 'All'}</button>`).join('')}</div>
      <hr class="sep"><div class="list">${shown.map((e) => {
        const last = e.history[0];
        return `<a class="item" href="#exercise/${e.key}">${typeTag(e.type)}<div><div class="title">${esc(e.name)}${e.strength ? ' 🎯' : ''}</div><div class="sub">${last ? esc(last.sets) : '—'}</div></div><div class="right">${last ? esc(fmtShort(last.iso) || last.date) : ''}<br>${e.history.length}×</div></a>`;
      }).join('') || '<div class="empty">Nothing matches</div>'}</div></div>`;
    const inp = $('#ex-search');
    inp.oninput = () => { lastExerciseCtx.search = inp.value; routes.exercises(); const i = $('#ex-search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); };
    $$('[data-ft]').forEach((b) => { b.onclick = () => { lastExerciseCtx.type = b.dataset.ft; routes.exercises(); }; });
  };

  routes.exercise = (key) => {
    const e = Data.exercises()[key];
    if (!e) { view.innerHTML = '<div class="empty">Unknown exercise</div>'; return; }
    const pts = e.history.map((h) => ({ iso: h.iso, top: topSet(h.sets) })).filter((p) => p.iso && p.top && p.top.weight > 0).reverse();
    const runs = e.type === 'cardio' ? e.history.map((h) => ({ iso: h.iso, r: parseRun(h.sets) })).filter((p) => p.iso && p.r.km).reverse() : [];
    let chart = '';
    if (pts.length >= 2) chart = svgChart(pts.map((p) => ({ x: p.iso, y: p.top.weight, label: p.top.weight + '×' + p.top.reps })), 'kg');
    else if (runs.length >= 2) chart = svgChart(runs.map((p) => ({ x: p.iso, y: p.r.km, label: p.r.km + 'k' })), 'km');
    const best = pts.length ? pts.reduce((a, b) => (b.top.weight > a.top.weight ? b : a)) : null;
    view.innerHTML = `<div class="card">
      <div class="row between"><h3>${esc(e.name)}</h3>${typeTag(e.type)}</div>
      <div class="muted small">${e.history.length} sessions · rest ${e.restSec / 60} min${e.aliases.length > 1 ? ' · also logged as ' + esc(e.aliases.filter((a) => a !== e.name).join(', ')) : ''}</div>
      ${e.strength ? `<div class="banner info small" style="margin-top:10px">🎯 ${esc(e.strength.day)} · <b>${esc(e.strength.setsReps)}</b> · start <b>${esc(e.strength.start)}</b> · ${esc(e.strength.increment)}<div class="muted">${esc(e.strength.notes)}</div></div>` : ''}
      ${best ? `<div class="row" style="margin-top:8px"><div class="stat"><div class="big">${best.top.weight}</div><div class="muted small">best top set (kg) · ${esc(fmtShort(best.iso))}</div></div>
        <div class="stat"><div class="big">${pts[pts.length - 1].top.weight}</div><div class="muted small">latest top set</div></div></div>` : ''}
      ${chart}
    </div>
    <div class="card"><h2>History</h2><table class="hist">${e.history.map((h) => `<tr><td>${esc(fmtShort(h.iso) || h.date)}${h.pending ? '<br><span class="tag pending">pending</span>' : ''}</td><td>${esc(h.sets)}${h.notes ? `<div class="muted small">${esc(h.notes)}</div>` : ''}</td></tr>`).join('')}</table></div>
    <div style="margin-bottom:12px"><a class="btn ghost sm" href="#exercises">← Exercises</a></div>`;
  };

  function svgChart(points, unit) {
    const W = 320, H = 140, P = { l: 30, r: 10, t: 12, b: 20 };
    const ys = points.map((p) => p.y);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const span = maxY - minY || 1;
    const x = (i) => P.l + (i / Math.max(points.length - 1, 1)) * (W - P.l - P.r);
    const y = (v) => P.t + (1 - (v - minY) / span) * (H - P.t - P.b);
    const path = points.map((p, i) => `${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
    const dots = points.map((p, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="3"><title>${esc(fmtShort(p.x))}: ${esc(p.label)}</title></circle>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <text class="lbl" x="2" y="${P.t + 4}">${maxY}${unit}</text><text class="lbl" x="2" y="${H - P.b}">${minY}${unit}</text>
      <text class="lbl" x="${P.l}" y="${H - 4}">${esc(fmtShort(points[0].x))}</text><text class="lbl" x="${W - P.r}" y="${H - 4}" text-anchor="end">${esc(fmtShort(points[points.length - 1].x))}</text>
      <polyline class="line" points="${path}"/>${dots}</svg>`;
  }

  // ---------- PLAN ----------
  let planTab = 'run';
  routes.plan = () => {
    const plan = Data.plan();
    const strength = (snapshot && snapshot.strengthPlan) || null;
    const today = todayIso();
    let html = `<div class="chips" style="margin-bottom:12px"><button class="chip ${planTab === 'run' ? 'active' : ''}" data-pt="run">Running plan</button><button class="chip ${planTab === 'str' ? 'active' : ''}" data-pt="str">Strength</button></div>`;
    if (planTab === 'run') {
      if (!plan) html += '<div class="empty">No Plan tab in the sheet.</div>';
      else {
        const s = plan.summary;
        html += `<div class="card"><div class="row"><div class="stat"><div class="big">${s.done}</div><div class="muted small">done</div></div><div class="stat"><div class="big">${s.remaining}</div><div class="muted small">remaining</div></div><div class="stat"><div class="big">${plan.weeks.length}</div><div class="muted small">weeks</div></div></div></div>`;
        html += plan.weeks.map((w) => {
          const rows = plan.rows.filter((r) => String(r.week) === String(w.week));
          const cur = w.isoStart <= today && today <= w.isoEnd;
          return `<details class="week" ${cur ? 'open' : ''}><summary><span>Week ${esc(w.week)} <span class="muted small">· ${esc(w.phase)} · ${esc(w.dateStart)}–${esc(w.dateEnd)}</span></span><span class="muted small">${w.totalKm} km · ${rows.filter((r) => Data.planStatus(r) === 'DONE').length}/${rows.length}</span></summary>
            ${rows.map((r) => { const st = Data.planStatus(r); return `<div class="day ${r.iso === today ? 'today' : ''}"><div class="d">${esc(r.day)}<br><span class="muted small">${esc(fmtShort(r.iso))}</span></div>
              <div><div class="s"><b>${esc(r.session)}</b>${r.runKm ? ` · ${r.runKm} km` : ''}${r.targetPace ? ` <span class="muted">@ ${esc(r.targetPace)}</span>` : ''}</div>${r.notes ? `<div class="n">${esc(r.notes)}</div>` : ''}</div>
              <div class="row" style="gap:4px">${st ? `<span class="tag status ${esc(st)}" data-plan-status="${r.iso}" data-status="" title="tap to clear">${esc(st)}</span>` : `<button class="btn sm" data-plan-status="${r.iso}" data-status="DONE">✓</button><button class="btn sm ghost" data-plan-status="${r.iso}" data-status="SKIPPED">✗</button>`}</div></div>`; }).join('')}
          </details>`;
        }).join('');
      }
    } else {
      if (!strength) html += '<div class="empty">No PPL Strength tab in the sheet.</div>';
      else {
        const exMap = Data.exercises();
        ['Push', 'Pull', 'Legs'].forEach((day) => {
          const rows = strength.filter((p) => p.day === day);
          if (!rows.length) return;
          html += `<div class="card"><h2>${day}</h2><div class="list">${rows.map((p) => {
            const e = exMap[exKey(p.exercise)]; const last = e && e.history[0];
            return `<a class="item" href="#exercise/${exKey(p.exercise)}"><div class="grow"><div class="title">${esc(p.exercise)}</div><div class="sub">${esc(p.setsReps)} · start <b>${esc(p.start)}</b> · ${esc(p.increment)}</div>${last ? `<div class="sub">last: ${esc(last.sets)} <span class="muted">(${esc(fmtShort(last.iso) || last.date)})</span></div>` : ''}</div></a>`;
          }).join('')}</div></div>`;
        });
      }
    }
    view.innerHTML = html;
    $$('[data-pt]').forEach((b) => { b.onclick = () => { planTab = b.dataset.pt; routes.plan(); }; });
  };

  // ---------- SETTINGS ----------
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (location.hash === '#settings') render(); });

  routes.settings = () => {
    const pending = Data.pendingCount();
    const size = Math.round(((localStorage.getItem('tt.snapshot') || '').length + (localStorage.getItem('tt.sessions') || '').length) / 1024);
    view.innerHTML = `
      <div class="card"><h2>Connection</h2>
        <div class="field"><label>Apps Script web app URL (…/exec)</label><input type="url" id="api-url" value="${esc(apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div class="row wrap"><button class="btn primary" id="save-url">Save & test</button><button class="btn" id="sync-now" ${Sync.busy ? 'disabled' : ''}>Sync now</button><button class="btn ghost" id="pull-now" ${Sync.busy ? 'disabled' : ''}>Pull only</button></div>
        <hr class="sep">
        <div class="small stack">
          <div>Status: <b>${navigator.onLine ? 'online' : 'offline'}</b>${Sync.error ? ` · <span style="color:var(--danger)">${esc(Sync.error)}</span>` : ''}</div>
          <div>Pending changes: <b>${pending}</b></div>
          <div>Last pull: ${ago(meta.lastPull)} · last push: ${ago(meta.lastPush)}</div>
          ${snapshot ? `<div>Sheet: <b>${esc(snapshot.activeTab || snapshot.latestTab)}</b> · ${snapshot.exercises.length} exercises · backend v${snapshot.version || '?'}</div>` : ''}
          <div>Local data: ~${size} KB</div>
        </div>
      </div>
      ${pending ? `<div class="card"><h2>Waiting to sync</h2><div class="list">${sessions.filter((s) => s.exercises.some((x) => !x.synced)).map((s) => `<div class="item"><div><div class="title">${esc(fmtLong(s.iso))} · ${esc(s.label)}</div><div class="sub">${s.exercises.filter((x) => !x.synced).length} exercise(s)</div></div></div>`).join('')}
        ${outbox.map((m) => `<div class="item"><div><div class="title">${esc(m.action)}</div><div class="sub">${esc(JSON.stringify(m.payload)).slice(0, 80)}</div></div><button class="btn sm ghost danger" data-drop="${m.id}">✕</button></div>`).join('')}</div></div>` : ''}
      <div class="card"><h2>App</h2>
        <div class="row wrap">
          ${installPrompt ? '<button class="btn primary" id="install">📲 Install app</button>' : '<div class="muted small">To install: Chrome menu ⋮ → <b>Add to Home screen</b>.</div>'}
        </div>
        <hr class="sep">
        <div class="row wrap"><button class="btn" id="export">Export JSON</button><button class="btn danger ghost" id="clear-cache">Clear cached sheet data</button></div>
        <div class="muted small" style="margin-top:8px">Clearing the cache keeps unsynced sessions. Pending changes are never deleted automatically.</div>
      </div>
      <div class="card small muted">Training Tracker · offline-first · ${esc(navigator.userAgent.includes('Android') ? 'Android' : 'web')}</div>`;
    $('#save-url').onclick = async () => {
      apiUrl = $('#api-url').value.trim(); Store.set('apiUrl', apiUrl);
      if (!apiUrl) return toast('URL cleared');
      try { const p = await call('ping'); toast(`Connected · backend v${p.version || '?'}`); Sync.run({ pullOnly: true }); } catch (e) { toast('Could not reach backend: ' + e.message, 4000); }
    };
    $('#sync-now').onclick = () => Sync.run();
    $('#pull-now').onclick = () => Sync.run({ pullOnly: true });
    $$('[data-drop]').forEach((b) => { b.onclick = () => { outbox = outbox.filter((m) => m.id !== b.dataset.drop); saveOutbox(); render(); }; });
    if ($('#install')) $('#install').onclick = async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); };
    $('#export').onclick = () => {
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), apiUrl, sessions, outbox, snapshot }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `training-tracker-${todayIso()}.json`; a.click();
    };
    $('#clear-cache').onclick = () => { if (confirm('Clear cached sheet data? Your unsynced sessions are kept.')) { snapshot = null; Store.del('snapshot'); meta.lastPull = 0; saveMeta(); render(); } };
  };

  // ============================================================
  // ROUTER / GLOBAL EVENTS
  // ============================================================
  let lastRoute = '';
  function render() {
    const hash = location.hash.replace(/^#/, '') || 'home';
    const [name, arg] = hash.split('/');
    const fn = routes[name] || routes.home;
    $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (name === 'exercise' ? 'exercises' : name)));
    const y = window.scrollY;
    fn(arg);
    // New screen → top. Same screen re-rendering (a set logged, sync finished) → stay put.
    if (hash !== lastRoute) window.scrollTo(0, 0); else window.scrollTo(0, y);
    lastRoute = hash;
    drawBadge();
  }

  function drawBadge() {
    const b = $('#syncBadge');
    const pending = Data.pendingCount();
    b.className = 'sync-badge' + (Sync.busy ? ' busy' : Sync.error ? ' error' : pending ? ' pending' : ' ok');
    b.textContent = Sync.busy ? 'syncing' : !navigator.onLine ? `offline${pending ? ' · ' + pending : ''}` : Sync.error ? 'sync error' : pending ? `${pending} pending` : (snapshot ? 'synced' : 'not synced');
  }

  // Plan status buttons appear on Home and Plan — one delegated handler.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-plan-status]');
    if (!el) return;
    const iso = el.dataset.planStatus, status = el.dataset.status;
    const row = Data.planRow(iso); if (!row) return;
    queue('updatePlanStatus', { date: iso, status, notes: status === 'DONE' && !row.notes.startsWith('Done') ? `Done · ${row.session}` : undefined });
    // Optimistic local update so the UI flips immediately.
    row.status = status; Store.set('snapshot', snapshot);
    render();
  });

  window.addEventListener('hashchange', render);
  window.addEventListener('online', () => { toast('Back online — syncing'); Sync.run({ silent: true }); });
  window.addEventListener('offline', drawBadge);
  Sync.onChange(() => {
    drawBadge();
    // Refresh the view once a sync finishes — unless the user is mid-typing.
    const typing = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (!Sync.busy && !typing) render();
  });
  $('#syncBadge').onclick = () => Sync.run();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  render();
  if (apiUrl && navigator.onLine && Date.now() - meta.lastPull > 5 * 60 * 1000) Sync.run({ silent: true });
})();
