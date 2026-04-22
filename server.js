const express   = require("express");
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
const crypto    = require("crypto");
puppeteer.use(Stealth());

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.AG_SECRET || "";
const CHROME = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

// ══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════

const MEMORY_RESTART_MB       = 380;    // proactively restart browser if RSS exceeds this
const MEMORY_CHECK_INTERVAL   = 30000;  // memory check every 30s
const PROTOCOL_TIMEOUT        = 60000;  // max time for a single Chrome command to respond
const LAUNCH_TIMEOUT          = 45000;  // max time to wait for Chrome to start
const SCRAPE_TIMEOUT          = 75000;  // max time for a full scrape (one attempt)
const MAX_SCRAPES_PER_BROWSER = 25;     // restart browser every N scrapes for hygiene

// ══════════════════════════════════════════════════════════════════
// WEBSHARE PROXY CONFIG
// ══════════════════════════════════════════════════════════════════

const WS_USER = process.env.WS_PROXY_USER || "YOUR_WEBSHARE_USERNAME";
const WS_PASS = process.env.WS_PROXY_PASS || "YOUR_WEBSHARE_PASSWORD";

const WS_PROXIES = [
  { host: "31.59.20.176",    port: "6754" },
  { host: "198.23.239.134",  port: "6540" },
  { host: "45.38.107.97",    port: "6014" },
  { host: "107.172.163.27",  port: "6543" },
  { host: "198.105.121.200", port: "6462" },
  { host: "216.10.27.159",   port: "6837" },
  { host: "142.111.67.146",  port: "5611" },
  { host: "191.96.254.138",  port: "6185" },
  { host: "31.58.9.4",       port: "6077" },
  { host: "23.26.71.145",    port: "5628" },
];

const hasProxy = WS_USER !== "YOUR_WEBSHARE_USERNAME" && WS_PROXIES[0].host !== "YOUR_IP_1";

// Deterministic proxy per URL — same casino consistently uses same IP (builds CF trust)
function getProxyForUrl(url) {
  const hash = crypto.createHash("md5").update(url).digest();
  return WS_PROXIES[hash[0] % WS_PROXIES.length];
}

// ══════════════════════════════════════════════════════════════════
// PERSISTENT BROWSER STATE
// ══════════════════════════════════════════════════════════════════

let state = {
  browser:     null,
  mode:        null,   // 'direct' | 'proxy'
  proxyHost:   null,
  scrapeCount: 0,
  launchedAt:  null,
  launchLock:  null,   // prevent concurrent launches
};

function memMB() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function log(msg) {
  console.log(`[${memMB()}MB] ${msg}`);
}

