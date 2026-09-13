/**
 * Training Tracker – Google Apps Script backend (v6)
 *
 * Only LOG_TABS (sheets in the app's own Date | Exercise | Sets | Notes |
 * Session Type layout) feed exercise history. ACTIVE_TAB is the current
 * training block: it drives the home screen, streak, calendar and
 * suggestions, and is where addSession / appendExercise write.
 *
 * To rotate to a new training block:
 *   1. Create a tab with the new block's name (a header row is optional).
 *   2. Set ACTIVE_TAB to it, and append it to LOG_TABS (keep the old one
 *      so history carries over).
 *   3. Deploy → Manage deployments → pencil → New version → Deploy.
 *
 * Response shape is a superset of v4: every old field is still present,
 * new fields are additive (iso dates, sessions[], runs[], plan.today, …).
 */

var ACTIVE_TAB = 'March - April 2026';
var LATEST_TAB = ACTIVE_TAB;   // legacy aliases still sent in bootstrap
var OUTPUT_TAB = ACTIVE_TAB;

// Tabs in the app's log format, oldest first. Nothing else in the workbook
// is read for history — Dashboard, Plan, PPL Strength, Standard and the old
// "Month N" tabs have different layouts and used to leak in as phantom
// exercises ("Total km", "Mon", "127.0", "Chest", …).
// NOTE: the "Web app" tab holds Apr 21–27 2026 sessions that also exist in
// the active tab. Leave it out (or delete it) to avoid duplicate history.
var LOG_TABS = [ACTIVE_TAB];

var PLAN_TAB = 'Plan';               // half-marathon plan; optional
var STRENGTH_TAB = 'PPL Strength';   // PPL template from SeedPPLStrength; optional
var API_VERSION = 6;

// Column A number format used when the app writes a session date.
var DATE_FORMAT = 'MMMM d';

// ============================================================
// ROUTING
// ============================================================
function doGet(e)  { return handle(e); }
function doPost(e) { return handle(e); }

function handle(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || '';
    var payload = {};
    if (e && e.postData && e.postData.contents) {
      try { payload = JSON.parse(e.postData.contents); } catch (err) {}
    }

    var result;
    switch (action) {
      // ---- reads ----
      case 'bootstrap': result = bootstrap(); break;
      case 'ping':      result = { ok: true, version: API_VERSION, time: new Date().toISOString() }; break;
      case 'plan': {
        // Debug: inspect the Plan lookup directly.
        var now = new Date();
        result = {
          today: formatDate(now),
          todayIso: isoDate_(now),
          todayKey: planDateKey_(now),
          planTab: PLAN_TAB,
          plan: loadPlan_()
        };
        break;
      }
      // ---- writes (serialised so two devices / a double-tap can't interleave rows) ----
      case 'addSession':          result = withLock_(function () { return addSession(payload); }); break;
      case 'appendExercise':      result = withLock_(function () { return appendExercise(payload); }); break;
      case 'updatePlanStatus':    result = withLock_(function () { return updatePlanStatus(payload); }); break;
      case 'updatePlanWeek':      result = withLock_(function () { return updatePlanWeek(payload); }); break;
      case 'updateStrengthStart': result = withLock_(function () { return updateStrengthStart(payload); }); break;
      default: result = { error: 'Unknown action: ' + action };
    }
    return json(result);
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { error: 'Sheet is busy — please retry.' };
  try { return fn(); } finally { lock.releaseLock(); }
}

// ============================================================
// SMALL HELPERS
// ============================================================

function str_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
function isBlank_(v) { return v === '' || v === null || v === undefined; }
function rowIsBlank_(row) { return row.every(isBlank_); }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }

// getValues() builds Date objects in the *script* time zone, so format with
// that zone too — otherwise a spreadsheet/script TZ mismatch shifts a day.
var TZ_ = Session.getScriptTimeZone();
function isoDate_(d) { return Utilities.formatDate(d, TZ_, 'yyyy-MM-dd'); }

