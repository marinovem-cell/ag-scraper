const express   = require("express");
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
const proxyChain = require("proxy-chain");
const crypto    = require("crypto");
puppeteer.use(Stealth());

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.AG_SECRET || "";
const CHROME = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

// ══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════

const MEMORY_RESTART_MB       = 380;
const MEMORY_CHECK_INTERVAL   = 30000;
const PROTOCOL_TIMEOUT        = 60000;
const LAUNCH_TIMEOUT          = 45000;
const NAV_TIMEOUT             = 15000;
const TITLE_WAIT_TIMEOUT      = 15000;
const SCRAPE_TIMEOUT          = 65000;
const MAX_SCRAPES_PER_BROWSER = 8;
const CONSECUTIVE_FAIL_LIMIT  = 3;
const COOLDOWN_MS             = 20000;

const WS_REFRESH_INTERVAL_MS  = 6 * 60 * 60 * 1000;  // refresh proxy list every 6 hours
const WS_FETCH_TIMEOUT_MS     = 15000;               // 15s timeout for WebShare API calls
const WS_FETCH_RETRY_DELAY_MS = 5000;                // 5s between startup fetch retries
const WS_FETCH_MAX_RETRIES    = 3;                   // try 3 times on cold start before giving up

// ══════════════════════════════════════════════════════════════════
// WEBSHARE PROXY CONFIG — fetched from WebShare API at startup
// ══════════════════════════════════════════════════════════════════

const WS_API_KEY = process.env.WS_API_KEY;

if (!WS_API_KEY) {
  console.error("FATAL: WS_API_KEY env var missing");
  process.exit(1);
}

let WS_USER       = null;
let WS_PASS       = null;
let WS_PROXIES    = [];
let WS_LAST_FETCH = 0;