// ══════════════════════════════════════════════════════════════════
// BROWSER LAUNCH (internal — use getBrowser)
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
    "--js-flags=--max-old-space-size=256",   // cap V8 heap
  ];

  if (mode === "proxy" && proxyHost) {
    const proxy = WS_PROXIES.find(p => p.host === proxyHost);
    if (proxy) {
      args.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);
      log(`[browser] Launching PROXY ${proxy.host}:${proxy.port}`);
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

// ══════════════════════════════════════════════════════════════════
// GET BROWSER (reuses persistent browser if mode matches)
// ══════════════════════════════════════════════════════════════════

async function getBrowser(mode, proxyHost) {
  // Wait for any in-progress launch to finish
  if (state.launchLock) {
    try { await state.launchLock; } catch (e) {}
  }

  const modeMatches = state.mode === mode &&
                      (mode !== "proxy" || state.proxyHost === proxyHost);

  // Reuse existing browser if mode matches AND it's healthy AND scrape count OK
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

  // Close existing browser (mode switch or unhealthy or at limit)
  if (state.browser) {
    try { await state.browser.close(); } catch (e) {}
    state.browser = null;
  }

  // Launch new browser (protected from concurrent launches)
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
    if (useProxy) {
      await page.authenticate({ username: WS_USER, password: WS_PASS });
    }

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

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });

    try {
      await page.waitForFunction(
        () => !document.title.includes("Just a moment") &&
              !document.title.includes("Attention Required") &&
              document.title.length > 0,
        { timeout: 20000, polling: 500 }
      );
    } catch (e) {}

    try {
      await page.waitForFunction(
        () => document.querySelector(
          "article,[class*='complaint-item'],[class*='complaint-card'],a[href*='casino-complaints']"
        ) !== null,
        { timeout: 10000, polling: 500 }
      );
    } catch (e) {}

    return page;
  } catch (err) {
    try { await page.close(); } catch (e) {}
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════
// SCRAPE LIST (unchanged — the parsing logic works well)
// ══════════════════════════════════════════════════════════════════

async function scrapeList(page) {
  return page.evaluate(() => {
    const r = {
      resolved:0, rejected:0, unresolved:0, open:0,
      openEntries:[], totalPages:1
    };

    const selectors = [
      "article","[class*='complaint-item']","[class*='complaint_item']",
      "[class*='complaint-card']","[class*='complaintCard']",
    ];
    let cards = [];
    for (const sel of selectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > 0) { cards = found; break; }
    }
    if (cards.length === 0) {
      document.querySelectorAll("a[href*='casino-complaints']").forEach(a => {
        const card = a.closest("article,li,div[class],[class*='card']");
        if (card && !cards.includes(card)) cards.push(card);
      });
    }

    cards.forEach(card => {
      const statusEl = card.querySelector(
        "[class*='status'],[class*='badge'],[class*='label'],[class*='state']"
      );
      let status = "";
      if (statusEl) {
        status = statusEl.textContent.trim().toUpperCase();
      } else {
        const leaves = Array.from(card.querySelectorAll("*"))
          .filter(el => el.children.length === 0);
        for (const leaf of leaves) {
          const t = leaf.textContent.trim().toUpperCase();
          if (["RESOLVED","REJECTED","UNRESOLVED","OPEN"].includes(t)) {
            status = t; break;
          }
        }
      }
      if (status === "RESOLVED")   r.resolved++;
      if (status === "REJECTED")   r.rejected++;
      if (status === "UNRESOLVED") r.unresolved++;
      if (status === "OPEN")       r.open++;

      const link = card.querySelector("a[href*='casino-complaints']");
      if (!link) return;
      const url     = link.href;
      const cardLow = (card.textContent||"").replace(/\s+/g," ").toLowerCase();
      const m = cardLow.match(/(\d+)\s*hours?\s*left/i);
      if (m) {
        const hoursLeft = parseInt(m[1]);
        const d = Math.floor(hoursLeft/24), h = hoursLeft%24;
        if (!r.openEntries.find(e => e.url === url)) {
          r.openEntries.push({
            hoursLeft,
            timer: d > 0 ? (d+"d "+h+"h") : (h+"h"),
            url
          });
        }
      }
    });

    document.querySelectorAll("a[href*='page=']").forEach(a => {
      const m = (a.href||"").match(/page=(\d+)/);
      if (m && parseInt(m[1]) > r.totalPages) r.totalPages = parseInt(m[1]);
    });

    return r;
  });
}

// ══════════════════════════════════════════════════════════════════
// SCRAPE ONE CASINO (uses persistent browser)
// ══════════════════════════════════════════════════════════════════