function formatDate(d) {
  if (d instanceof Date && !isNaN(d)) return Utilities.formatDate(d, TZ_, DATE_FORMAT);
  return str_(d);
}

var MONTHS_ = { jan:0, january:0, feb:1, february:1, mar:2, march:2, apr:3, april:3,
                may:4, jun:5, june:5, jul:6, july:6, aug:7, august:7, sep:8, sept:8,
                september:8, oct:9, october:9, nov:10, november:10, dec:11, december:11 };

// Break a date-ish value into { y, m, d }. y is null when the source has no
// year (e.g. the string "May 4"). Accepts Date, "yyyy-MM-dd", "May 4",
// "May 4, 2026", "4 May 2026".
function dateParts_(raw) {
  if (raw instanceof Date && !isNaN(raw)) {
    return { y: raw.getFullYear(), m: raw.getMonth(), d: raw.getDate() };
  }
  var s = str_(raw);
  if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2] - 1, d: +m[3] };
  m = s.match(/(?:^|\D)(\d{1,2})(?!\d)\s+([A-Za-z]+)\.?(?:,?\s*(\d{4}))?/);      // 4 May[ 2026]
  if (m && MONTHS_[m[2].toLowerCase()] !== undefined) {
    return { y: m[3] ? +m[3] : null, m: MONTHS_[m[2].toLowerCase()], d: +m[1] };
  }
  m = s.match(/([A-Za-z]+)\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/); // May 4[, 2026]
  if (m && MONTHS_[m[1].toLowerCase()] !== undefined) {
    return { y: m[3] ? +m[3] : null, m: MONTHS_[m[1].toLowerCase()], d: +m[2] };
  }
  return null;
}

// Turn a client-supplied date into a real Date. A year-less date ("March 6")
// is assumed to be this year unless that lands more than 60 days in the
// future, in which case it's last year (saving Dec 31 on Jan 1).
function coerceDate_(raw) {
  var p = dateParts_(raw);
  if (!p) return null;
  var now = new Date();
  var y = p.y;
  if (y === null) {
    y = now.getFullYear();
    var guess = new Date(y, p.m, p.d);
    if (guess.getTime() - now.getTime() > 60 * 86400000) y -= 1;
  }
  var d = new Date(y, p.m, p.d);
  return isNaN(d) ? null : d;
}

// ============================================================
// EXERCISE CLASSIFICATION
// ============================================================

var TYPE_KEYWORDS = {
  cardio: ['run','jog','cycle','bike','cardio','treadmill','rowing','elliptical','swim','walk'],
  legs:   ['squat','leg press','leg ext','leg curl','calf','lunge','hip','glute','abduct',
           'adduct','rdl','deadlift','step up','step down','tib raise'],
  push:   ['bench','chest press','shoulder press','tricep','lateral raise','overhead press',
           'ohp','push','dip','db press','incline press','decline press','military press','fly','flye',
           'skull crusher','pushdown'],
  pull:   ['pull','row','chin','lat pulldown','curl','face pull','rear delt','shrug',
           'bicep','hammer','preacher','back extension']
};

function classifyExercise(name) {
  var n = str_(name).toLowerCase();
  // "Walking Lunge" is legs, not cardio — check the lunge before the walk.
  if (matchesAny(n, ['lunge'])) return 'legs';
  if (matchesAny(n, TYPE_KEYWORDS.cardio)) return 'cardio';
  if (matchesAny(n, TYPE_KEYWORDS.legs))   return 'legs';
  if (matchesAny(n, TYPE_KEYWORDS.push))   return 'push';
  if (matchesAny(n, TYPE_KEYWORDS.pull))   return 'pull';
  return 'other';
}

