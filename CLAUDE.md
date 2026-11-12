# CLAUDE.md — AskGamblers / CasinoGuru Complaint Scraper

> Project-context for Claude Code. **This repo is the Render scraper server**
> (`server.js`). The **Google Apps Script** that drives it is NOT stored here — it's
> reached directly via **clasp** against a personal-account copy of the sheet. This
> file documents both so you have the full picture and the two deploy paths.

---

## This repo
```
CLAUDE.md
server.js      ← the Render scraper service (edit this)
dockerfile     ← installs Chromium + fonts, runs server.js
package.json   ← deps incl. puppeteer-extra, stealth, proxy-chain
```
Not in this repo: the Google Sheets, the **n8n** workflow (CasinoGuru only), and the
Apps Script `.gs` files (those live in Google — see "Apps Script" below).

> An older project blurb may say **Vercel** / **Casino Guru**. Outdated — the live
> AskGamblers path is **Render** + the AG Apps Script.

---

## The full system
```
Google Sheet ──> Apps Script (.gs) ──HTTP──> Render (server.js) ──> WebShare proxy ──> AskGamblers
 (trackers)      (daily trigger,              (Puppeteer           (residential or     (Cloudflare-
                  batches, writes             scraper)             datacenter)         protected)
                  results back)
```
Apps Script runs daily, reads pending casinos, calls
`GET /api/scrape?url=...&secret=...` one at a time (with pauses), writes JSON back.

### Two instances — note the asymmetry
| | Sheet 1 (MAIN — work here) | Sheet 2 (secondary) |
|---|---|---|
| Render service | `ag-scraper` | `ag-scraper-1` |
| URL | `https://ag-scraper.onrender.com` | `https://ag-scraper-1.onrender.com` |
| Casinos | ~113 | ~15 |
| WebShare account | Static Residential (20 IPs, 250 GB/mo) | free datacenter (10 IPs, 1 GB/mo) |
| GAS config | `RENDER_URL=ag-scraper`, `AG_DAILY_HOUR=6` | `RENDER_URL=ag-scraper-1`, `AG_DAILY_HOUR=8` |

- **Server:** ONE `server.js` → `git push` auto-deploys **both** Render services. The
  only per-service difference is the `WS_API_KEY` **env var** in Render, not in code.
- **Apps Script:** do the work on **Sheet 1's** project. Sheet 2 is near-identical and
  gets the fix hand-copied afterward — when copying, leave its `RENDER_URL` and
  `AG_DAILY_HOUR` lines alone.

---

## Environment variables (set per-service in Render, not in this repo)
- `WS_API_KEY` — **required** (exits on startup if missing). Selects the proxy pool.
- `AG_SECRET` — if set, requests must pass matching `?secret=`; if unset, skipped. The
  GAS sends it as `?secret=`. **Never write its value in this repo — the repo is public.**
- `CHROMIUM_PATH` — Chromium binary (default `/usr/bin/chromium`).
- `PORT` — provided by Render.

---

## SERVER — `server.js`

### Flow
1. `GET /api/scrape?url=<complaintUrl>&secret=<AG_SECRET>`.
2. Tries **direct** (Render IP): `scrapeCasino(url, "direct", null)`.
3. If title is `Just a moment...` / `Attention Required` (Cloudflare) → **proxy**
   fallback: `getProxyForUrl(url)` picks one proxy deterministically (md5(url) → same
   casino, same IP, builds CF trust), then `scrapeCasino(url, "proxy", host)`.
4. Returns `{ ok, title, resolved, rejected, unresolved, open, total, openEntries[] }`
   or `{ ok:false, error, cfBlocked }`. `openEntries[]` = `{ hoursLeft, timer:"2d 7h", url }`.
   Only `askgamblers.com` URLs are accepted; a `/reviews/<slug>` link is rewritten to
   `/reviews/<slug>/complaints`.

### Parsing — AskGamblers markup since the 2026 redesign (`parseComplaintsDom`)
- **Counts** come from the "Filter by Status" sidebar, AskGamblers' own exact totals —
  no pagination: `a.filters-links-dropdown__option` → `.filters-links-dropdown__label` +
  `.filters-links-dropdown__count`, keyed by the link's `?status=`:
  `solved`→Resolved, `rejected`→Rejected, `unsolved`→Unresolved, `open`→In Progress
  (= sheet **Open**), no status param → **All** (= sheet **Total**). A status with 0
  complaints is omitted from the sidebar → 0.
- **Open timers**: open cards are `a.complaint-card` with
  `.complaint-status__text` = `"55h"` (+ "left"); closed cards show an icon. The first
  page holds 24 cards (rest via a JS "Load more"); if In Progress > open cards on page 1,
  the `?status=open` page is loaded once for the remaining timers.