async function scrapeCasino(url, mode, proxyHost) {
  let page = null;
  try {
    const browser  = await getBrowser(mode, proxyHost);
    const useProxy = mode === "proxy";
    page = await openPage(browser, url, useProxy);
    const title   = await page.title();
    const modeStr = mode === "proxy" ? `[proxy:${proxyHost}]` : `[direct]`;
    console.log(`${modeStr} ${url.split("/").slice(-2).join("/")} → ${title}`);

    if (title.includes("Just a moment") || title.includes("Attention Required")) {
      return { ok: false, error: "Cloudflare block", cfBlocked: true };
    }

    const data       = await scrapeList(page);
    const allEntries = [...data.openEntries];

    for (let pg = 2; pg <= data.totalPages && pg <= 50; pg++) {
      const sep   = url.includes("?") ? "&" : "?";
      const pgUrl = url + sep + "page=" + pg;
      await page.goto(pgUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
      try {
        await page.waitForFunction(
          () => !document.title.includes("Just a moment") && document.title.length > 0,
          { timeout: 12000, polling: 500 }
        );
      } catch (e) {}
      const pgData = await scrapeList(page);
      data.resolved   += pgData.resolved;
      data.rejected   += pgData.rejected;
      data.unresolved += pgData.unresolved;
      data.open       += pgData.open;
      pgData.openEntries.forEach(e => {
        if (!allEntries.find(x => x.url === e.url)) allEntries.push(e);
      });
    }

    state.scrapeCount++;

    return {
      ok:          true,
      title,
      resolved:    data.resolved,
      rejected:    data.rejected,
      unresolved:  data.unresolved,
      open:        data.open,
      total:       data.resolved + data.rejected + data.unresolved + data.open,
      openEntries: allEntries,
    };

  } catch (e) {
    console.error(`[scrape error] ${e.message}`);
    // Reset browser only on fatal errors
    const fatal = [
      "Target closed", "Protocol error", "WS endpoint",
      "Browser launch timeout", "frame was detached", "Session closed"
    ];
    if (fatal.some(f => e.message.includes(f))) {
      await resetBrowser("fatal: " + e.message);
    }
    return { ok: false, error: e.message };
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
// MEMORY MONITOR — proactively restart before OOM kill
// ══════════════════════════════════════════════════════════════════

setInterval(async () => {
  const usage  = process.memoryUsage();
  const rssMB  = Math.round(usage.rss / 1024 / 1024);
  const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
  console.log(`[health] RSS=${rssMB}MB heap=${heapMB}MB scrapes=${state.scrapeCount} mode=${state.mode || "none"}`);

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

  const decodedUrl = decodeURIComponent(url);
  const startTime  = Date.now();

  try {
    // ── Attempt 1: Direct ───────────────────────────────────────
    let result = await withTimeout(
      scrapeCasino(decodedUrl, "direct", null),
      SCRAPE_TIMEOUT,
      "Direct"
    );

    // ── Attempt 2: Proxy (deterministic) ────────────────────────
    if (result.cfBlocked && hasProxy) {
      const proxy = getProxyForUrl(decodedUrl);
      console.log(`[fallback] Direct CF-blocked → proxy ${proxy.host}`);
      result = await withTimeout(
        scrapeCasino(decodedUrl, "proxy", proxy.host),
        SCRAPE_TIMEOUT,
        "Proxy"
      );
    }

    // NOTE: Removed the old 3rd attempt (direct again). It wasted memory
    // on already-blocked casinos. GAS retryAskGamblersErrors handles these later.

    const dur = Date.now() - startTime;
    const tag = result.ok ? "✓" : "✗";
    console.log(`[result] ${tag} ${decodedUrl.split("/").slice(-2).join("/")} (${dur}ms)`);
    res.json(result);

  } catch (e) {
    console.error(`[route error] ${e.message}`);
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
    version: "v2-persistent-browser",
    memory:  {
      rss_mb:  Math.round(usage.rss / 1024 / 1024),
      heap_mb: Math.round(usage.heapUsed / 1024 / 1024),
    },
    browser: state.browser ? {
      mode:       state.mode,
      proxy_host: state.proxyHost,
      scrapes:    state.scrapeCount,
      uptime_s:   state.launchedAt ? Math.round((Date.now() - state.launchedAt) / 1000) : 0,
    } : null,
    proxy: hasProxy ? "WebShare configured" : "No proxy — direct only",
  });
});

app.get("/health", (req, res) => {
  const usage = process.memoryUsage();
  res.json({
    ok:            true,
    rss_mb:        Math.round(usage.rss / 1024 / 1024),
    heap_mb:       Math.round(usage.heapUsed / 1024 / 1024),
    browser_alive: !!state.browser,
    browser_mode:  state.mode,
    scrape_count:  state.scrapeCount,
  });
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

app.listen(PORT, () => console.log("AG Scraper v2 listening on port " + PORT));
