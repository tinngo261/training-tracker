# Training Tracker

Offline-first training log (Android PWA) backed by a Google Sheet.

```
TrainingTracker/
├── Code.js            Apps Script backend (v6) — deploy as a web app
├── appsscript.json    Apps Script manifest
├── app/               The PWA — host these static files anywhere over https
│   ├── index.html
│   ├── app.js         all app logic (no framework, no build step)
│   ├── styles.css
│   ├── sw.js          service worker: caches the app shell for offline launch
│   ├── manifest.webmanifest
│   └── icon.svg / icon-192.png / icon-512.png
└── README.md
```

Sheet: https://docs.google.com/spreadsheets/d/1pfnP2fm2JREVa_3vpsibkurN5IuJYK60L4tLmvRzW5w

## How offline works

| Where | What lives there |
|---|---|
| `localStorage tt.snapshot` | The last full `bootstrap` response — every exercise, session, plan row, strength target. This is what every screen renders from, online or not. |
| `localStorage tt.sessions` | Sessions logged on the phone. Each exercise is flagged `synced` once the sheet has it. |
| `localStorage tt.outbox` | Queued plan-status / strength-start updates. |

**Sync** (automatic on launch, on every save while online, when the network comes back, or by tapping the badge):

1. **Push** — unsynced sessions go up via `addSession` (first exercise) / `appendExercise` (later ones); then the outbox.
2. **Pull** — a fresh `bootstrap` replaces the snapshot.
3. **Reconcile** — local sessions whose `clientId` came back from the sheet are marked synced and dropped from the local list.

Every write carries a client-generated `clientId` (stored in hidden column F of the sheet). If a request succeeds but the reply is lost (tunnel, dead battery), the retry is recognised server-side and **no duplicate row is written**.

Nothing pending is ever deleted automatically. The More tab lists what's waiting.

## Setup

### 1. Backend (Apps Script)

1. Open the sheet → Extensions → Apps Script.
2. Replace `Code.gs` with the contents of `Code.js`.
3. Deploy → **New deployment** → type *Web app* → *Execute as: Me*, *Who has access: **Anyone*** (needed so the phone can call it without a Google login).
4. Copy the `…/exec` URL. Re-deploying later: Manage deployments → ✏️ → New version (URL stays the same).
5. Sanity check: open `<url>?action=ping` — should return `"version": 6`.

`Code.js` config (top of file):

| Constant | Purpose |
|---|---|
| `ACTIVE_TAB` | Current block — where new sessions are written |
| `LOG_TABS` | Tabs in the log layout that feed history (only these are read) |
| `PLAN_TAB`, `STRENGTH_TAB` | Optional plan / PPL tabs |

### 2. Host the app (once)

Any static https host works. GitHub Pages is free:

```bash
cd ~/Desktop/TrainingTracker
git init && git add . && git commit -m "Training tracker"
gh repo create training-tracker --private --source=. --push
gh api -X POST repos/{owner}/training-tracker/pages -f build_type=legacy -f 'source[branch]=main' -f 'source[path]=/'
```

The app is then at `https://<you>.github.io/training-tracker/app/`. (Private repos need GitHub Pro for Pages — otherwise make the repo public; it contains no secrets, the API URL is entered on the phone.)

Alternatives: Netlify Drop (drag the `app/` folder onto netlify.com/drop), Cloudflare Pages, Firebase Hosting.

### 3. Install on Android

1. Open the app URL in Chrome.
2. **More** tab → paste the Apps Script `/exec` URL → **Save & test** → it pulls the sheet.
3. Chrome ⋮ → **Add to Home screen** (or tap **Install app** in More when Chrome offers it).

From then on it opens full-screen from the launcher and works with no signal.

## Using it

- **Home** — today's plan row (Done / Skip), week streak, sessions & km this week vs plan, recent sessions.
- **Log** — start a session (type pre-picked from today's plan). Exercise suggestions come from *your* frequency + what you usually do next. Each exercise shows the PPL target, the last 3 entries, a rest timer (4 min compounds / 2 min others, vibrates), and saves immediately on **Finish exercise**. Cardio sessions get a distance/pace form and mark the plan row `Done · 5.2km @ 7:36/km`.
- **Double progression** — hit the top of the rep range on all working sets and the app offers to bump the exercise's *Start* in the PPL Strength tab.
- **History / Exercises** — every session; per-exercise top-set chart and full history, spelling variants merged (`Sit Up` / `Situp`).
- **Plan** — weekly running plan with ✓ / ✗ per day, plus the Strength template with your latest set for each lift.
- **More** — connection, sync status, pending queue, export JSON, install.

## Sets syntax (same as the sheet)

`W:14.5x10, 19.5x8, 24.5x8x2` → warm-up 14.5×10, then 19.5×8, then 24.5×8 for 2 sets. `BW x 12`, `x5` (repeat last weight), and notes in parentheses are understood.

## Developing

- Backend: edit `Code.js`, paste into Apps Script (or `npm i && npx clasp push` with your Script ID in `.clasp.json`).
- App: edit files in `app/`, bump `VERSION` in `sw.js` so installed phones pick up the new shell, redeploy the static host.
- Quick local run: `python3 -m http.server 8765 -d app` and open http://localhost:8765 (service worker works on localhost).