// Keyword must start at a word boundary: "run" matches "Running" but not
// "Abs Crunch"; "chin" matches "Chin Up" but not "Machine Chest Press".
// (Plain indexOf used to make every "Machine …" lift a 4-min-rest compound.)
function matchesAny(text, keywords) {
  for (var i = 0; i < keywords.length; i++) {
    var kw = keywords[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(^|[^a-z])' + kw).test(text)) return true;
  }
  return false;
}

function isCompound(name) {
  var n = str_(name).toLowerCase();
  var compounds = ['bench','squat','deadlift','row','pull up','pulldown','chin',
                   'overhead press','ohp','shoulder press','chest press','leg press',
                   'rdl','incline press'];
  return matchesAny(n, compounds);
}

// Binary rest defaults: 4 min for compounds, 2 min for everything else.
function suggestedRest(name) { return isCompound(name) ? 240 : 120; }

// "Sit up" / "Sit Up" / "Situp" / "Chest fly" / "Chest Fly" collapse to one key.
function exerciseKey_(name) {
  return str_(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Column E as written by the app ("Push", "Pull", "Legs", "Cardio"). Anything
// else ("Body Weight Home Training") returns '' and we fall back to voting.
function normalizeSessionType_(raw) {
  var s = str_(raw).toLowerCase();
  if (/^push/.test(s)) return 'push';
  if (/^pull/.test(s)) return 'pull';
  if (/^leg/.test(s))  return 'legs';
  if (/^cardio|^run/.test(s)) return 'cardio';
  return '';
}

// Majority vote over an exercise list.
function inferSessionType_(exerciseNames) {
  var votes = { push: 0, pull: 0, legs: 0, cardio: 0, other: 0 };
  exerciseNames.forEach(function (ex) { votes[classifyExercise(ex)]++; });
  var best = 'other', max = 0;
  Object.keys(votes).forEach(function (t) { if (votes[t] > max) { max = votes[t]; best = t; } });
  return best;
}

// Parse a run entry like "4.51k @7:57, acc. 4.51k" or
// "Long Run · 7.04k @8.33, acc. 7.04k (Endurance)". Returns km / pace or nulls.
function parseRun_(text) {
  var s = str_(text);
  var out = { km: null, paceSec: null, pace: '' };
  var mk = s.match(/(\d+(?:[.,]\d+)?)\s*k(?:m)?\b/i);
  if (mk) out.km = parseFloat(mk[1].replace(',', '.'));
  var mp = s.match(/@\s*(?:pace\s*)?(\d{1,2})[.:'](\d{2})\b/i);
  if (mp) {
    out.paceSec = (+mp[1]) * 60 + (+mp[2]);
    out.pace = mp[1] + ':' + mp[2];
  }
  return out;
}

// ============================================================
// LOG TAB PARSING
// ============================================================

// Read one log tab (cols A..E only) into flat exercise rows plus session
// blocks. A block starts at any row with a date in column A and runs until
// the next dated row. Header rows ("Date | Exercise | …") are skipped.
function readLogTab_(sheet) {
  var name = sheet.getName();
  var lastRow = sheet.getLastRow();
  var rows = [], sessions = [];
  if (lastRow < 1) return { rows: rows, sessions: sessions };

  var values = sheet.getRange(1, 1, lastRow, 6).getValues();   // A..F (F = client id)
  var current = null;

  for (var r = 0; r < values.length; r++) {
    var v = values[r];
    var exercise = str_(v[1]), sets = str_(v[2]), notes = str_(v[3]);

    if (!isBlank_(v[0])) {
      if (str_(v[0]).toLowerCase() === 'date') continue;     // header row
      var d = (v[0] instanceof Date) ? v[0] : coerceDate_(v[0]);
      current = {
        tab: name,
        startRow: r + 1,
        date: formatDate(d || v[0]),
        iso: d ? isoDate_(d) : null,
        sessionLabel: str_(v[4]),                  // raw column E
        sessionType: normalizeSessionType_(v[4]),  // canonical, filled below if ''
        clientId: str_(v[5]),                      // set by the offline app (col F)
        exercises: []
      };
      sessions.push(current);
    }

    if (!exercise || !sets) continue;
    if (!current) {                                  // data before any date — keep it, undated
      current = { tab: name, startRow: r + 1, date: '', iso: null, sessionLabel: '', sessionType: '', clientId: '', exercises: [] };
      sessions.push(current);
    }

    var row = {
      tab: name, row: r + 1,
      date: current.date, iso: current.iso,
      exercise: exercise, sets: sets, notes: notes,
      clientId: str_(v[5]),
      sessionType: ''                                // filled after the block is complete
    };
    rows.push(row);
    current.exercises.push(row);
  }

  sessions.forEach(function (s) {
    if (!s.sessionType) s.sessionType = inferSessionType_(s.exercises.map(function (e) { return e.exercise; }));
    s.exercises.forEach(function (e) { e.sessionType = s.sessionType; });
  });

  return { rows: rows, sessions: sessions };
}

// ============================================================
// BOOTSTRAP
// ============================================================

function bootstrap() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabs = ss.getSheets().map(function (s) { return s.getName(); });

  var allRows = [], allSessions = [], missingTabs = [];
  LOG_TABS.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) { missingTabs.push(name); return; }
    var parsed = readLogTab_(sheet);
    allRows = allRows.concat(parsed.rows);
    allSessions = allSessions.concat(parsed.sessions);
  });

  var strengthPlan = loadStrengthPlan_();
  var strengthByKey = {};
  (strengthPlan || []).forEach(function (p) { strengthByKey[exerciseKey_(p.exercise)] = p; });

  // ---- per-exercise history (all LOG_TABS) ----
  var exerciseMap = {};
  allRows.forEach(function (row) {
    var key = exerciseKey_(row.exercise);
    var e = exerciseMap[key];
    if (!e) {
      e = exerciseMap[key] = {
        key: key,
        name: row.exercise,
        aliases: [],
        type: classifyExercise(row.exercise),
        restSec: suggestedRest(row.exercise),
        history: [],
        count: 0,
        lastDone: null,
        strength: strengthByKey[key] || null
      };
    }
    e.name = row.exercise;                 // newest spelling wins as display name
    if (e.aliases.indexOf(row.exercise) === -1) e.aliases.push(row.exercise);
    e.history.push(row);
    e.count++;
    if (row.iso && (!e.lastDone || row.iso > e.lastDone)) e.lastDone = row.iso;
  });

  var exercises = Object.keys(exerciseMap).map(function (k) {
    var e = exerciseMap[k];
    e.history = e.history.slice().reverse();   // newest first
    return e;
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });

  // ---- active-block stats (co-occurrence / order / type frequency) ----
  var activeSessions = allSessions.filter(function (s) { return s.tab === ACTIVE_TAB; });
  var activeRows = allRows.filter(function (r) { return r.tab === ACTIVE_TAB; });

  var freq = {}, nextAfter = {}, typeFrequency = {};
  activeSessions.forEach(function (s) {
    var names = s.exercises.map(function (e) { return e.exercise; });
    names.forEach(function (ex, i) {
      freq[ex] = (freq[ex] || 0) + 1;
      if (i < names.length - 1) {
        nextAfter[ex] = nextAfter[ex] || {};
        nextAfter[ex][names[i + 1]] = (nextAfter[ex][names[i + 1]] || 0) + 1;
      }
      typeFrequency[ex] = typeFrequency[ex] || { push: 0, pull: 0, legs: 0, cardio: 0, other: 0 };
      typeFrequency[ex][s.sessionType] = (typeFrequency[ex][s.sessionType] || 0) + 1;
    });
  });

  // ---- runs, parsed from cardio rows (feeds km-vs-plan, pace trend) ----
  var runs = allRows.filter(function (r) {
    return classifyExercise(r.exercise) === 'cardio';   // per exercise, not per session
  }).map(function (r) {
    var p = parseRun_(r.sets);
    return { tab: r.tab, row: r.row, date: r.date, iso: r.iso, exercise: r.exercise,
             km: p.km, pace: p.pace, paceSec: p.paceSec, raw: r.sets, notes: r.notes };
  });

  var stats = {
    frequency: freq,
    nextAfter: nextAfter,
    typeFrequency: typeFrequency,
    sessionCount: activeSessions.length
  };

  return {
    ok: true,
    version: API_VERSION,
    tabs: tabs,
    logTabs: LOG_TABS,
    missingLogTabs: missingTabs,
    activeTab: ACTIVE_TAB,
    latestTab: LATEST_TAB,       // legacy
    outputTab: OUTPUT_TAB,       // legacy
    exercises: exercises,
    // Every exercise row from the active block, newest first.
    recentSessions: activeRows.slice().reverse(),
    // Session blocks (newest first) — one entry per dated block, with its
    // exercises, canonical type and the sheet row where it starts.
    sessions: allSessions.slice().reverse().map(function (s) {
      return { tab: s.tab, startRow: s.startRow, date: s.date, iso: s.iso,
               sessionType: s.sessionType, sessionLabel: s.sessionLabel, clientId: s.clientId,
               exercises: s.exercises.map(function (e) { return e.exercise; }),
               rows: s.exercises.map(function (e) {
                 return { row: e.row, exercise: e.exercise, sets: e.sets, notes: e.notes, clientId: e.clientId };
               }) };
    }),
    runs: runs.slice().reverse(),
    stats: stats,
    sheet8: stats,               // legacy name
    plan: loadPlan_(),
    strengthPlan: strengthPlan
  };
}

// ============================================================
// PPL STRENGTH TAB
// ============================================================

// Flat list of prescriptions: { day, exercise, target, setsReps, start,
// increment, notes, row }. Returns null if the tab is absent.
function loadStrengthPlan_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STRENGTH_TAB);
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var values = sheet.getRange(1, 1, lastRow, 6).getValues();
  var out = [], day = '';
  for (var r = 0; r < values.length; r++) {
    var a = str_(values[r][0]), c = str_(values[r][2]);
    if (/^push\b/i.test(a)) { day = 'Push'; continue; }
    if (/^pull\b/i.test(a)) { day = 'Pull'; continue; }
    if (/^legs\b/i.test(a)) { day = 'Legs'; continue; }
    if (!a || a.toLowerCase() === 'exercise') continue;
    if (!/\d\s*[×x]\s*\d/.test(c)) continue;          // exercise rows have "N × R"
    out.push({
      day: day, row: r + 1, exercise: a,
      target: str_(values[r][1]), setsReps: c,
      start: str_(values[r][3]), increment: str_(values[r][4]), notes: str_(values[r][5])
    });
  }
  return out;
}