async function fetchProxiesFromWebshare() {
  const url = "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=25";

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), WS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { "Authorization": "Token " + WS_API_KEY },
      signal:  controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(`WebShare API returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!data.results || !Array.isArray(data.results) || data.results.length === 0) {
      throw new Error("WebShare API returned empty proxy list");
    }

    const newProxies = data.results.map(p => ({
      host: String(p.proxy_address),
      port: String(p.port),
    }));

    // All proxies in a WebShare account share one username/password
    const newUser = data.results[0].username;
    const newPass = data.results[0].password;

    if (!newUser || !newPass) {
      throw new Error("WebShare API response missing username/password");
    }

    WS_PROXIES    = newProxies;
    WS_USER       = newUser;
    WS_PASS       = newPass;
    WS_LAST_FETCH = Date.now();

    console.log(`[webshare] Loaded ${WS_PROXIES.length} proxies from API (user=${WS_USER})`);
    return true;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

// Block startup until proxies are loaded — retry a few times for cold-start hiccups
(async () => {
  for (let attempt = 1; attempt <= WS_FETCH_MAX_RETRIES; attempt++) {
    try {
      await fetchProxiesFromWebshare();
      return;
    } catch (e) {
      console.error(`[webshare] Startup fetch attempt ${attempt}/${WS_FETCH_MAX_RETRIES} failed: ${e.message}`);
      if (attempt < WS_FETCH_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, WS_FETCH_RETRY_DELAY_MS));
      } else {
        console.error("FATAL: Could not fetch proxies from WebShare API after all retries");
        process.exit(1);
      }
    }
  }
})();

// Periodic refresh — picks up rotated IPs without needing a redeploy
setInterval(async () => {
  try {
    await fetchProxiesFromWebshare();
  } catch (e) {
    console.error(`[webshare] Background refresh failed (keeping previous list): ${e.message}`);
  }
}, WS_REFRESH_INTERVAL_MS);

// Deterministic proxy per URL — same casino consistently uses same IP (builds CF trust)
function getProxyForUrl(url) {
  const hash = crypto.createHash("md5").update(url).digest();
  return WS_PROXIES[hash[0] % WS_PROXIES.length];
}

// ══════════════════════════════════════════════════════════════════
// PERSISTENT BROWSER STATE
// ══════════════════════════════════════════════════════════════════

let state = {
  browser:          null,
  mode:             null,
  proxyHost:        null,
  scrapeCount:      0,
  consecutiveFails: 0,
  launchedAt:       null,
  launchLock:       null,
  anonProxyUrl:     null,   // proxy-chain local anonymized URL for the current browser
};

// Close the current anonymized proxy (if any). Safe to call repeatedly.
async function closeAnonProxy() {
  if (state.anonProxyUrl) {
    const old = state.anonProxyUrl;
    state.anonProxyUrl = null;
    try { await proxyChain.closeAnonymizedProxy(old, true); } catch (e) {}
  }
}

function memMB() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function log(msg) {
  console.log(`[${memMB()}MB] ${msg}`);
}

// ══════════════════════════════════════════════════════════════════
// BROWSER LAUNCH
// ══════════════════════════════════════════════════════════════════

async function launchBrowserInternal(mode, proxyHost) {
  const args = [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--disable-dev-shm-usage", "--disable-gpu",
    "--no-first-run", "--no-zygote", "--single-process",
    "--window-size=1280,800",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--mute-audio",
    "--disable-accelerated-2d-canvas",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-component-extensions-with-background-pages",
    "--disable-features=TranslateUI,site-per-process,IsolateOrigins",
    "--disable-ipc-flooding-protection",
    "--disable-renderer-backgrounding",
    "--disable-software-rasterizer",
    "--disable-notifications",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-pings",
    "--password-store=basic",
    "--use-mock-keychain",
    "--js-flags=--max-old-space-size=128",
  ];

// Always clear any leftover anonymized proxy before launching a new browser.
  await closeAnonProxy();

  if (mode === "proxy" && proxyHost) {
    const proxy = WS_PROXIES.find(p => p.host === proxyHost);
    if (proxy) {
      // proxy-chain: wrap the authenticated upstream proxy in a local, auth-free
      // proxy. Chromium then connects to 127.0.0.1 with NO auth challenge, which
      // avoids the page.authenticate() + setRequestInterception() hang that causes
      // 65s "Proxy timeout" on residential proxies.
      const upstream = `http://${encodeURIComponent(WS_USER)}:${encodeURIComponent(WS_PASS)}@${proxy.host}:${proxy.port}`;
      state.anonProxyUrl = await proxyChain.anonymizeProxy(upstream);
      args.push(`--proxy-server=${state.anonProxyUrl}`);
      log(`[browser] Launching PROXY ${proxy.host}:${proxy.port} via local ${state.anonProxyUrl}`);
    }
  } else {
    log(`[browser] Launching DIRECT`);
  }

  const launchPromise = puppeteer.launch({
    executablePath:    CHROME,
    headless:          true,
    args,
    ignoreHTTPSErrors: true,
    protocolTimeout:   PROTOCOL_TIMEOUT,
    handleSIGINT:      false,
    handleSIGTERM:     false,
    handleSIGHUP:      false,
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Browser launch timeout ${LAUNCH_TIMEOUT}ms`)), LAUNCH_TIMEOUT)
  );

  return Promise.race([launchPromise, timeout]);
}

async function getBrowser(mode, proxyHost) {
  if (state.launchLock) {
    try { await state.launchLock; } catch (e) {}
  }

  const modeMatches = state.mode === mode &&
                      (mode !== "proxy" || state.proxyHost === proxyHost);

  if (state.browser && modeMatches) {
    try {
      await state.browser.version();
      if (state.scrapeCount < MAX_SCRAPES_PER_BROWSER) {
        return state.browser;
      }
      log(`[browser] Scrape count ${state.scrapeCount} reached limit → restart`);
    } catch (e) {
      log(`[browser] Health check failed: ${e.message}`);
    }
    state.browser = null;
  }

  if (state.browser) {
    try { await state.browser.close(); } catch (e) {}
    state.browser = null;
  }

  state.launchLock = (async () => {
    state.browser     = await launchBrowserInternal(mode, proxyHost);
    state.mode        = mode;
    state.proxyHost   = proxyHost;
    state.launchedAt  = Date.now();
    state.scrapeCount = 0;

    state.browser.on("disconnected", () => {
      log(`[browser] Disconnected event`);
      if (state.browser) {
        state.browser = null;
        state.mode = null;
      }
    });

    log(`[browser] ✓ Ready (${mode}${proxyHost ? " " + proxyHost : ""})`);
  })();

  try {
    await state.launchLock;
  } finally {
    state.launchLock = null;
  }

  return state.browser;
}

async function resetBrowser(reason) {
  if (reason) log(`[browser] Reset: ${reason}`);
  if (state.browser) {
    try { await state.browser.close(); } catch (e) {}
  }
  await closeAnonProxy();
  state.browser     = null;
  state.mode        = null;
  state.proxyHost   = null;
  state.scrapeCount = 0;
}

// ══════════════════════════════════════════════════════════════════
// OPEN PAGE
// ══════════════════════════════════════════════════════════════════

async function openPage(browser, url, useProxy) {
  const page = await browser.newPage();

 try {
    // NOTE: proxy auth is handled by the local proxy-chain proxy (credentials are
    // embedded there), so we deliberately do NOT call page.authenticate() — doing
    // so together with setRequestInterception() hangs residential proxy handshakes.

    await page.setRequestInterception(true);
    page.on("request", req => {
      if (["image","stylesheet","font","media","websocket"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await waitForComplaints(page);

    return page;
  } catch (err) {
    try { await page.close(); } catch (e) {}
    throw err;
  }
}

// Wait until Cloudflare's interstitial is gone and the complaints markup is present.
async function waitForComplaints(page) {
  try {
    await page.waitForFunction(
      () => !document.title.includes("Just a moment") &&
            !document.title.includes("Attention Required") &&
            document.title.length > 0,
      { timeout: TITLE_WAIT_TIMEOUT, polling: 500 }
    );
  } catch (e) {}

  try {
    await page.waitForFunction(
      () => document.querySelector(".filters-links-dropdown__count, .complaint-card") !== null,
      { timeout: 8000, polling: 500 }
    );
  } catch (e) {}
}

// ══════════════════════════════════════════════════════════════════
// PARSE A COMPLAINTS PAGE (AskGamblers markup since the 2026 redesign)
//
// Counts come from the "Filter by Status" sidebar, which carries AskGamblers'
// own exact totals for the casino — no pagination needed:
//   <a class="filters-links-dropdown__option" href=".../complaints?status=solved">
//     <span class="filters-links-dropdown__label">Resolved</span>
//     <span class="filters-links-dropdown__count">23</span></a>
// status=solved|rejected|unsolved|open; the "All" link has no status param.
// A status with 0 complaints is simply left out (e.g. Unresolved), so it counts as 0.
//
// Open-case timers come from the cards: an open case's a.complaint-card holds
// <span class="complaint-status__text">55h</span> <span>left</span>; closed cases
// show a status icon instead.
//
// Runs inside the page via page.evaluate(), so it must stay self-contained.
// ══════════════════════════════════════════════════════════════════

function parseComplaintsDom() {
  const KEY_BY_STATUS = { solved: "resolved", rejected: "rejected", unsolved: "unresolved", open: "open" };
  const KEY_BY_LABEL  = { "all": "all", "resolved": "resolved", "rejected": "rejected",
                          "unresolved": "unresolved", "in progress": "open" };
  const CLOSED_TEXT   = ["resolved", "rejected", "unresolved"];
  const clean = s => (s || "").replace(/\s+/g, " ").trim();

  const counts = {}, problems = [];
  document.querySelectorAll(".filters-links-dropdown__option").forEach(a => {
    const labelEl = a.querySelector(".filters-links-dropdown__label");
    const countEl = a.querySelector(".filters-links-dropdown__count");
    const label = clean(labelEl && labelEl.textContent);
    const countText = clean(countEl && countEl.textContent);
    let status = null;
    try { status = new URL(a.href).searchParams.get("status"); } catch (e) {}
    const key = status ? KEY_BY_STATUS[status] : KEY_BY_LABEL[label.toLowerCase()];
    const n = /^\d[\d,]*$/.test(countText) ? parseInt(countText.replace(/,/g, ""), 10) : NaN;
    if (!key || isNaN(n)) {
      problems.push(`unrecognised status filter "${label}" (status=${status}) count="${countText}"`);
      return;
    }
    if (key in counts && counts[key] !== n) problems.push(`conflicting ${key} counts ${counts[key]} vs ${n}`);
    counts[key] = n;
  });

  const cards = document.querySelectorAll(".complaint-card");
  const openEntries = [];
  let openCards = 0;
  cards.forEach(card => {
    const textEl = card.querySelector(".complaint-status__text");
    const text = clean(textEl && textEl.textContent);
    if (!text || CLOSED_TEXT.includes(text.toLowerCase())) return;
    openCards++;
    const link = card.matches("a[href]") ? card : (card.querySelector("a[href]") || card.closest("a[href]"));
    const m = text.match(/^(\d+)\s*([dhm])/i);              // "55h", also tolerates "3d" / "40m"
    if (!link || !m) return;
    const n = parseInt(m[1], 10), unit = m[2].toLowerCase();
    const hoursLeft = unit === "d" ? n * 24 : unit === "h" ? n : 0;
    const d = Math.floor(hoursLeft / 24), h = hoursLeft % 24;
    if (!openEntries.some(e => e.url === link.href)) {
      openEntries.push({ hoursLeft, timer: d > 0 ? (d + "d " + h + "h") : (h + "h"), url: link.href });
    }
  });

  return { counts, problems, openEntries, openCards, cardCount: cards.length };
}

// Returns null when the parsed counts are trustworthy, otherwise a reason. Callers
// return ok:false on a reason, so the sheet shows ERROR instead of wrong numbers.
function countsProblem(p) {
  if (p.problems.length) return p.problems.join("; ");
  if (!("all" in p.counts)) return `status filters not found (${p.cardCount} complaint cards on page)`;
  const sum = ["resolved", "rejected", "unresolved", "open"].reduce((s, k) => s + (p.counts[k] || 0), 0);
  if (sum !== p.counts.all) return `status counts don't add up: All=${p.counts.all}, sum of statuses=${sum}`;
  return null;
}

// Cloudflare serves the complaints page from an edge cache that can be hours old.
// A unique query parameter makes it return the current page — same single request.
function freshUrl(url, extraParams) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(extraParams || {})) u.searchParams.set(k, v);
  u.searchParams.set("_cb", Date.now().toString(36));
  return u.toString();
}