- **Fresh data**: the page is fetched with a unique `_cb=` param — Cloudflare's edge
  cache otherwise serves copies hours old. Same single request, no extra load.
- **Fail loudly**: missing sidebar, an unknown status, or All ≠ sum of statuses →
  `ok:false, error:"Parse failed: …"` (no proxy fallback), so the sheet shows ERROR
  instead of wrong numbers. Log lines: `[parse] ✓ … All=25 R=23 …` / `[parse] ✗ …`.
- The pre-2026 parser counted each card ~4× through nested `[class*='complaint-card']`
  matches and required exact status text — every stored Total was a multiple of 4.
5. **Single shared browser** — reused, restarted on health-check failure / scrape-count
   limit / memory pressure; resets + cools down after `CONSECUTIVE_FAIL_LIMIT`. No
   per-request isolation → concurrent `/api/scrape` calls are unsafe (see GAS lock).

### proxy-chain (DO NOT revert)
Residential proxies need auth, but `page.authenticate()` conflicts with
`page.setRequestInterception(true)` (used to block images/fonts/media) — the auth
challenge is swallowed and the request hangs ~65s (`Proxy timeout 65000ms`). Fix in
place: `proxy-chain`'s `anonymizeProxy()` wraps the authenticated upstream in a local
`http://127.0.0.1:PORT` proxy with creds baked in; Chrome gets `--proxy-server=<local>`
and no `page.authenticate()`. Created at launch, closed on reset. **Never re-add
`page.authenticate()`. Never remove `proxy-chain`.** Success log: `Launching PROXY
<ip>:<port> via local http://127.0.0.1:<p>`.

### Tunable constants (top of `server.js` — read file for current values)
- `MAX_SCRAPES_PER_BROWSER` — restart browser after N scrapes.
- `MEMORY_RESTART_MB` — periodic guard resets browser when RSS exceeds this (~380).
- Pages per casino: 1 (2 only when open cases sit beyond the first 24 cards).
- `--js-flags=--max-old-space-size=N` — V8 heap ceiling.
- `SCRAPE_TIMEOUT`, `LAUNCH_TIMEOUT`, `CONSECUTIVE_FAIL_LIMIT`, `COOLDOWN_MS`.

### Endpoints
- `GET /health` → `{ ok, rss_mb, heap_mb, browser_alive, browser_mode, scrape_count,
  consecutive_fails, proxy_pool_size }`
- `GET /` → status, `version`, memory, browser, webshare pool
- `GET /refresh-proxies?secret=` → force re-pull the proxy list

---

## APPS SCRIPT (not in this repo — reached via clasp)