// Advance an exercise's "Start" weight (column D). Payload: { exercise, start }.
function updateStrengthStart(payload) {
  if (!payload || !payload.exercise) return { error: 'Missing exercise' };
  if (isBlank_(payload.start)) return { error: 'Missing start' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STRENGTH_TAB);
  if (!sheet) return { error: 'Strength tab not found' };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: 'Strength tab is empty' };

  var values = sheet.getRange(1, 1, lastRow, 3).getValues();
  var target = exerciseKey_(payload.exercise);
  for (var r = 0; r < values.length; r++) {
    var a = str_(values[r][0]), c = str_(values[r][2]);
    if (!/\d\s*[×x]\s*\d/.test(c)) continue;
    if (exerciseKey_(a) === target) {
      sheet.getRange(r + 1, 4).setValue(payload.start);
      return { ok: true, row: r + 1, exercise: a, start: payload.start };
    }
  }
  return { error: 'Exercise not found in Strength tab: ' + payload.exercise };
}

// ============================================================
// PLAN TAB
// ============================================================

// Year-aware when both sides carry a year; falls back to month/day otherwise.
function planDateMatches_(a, b) {
  var pa = dateParts_(a), pb = dateParts_(b);
  if (!pa || !pb) return false;
  if (pa.m !== pb.m || pa.d !== pb.d) return false;
  if (pa.y !== null && pb.y !== null) return pa.y === pb.y;
  return true;
}