// A sheet row may link the casino's review page instead of its complaints page.
function complaintsUrl(url) {
  const u = new URL(url);
  if (/^\/online-casinos\/reviews\/[^/]+\/?$/.test(u.pathname)) {
    u.pathname = u.pathname.replace(/\/?$/, "/complaints");
  }
  return u.toString();
}

// ══════════════════════════════════════════════════════════════════
// DETECT IF AN ERROR LOOKS LIKE CLOUDFLARE
// ══════════════════════════════════════════════════════════════════

function isCloudflareError(err) {
  if (!err || !err.message) return false;
  const m = err.message.toLowerCase();
  return m.includes("navigation timeout") ||
         m.includes("net::err_timed_out") ||
         m.includes("net::err_tunnel_connection_failed") ||
         m.includes("net::err_empty_response");
}

// ══════════════════════════════════════════════════════════════════
// SCRAPE ONE CASINO
// ══════════════════════════════════════════════════════════════════

async function scrapeCasino(url, mode, proxyHost) {
  let page = null;
  try {
    const browser  = await getBrowser(mode, proxyHost);
    const useProxy = mode === "proxy";
    page = await openPage(browser, freshUrl(url), useProxy);
    const title   = await page.title();
    const modeStr = mode === "proxy" ? `[proxy:${proxyHost}]` : `[direct]`;
    const short   = url.split("/").slice(-2).join("/");
    console.log(`${modeStr} ${short} → ${title}`);

    if (title.includes("Just a moment") || title.includes("Attention Required")) {
      return { ok: false, error: "Cloudflare block", cfBlocked: true };
    }

    const parsed = await page.evaluate(parseComplaintsDom);
    state.scrapeCount++;

    const problem = countsProblem(parsed);
    if (problem) {
      console.log(`[parse] ✗ ${short} → ${problem}`);
      return { ok: false, error: "Parse failed: " + problem, cfBlocked: false };
    }

    const c = parsed.counts;
    const openEntries = parsed.openEntries;

    // Open cases are normally the newest, so they sit among the first 24 cards. Only if
    // some are further down, load the "In Progress" filter page once for their timers.
    let extraPage = false;
    if ((c.open || 0) > parsed.openCards) {
      extraPage = true;
      try {
        await page.goto(freshUrl(url, { status: "open" }), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        await waitForComplaints(page);
        const more = await page.evaluate(parseComplaintsDom);
        more.openEntries.forEach(e => { if (!openEntries.some(x => x.url === e.url)) openEntries.push(e); });
      } catch (e) {
        console.log(`[parse] ${short} → In Progress page failed (${e.message}); keeping ${openEntries.length} timers`);
      }
    }

    console.log(`[parse] ✓ ${short} → All=${c.all} R=${c.resolved || 0} Rj=${c.rejected || 0} U=${c.unresolved || 0} Open=${c.open || 0} timers=${openEntries.length}${extraPage ? " (+In Progress page)" : ""}`);

    return {
      ok:          true,
      title,
      resolved:    c.resolved   || 0,
      rejected:    c.rejected   || 0,
      unresolved:  c.unresolved || 0,
      open:        c.open       || 0,
      total:       c.all,
      openEntries,
    };

  } catch (e) {
    console.error(`[scrape error] ${e.message}`);

    const looksLikeCF = isCloudflareError(e);

    const fatal = [
      "Target closed", "Protocol error", "WS endpoint",
      "Browser launch timeout", "frame was detached", "Session closed"
    ];
    if (fatal.some(f => e.message.includes(f))) {
      await resetBrowser("fatal: " + e.message);
    }

    return {
      ok:        false,
      error:     e.message,
      cfBlocked: looksLikeCF
    };
  } finally {
    if (page) {
      try {
        page.removeAllListeners && page.removeAllListeners();
        await page.close();
      } catch (e) {}
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// MEMORY MONITOR
// ══════════════════════════════════════════════════════════════════

setInterval(async () => {
  const usage  = process.memoryUsage();
  const rssMB  = Math.round(usage.rss / 1024 / 1024);
  const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
  console.log(`[health] RSS=${rssMB}MB heap=${heapMB}MB scrapes=${state.scrapeCount} fails=${state.consecutiveFails} mode=${state.mode || "none"}`);

  if (rssMB > MEMORY_RESTART_MB) {
    console.log(`[health] Memory ${rssMB}MB > ${MEMORY_RESTART_MB}MB → restart browser`);
    await resetBrowser("memory pressure");
    if (global.gc) global.gc();
  }
}, MEMORY_CHECK_INTERVAL);

// ══════════════════════════════════════════════════════════════════
// MAIN ROUTE
// ══════════════════════════════════════════════════════════════════

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms))
]);