The `.gs` code lives in Google, attached to the sheet. Access it with **clasp**
(`clasp pull` → edit → `clasp push`) against the personal-account copy. If clasp
isn't set up / available, the fallback is: edit the `.gs` locally and the human
pastes it into the Apps Script editor. Either way, **after fixing Sheet 1, the fix is
hand-copied into Sheet 2** (leave Sheet 2's `RENDER_URL` / `AG_DAILY_HOUR` lines).

### Files (one namespace per project)
- **`AskGamblers Scrape.gs`** — AG driver. 3 casinos/run, chains via ~30s trigger,
  calls Render, writes results, auto-retries ERROR rows. Most AG work is here.
- **`CasinoGuru Scrape.gs`** — CG scraper (n8n phase 1 + GAS fallback phase 2). Not
  part of AskGamblers issues.
- **`Shared Helpers.gs`** — `todayStamp`, `nowTimestamp`, `isUpdatedToday`.
- **`Menu.gs`** — custom menus + status dialogs.
- **`Archive.gs`** — daily 22:00 snapshot; waits/retries if a scrape is running.
- **`Open Cases.gs`** — rebuilds read-only "Open Cases" tabs (cols A/B only; C+ is the
  team's) from the live tabs' rich text.

### Critical GAS rules — do NOT reintroduce old bugs
These encode a past incident where the scraper crash-looped Render for a day:
1. **Concurrency lock.** `scrapeAskGamblersBatch()` and `retryAskGamblersErrors()`
   MUST start with `LockService.getScriptLock()` + `tryLock(5000)`, released in a
   `finally`. The single shared Render browser means two overlapping GAS runs collide
   and crash-loop it.
2. **Force-refresh must shrink.** `scrapeAskGamblersBatchForce()` computes the full
   row list, stores it in `AG_PROP_ROWS`, and shrinks it each hop. The old bug set a
   flag and re-picked the same first 3 rows forever (infinite loop).
3. **Trigger visibility.** `ScriptApp.getProjectTriggers()` returns only the current
   user's triggers — another user's trigger can't be deleted in code. The guaranteed
   kill-switch for a runaway self-rescheduling chain is to **rename the handler
   function** so pending triggers fire into nothing.
4. **Open Cases hooks.** Call `rebuildOpenCasesAg()` / `rebuildOpenCasesCg()` at every
   true completion point (all done, no errors, retry exhausted).

### Known GAS gotchas
- Sheet 2's `AskGamblers Scrape.gs` has lagged behind Sheet 1's before — confirm it's
  not running stale (pre-lock) code when fixing AG.
- `runHybridBatch()` (CG) still lacks the LockService guard AG has — a known
  follow-up, not yet done.
- CG has no separate retry chain (AG does), so a persistently-failing CG casino waits
  for the next daily run.

---

## Known constraints & failure modes (hard-won)

### Render free tier = 512 MB RAM — the #1 recurring failure
**Root cause found & fixed (v6.1, 2026-11-12):** `getBrowser()` recycled the browser
after `MAX_SCRAPES_PER_BROWSER` by setting `state.browser = null` *before* the close,
so every recycle leaked a whole Chromium (~100 MB). Render's memory metric showed a
staircase, one step per recycle, ending in an OOM kill. The old process-RSS guard
can't see Chromium (it measures Node only, ~60–90 MB). Now `closeBrowser()` closes
(10 s cap) then SIGKILLs. Watch Render's memory metric: it should saw-tooth, not climb.
If OOM still recurs, the levers below still apply.

Render Events show **"Ran out of memory (used over 512MB)."** Chromium accumulates
memory; a heavy/paginated casino can spike RSS past 512 MB between the 30s checks and
Render kills the instance (crash-recover loop). Levers, cheapest first: lower
`MAX_SCRAPES_PER_BROWSER` (e.g. 25→8), keep pages per casino at 1 (done in v6), tighten
`--max-old-space-size` (e.g. 256→128), optionally add a per-request pre-scrape RSS
check. If tuning isn't enough, the honest fix is a paid Render tier (512 MB → 2 GB) —
flag it rather than over-tuning. A code change redeploys both services (fine).

### Cloudflare
Datacenter proxies do NOT reliably clear Cloudflare; residential do. Sheet 1 uses
residential; Sheet 2's ~15 mostly scrape fine direct, so free datacenter is enough
there. `Just a moment` through a *datacenter* proxy is expected — fix is residential,
not code.

### WebShare bandwidth
Residential (Sheet 1) 250 GB/mo, a full run ~6 MB → exhaustion effectively impossible.
Free datacenter (Sheet 2) is 1 GB/mo and *can* be exhausted — when it is, the
dashboard still shows proxies "working" but every scrape fails with
`ERR_TUNNEL_CONNECTION_FAILED`. If you see that, check bandwidth.

---

## Deploying & verifying

**Server (git):** push → Render auto-deploys both services. Load each `/health`:
expect `ok:true` and `proxy_pool_size` 20 / 10. `browser_alive:false` idle is normal.
**Green `/health` = booted, not working** — verify with a real scrape and watch the
Render **Live tail**:
- good: `[direct] <casino> → <real title>` then `[result] ✓ ... fails=0`, or
  `Launching PROXY ... via local http://127.0.0.1:...` then a result.
- bad: `Just a moment...` (CF) · `Proxy timeout 65000ms` (proxy auth — shouldn't
  happen with proxy-chain) · `Ran out of memory` (OOM) · `WS endpoint ... timed out`
  (Chrome launch failed — usually a wedged container, redeploy for a fresh one).

**Apps Script (clasp):** `clasp push` sends your edits to the live Sheet 1 project.
Verify by running the relevant menu action / trigger and watching the Apps Script
Executions log + the Render Live tail together. Then hand-copy the change into Sheet 2.

---

## Current task / open issues
<!-- Keep this updated as you work. -->
- **Done (v6):** parser rebuilt for the redesigned AskGamblers complaints page (see
  "Parsing" above). Verify after each daily run: `[parse] ✗` lines in Render logs.
- `AG_SECRET`'s value is in this public repo's git history. The owner decided (2026-11-12)
  to keep it rather than rotate it — don't push for rotation. Mitigation in place:
  `/api/scrape` accepts only askgamblers.com URLs. Making the repo private would help.
- `ag-scraper` (Sheet 1) was OOM-killed 6× in the 2026-11-12 daily run and 2× in the
  v6 force refresh — caused by the browser-recycle leak, fixed in v6.1. Re-check Render
  events + memory metric after the next daily run before considering the paid tier.
- Sheet row `midasluck-casino` links a dead AskGamblers page ("Page not found"); the
  brand may now be `midarion-casino` — owner to confirm and fix column B.
- Both services currently report `proxy_pool_size` 10 (CLAUDE.md expected 20 on Sheet 1).
- Candidate follow-ups: confirm Sheet 2's `AskGamblers Scrape.gs` isn't stale; add the
  LockService guard to CG's `runHybridBatch()`.