// Legacy "month:day" key (still used by the debug action).
function planDateKey_(raw) {
  var p = dateParts_(raw);
  return p ? p.m + ':' + p.d : null;
}

// Whole Plan tab → rows, weekly aggregates, today's row and the next
// unfinished session. Returns null when the tab is absent.
function loadPlan_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PLAN_TAB);
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var values = sheet.getRange(2, 1, lastRow - 1, 10).getValues();

  var todayIso = isoDate_(new Date());
  var rows = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (isBlank_(row[0])) continue;
    var d = (row[0] instanceof Date) ? row[0] : coerceDate_(row[0]);
    if (!d) continue;
    var runKm = row[5];
    if (isBlank_(runKm)) runKm = null;
    else if (typeof runKm === 'string') { var n = parseFloat(runKm); runKm = isNaN(n) ? null : n; }
    rows.push({
      row: r + 2,
      date: formatDate(d),
      iso: isoDate_(d),
      dateKey: planDateKey_(d),
      day: str_(row[1]),
      week: row[2],
      phase: str_(row[3]),
      session: str_(row[4]),
      runKm: runKm,
      targetPace: str_(row[6]),
      lift: str_(row[7]),
      notes: str_(row[8]),
      status: str_(row[9]).toUpperCase()
    });
  }

  // Weekly aggregates — one entry per Wk number, in sheet order.
  var byWeek = {}, weekOrder = [];
  rows.forEach(function (rr) {
    var w = rr.week;
    if (isBlank_(w)) return;
    if (!byWeek[w]) {
      byWeek[w] = { week: w, phase: rr.phase, dateStart: rr.date, dateEnd: rr.date,
                    isoStart: rr.iso, isoEnd: rr.iso,
                    totalKm: 0, longKm: 0, easyKm: 0, qualitySession: '',
                    sessionCount: 0, runDays: 0, liftDays: 0, restDays: 0,
                    doneCount: 0, skippedCount: 0 };
      weekOrder.push(w);
    }
    var b = byWeek[w];
    b.dateEnd = rr.date; b.isoEnd = rr.iso;
    if (typeof rr.runKm === 'number') b.totalKm += rr.runKm;
    var sessLow = rr.session.toLowerCase();
    if (sessLow.indexOf('long') !== -1 && rr.runKm) b.longKm = Math.max(b.longKm, rr.runKm);
    if (sessLow.indexOf('rest') !== -1) b.restDays++;
    else if (rr.lift) b.liftDays++;
    else if (rr.runKm) b.runDays++;
    if (!b.qualitySession && /tempo|interval|hmp|tune-up|strides|race day/i.test(rr.session)) {
      b.qualitySession = rr.session;
    }
    if (rr.status === 'DONE') b.doneCount++;
    if (rr.status === 'SKIPPED') b.skippedCount++;
    b.sessionCount++;
  });
  var weeks = weekOrder.map(function (k) {
    var b = byWeek[k];
    b.totalKm = Math.round(b.totalKm * 10) / 10;
    b.easyKm = Math.round((b.totalKm - b.longKm) * 10) / 10;
    return b;
  });

  var today = null, next = null, overdue = [];
  rows.forEach(function (rr) {
    if (rr.iso === todayIso) today = rr;
    if (!next && rr.iso >= todayIso && !rr.status) next = rr;
    if (rr.iso < todayIso && !rr.status && !/rest/i.test(rr.session)) overdue.push(rr);
  });

  var done = rows.filter(function (rr) { return rr.status === 'DONE'; }).length;
  return {
    rows: rows,
    weeks: weeks,
    today: today,
    next: next,
    overdue: overdue,
    summary: { todayIso: todayIso, total: rows.length, done: done,
               skipped: rows.filter(function (rr) { return rr.status === 'SKIPPED'; }).length,
               remaining: rows.filter(function (rr) { return !rr.status; }).length }
  };
}