app.get("/api/scrape", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (SECRET && req.query.secret !== SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const { url } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: "Missing ?url=" });

  // Sanity check: WebShare proxies must be loaded by this point
  if (WS_PROXIES.length === 0 || !WS_USER || !WS_PASS) {
    return res.status(503).json({ ok: false, error: "Proxy list not yet loaded" });
  }

  // Only AskGamblers pages: the scraper must never be usable to fetch arbitrary
  // sites through our browser and proxy pool.
  let decodedUrl;
  try {
    decodedUrl = complaintsUrl(decodeURIComponent(url));
    const host = new URL(decodedUrl).hostname;
    if (host !== "askgamblers.com" && !host.endsWith(".askgamblers.com")) throw new Error("host");
  } catch (e) {
    return res.status(400).json({ ok: false, error: "Only askgamblers.com complaint URLs are supported" });
  }
  const startTime  = Date.now();

// Proactive memory guard — reset the browser before it can OOM the 512MB instance.
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rssMB > 380 && state.browser) {
    console.log(`[memguard] RSS=${rssMB}MB > 380MB → forcing browser reset before scrape`);
    await resetBrowser("memory guard");
  }
  
  if (state.consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
    console.log(`[cooldown] ${state.consecutiveFails} consecutive fails → forcing browser reset + ${COOLDOWN_MS/1000}s cooldown`);
    await resetBrowser("consecutive failures cooldown");
    await new Promise(r => setTimeout(r, COOLDOWN_MS));
    state.consecutiveFails = 0;
  }

  try {
    let result = await withTimeout(
      scrapeCasino(decodedUrl, "direct", null),
      SCRAPE_TIMEOUT,
      "Direct"
    );

    if (!result.ok && result.cfBlocked) {
      const proxy = getProxyForUrl(decodedUrl);
      console.log(`[fallback] Direct blocked/timeout → proxy ${proxy.host}`);
      result = await withTimeout(
        scrapeCasino(decodedUrl, "proxy", proxy.host),
        SCRAPE_TIMEOUT,
        "Proxy"
      );
    }

    if (result.ok) {
      state.consecutiveFails = 0;
    } else {
      state.consecutiveFails++;
    }

    const dur = Date.now() - startTime;
    const tag = result.ok ? "✓" : "✗";
    console.log(`[result] ${tag} ${decodedUrl.split("/").slice(-2).join("/")} (${dur}ms) fails=${state.consecutiveFails}`);
    res.json(result);

  } catch (e) {
    console.error(`[route error] ${e.message}`);
    state.consecutiveFails++;
    await resetBrowser("route error");
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// HEALTH + STATUS ENDPOINTS
// ══════════════════════════════════════════════════════════════════

app.get("/", (req, res) => {
  const usage = process.memoryUsage();
  res.json({
    status:  "AG Scraper running",
    version: "v6-ag-2026-markup",
    memory:  {
      rss_mb:  Math.round(usage.rss / 1024 / 1024),
      heap_mb: Math.round(usage.heapUsed / 1024 / 1024),
    },
    browser: state.browser ? {
      mode:              state.mode,
      proxy_host:        state.proxyHost,
      scrapes:           state.scrapeCount,
      consecutive_fails: state.consecutiveFails,
      uptime_s:          state.launchedAt ? Math.round((Date.now() - state.launchedAt) / 1000) : 0,
    } : null,
    webshare: {
      proxy_pool_size:    WS_PROXIES.length,
      last_fetch_age_min: WS_LAST_FETCH ? Math.round((Date.now() - WS_LAST_FETCH) / 60000) : null,
      user:               WS_USER,
    },
  });
});

app.get("/health", (req, res) => {
  const usage = process.memoryUsage();
  res.json({
    ok:                true,
    rss_mb:            Math.round(usage.rss / 1024 / 1024),
    heap_mb:           Math.round(usage.heapUsed / 1024 / 1024),
    browser_alive:     !!state.browser,
    browser_mode:      state.mode,
    scrape_count:      state.scrapeCount,
    consecutive_fails: state.consecutiveFails,
    proxy_pool_size:   WS_PROXIES.length,
  });
});

// Manual proxy refresh — useful for debugging or after WebShare manual rotation
app.get("/refresh-proxies", async (req, res) => {
  if (SECRET && req.query.secret !== SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    await fetchProxiesFromWebshare();
    res.json({ ok: true, proxy_pool_size: WS_PROXIES.length, user: WS_USER });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════════════

process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received");
  await resetBrowser("shutdown");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error(`[uncaught] ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[unhandled] ${reason}`);
});

app.listen(PORT, () => console.log("AG Scraper v5 listening on port " + PORT));