// Set Status (col J) and optionally Notes (col I) for the Plan row on a date.
// Payload: { date, status, notes? } — pass notes (even '') to overwrite,
// omit the field to leave Notes alone.
function updatePlanStatus(payload) {
  if (!payload || !payload.date) return { error: 'Missing date' };
  var status = str_(payload.status).toUpperCase();
  if (status && !/^(DONE|SKIPPED|POSTPONED)$/.test(status)) {
    return { error: 'Status must be DONE, SKIPPED, POSTPONED, or empty.' };
  }
  var hasNotes = Object.prototype.hasOwnProperty.call(payload, 'notes');
  var notes = hasNotes ? str_(payload.notes) : null;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PLAN_TAB);
  if (!sheet) return { error: 'Plan tab not found' };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: 'Plan tab is empty' };
  if (!dateParts_(payload.date)) return { error: 'Invalid date format: ' + payload.date };

  var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var r = 0; r < values.length; r++) {
    if (planDateMatches_(values[r][0], payload.date)) {
      sheet.getRange(r + 2, 10).setValue(status);
      if (notes !== null) sheet.getRange(r + 2, 9).setValue(notes);
      return { ok: true, row: r + 2, status: status, notesWritten: notes !== null };
    }
  }
  return { error: 'Date not found in Plan tab: ' + payload.date };
}

// Rewrite columns E..I for every row of one week, in date order.
// Payload: { week, sessions: [ { session, runKm, targetPace, lift, notes }, … ] }
function updatePlanWeek(payload) {
  if (!payload || isBlank_(payload.week)) return { error: 'Missing week' };
  if (!payload.sessions || !payload.sessions.length) return { error: 'Missing sessions' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PLAN_TAB);
  if (!sheet) return { error: 'Plan tab not found' };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: 'Plan tab is empty' };

  var weekCol = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
  var idx = [];
  for (var i = 0; i < weekCol.length; i++) {
    if (String(weekCol[i][0]) === String(payload.week)) idx.push(i);
  }
  if (!idx.length) return { error: 'Week not found: ' + payload.week };
  if (idx.length !== payload.sessions.length) {
    return { error: 'Session count mismatch: sheet has ' + idx.length + ', client sent ' + payload.sessions.length };
  }

  // Plan weeks are contiguous rows, so write the block in one call.
  var contiguous = idx[idx.length - 1] - idx[0] === idx.length - 1;
  var newVals = payload.sessions.map(function (s) {
    s = s || {};
    return [ s.session || '', isBlank_(s.runKm) ? '' : s.runKm, s.targetPace || '', s.lift || '', s.notes || '' ];
  });
  if (contiguous) {
    sheet.getRange(idx[0] + 2, 5, newVals.length, 5).setValues(newVals);
  } else {
    idx.forEach(function (rowIdx, i) { sheet.getRange(rowIdx + 2, 5, 1, 5).setValues([newVals[i]]); });
  }
  return { ok: true, updatedRows: idx.length, week: payload.week };
}

// ============================================================
// WRITES TO THE ACTIVE LOG TAB
// ============================================================

function getOrCreateOutputSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(OUTPUT_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(OUTPUT_TAB);
    sheet.getRange(1, 1, 1, 6).setValues([['Date','Exercise','Sets','Notes','Session Type','Client ID']]);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Find the sheet row whose column F holds clientId, or 0.
function findClientIdRow_(sheet, clientId) {
  if (!clientId) return 0;
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return 0;
  var col = sheet.getRange(1, 6, lastRow, 1).getValues();
  for (var r = 0; r < col.length; r++) if (str_(col[r][0]) === clientId) return r + 1;
  return 0;
}

// Append a session block. The date goes in column A of the first row as a
// real Date (so the year is never guessed by Sheets); following exercises
// leave A and E blank to keep the visual grouping. Column F carries the
// client-generated ids so an offline client can retry safely: if the
// session's clientId is already in the sheet, nothing is written and the
// existing startRow is returned.
// Payload: { clientId?, date, sessionType?, entries: [ { clientId?, exercise, sets, notes? }, … ] }
function addSession(payload) {
  if (!payload || !payload.entries || !payload.entries.length) return { error: 'No entries' };
  var entries = payload.entries.filter(function (en) { return en && str_(en.exercise) && str_(en.sets); });
  if (!entries.length) return { error: 'Every entry needs an exercise and sets' };

  var dateVal = coerceDate_(payload.date) || new Date();
  var sheet = getOrCreateOutputSheet_();
  var clientId = str_(payload.clientId);

  var existing = findClientIdRow_(sheet, clientId);
  if (existing) {
    return { ok: true, duplicate: true, tab: OUTPUT_TAB, startRow: existing,
             entriesCount: 0, date: formatDate(dateVal), iso: isoDate_(dateVal) };
  }

  var lastRow = sheet.getLastRow();
  var startRow = lastRow + 1;
  if (lastRow >= 1) {
    var lastContent = sheet.getRange(lastRow, 1, 1, 6).getValues()[0];
    if (!rowIsBlank_(lastContent)) startRow = lastRow + 2;   // one blank separator row
  }

  var rows = entries.map(function (en, idx) {
    return [
      idx === 0 ? dateVal : '',
      str_(en.exercise),
      str_(en.sets),
      str_(en.notes),
      idx === 0 ? str_(payload.sessionType) : '',
      idx === 0 ? clientId : str_(en.clientId)
    ];
  });

  sheet.getRange(startRow, 1, rows.length, 6).setValues(rows);
  sheet.getRange(startRow, 1).setNumberFormat(DATE_FORMAT);

  return {
    ok: true,
    tab: OUTPUT_TAB,
    startRow: startRow,
    entriesCount: rows.length,
    date: formatDate(dateVal),
    iso: isoDate_(dateVal)
  };
}

// Append one exercise row to an existing block (per-exercise save, so a
// crash mid-session loses nothing). Walks from startRow to the first blank
// row — the block separator — and writes there. If clientId is already
// present in that block, the row is returned without writing.
// Payload: { startRow, clientId?, exercise, sets, notes? }
function appendExercise(payload) {
  if (!payload) return { error: 'Missing payload' };
  if (!str_(payload.exercise)) return { error: 'Missing exercise' };
  if (!str_(payload.sets)) return { error: 'Missing sets' };
  var startRow = parseInt(payload.startRow, 10);
  if (isNaN(startRow) || startRow < 1) return { error: 'Invalid startRow' };
  var clientId = str_(payload.clientId);

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OUTPUT_TAB);
  if (!sheet) return { error: 'Output tab not found' };

  var sheetLastRow = sheet.getLastRow();
  if (startRow > sheetLastRow + 1) {
    return { error: 'startRow ' + startRow + ' is past the end of the sheet (' + sheetLastRow + ')' };
  }

  var warning = null;
  var endRow = startRow;
  if (startRow <= sheetLastRow) {
    // One read for the whole tail instead of one call per row.
    var block = sheet.getRange(startRow, 1, sheetLastRow - startRow + 1, 6).getValues();
    if (isBlank_(block[0][0])) warning = 'startRow has no date in column A — is this really the first row of the session?';
    var i = 0;
    while (i < block.length && !rowIsBlank_(block[i])) {
      if (clientId && str_(block[i][5]) === clientId) {
        return { ok: true, duplicate: true, row: startRow + i, tab: OUTPUT_TAB };
      }
      i++;
    }
    endRow = startRow + i;
    // Appending to an older block: the blank row we found is the separator
    // before the next session. Insert a fresh row so blocks stay separated.
    if (endRow < sheetLastRow) sheet.insertRowsBefore(endRow, 1);
  }

  sheet.getRange(endRow, 1, 1, 6).setValues([[
    '', str_(payload.exercise), str_(payload.sets), str_(payload.notes), '', clientId
  ]]);

  var out = { ok: true, row: endRow, tab: OUTPUT_TAB };
  if (warning) out.warning = warning;
  return out;
}
