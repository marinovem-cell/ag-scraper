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

const MEMORY_RESTART_MB       = 380;
const MEMORY_CHECK_INTERVAL   = 30000;
const PROTOCOL_TIMEOUT        = 60000;
const LAUNCH_TIMEOUT          = 45000;
const NAV_TIMEOUT             = 15000;
const TITLE_WAIT_TIMEOUT      = 15000;
const SCRAPE_TIMEOUT          = 65000;
const MAX_SCRAPES_PER_BROWSER = 25;
const CONSECUTIVE_FAIL_LIMIT  = 3;
const COOLDOWN_MS             = 20000;

// ══════════════════════════════════════════════════════════════════
// WEBSHARE PROXY CONFIG — all env-driven, fail fast if missing
// ══════════════════════════════════════════════════════════════════

const WS_USER = process.env.WS_PROXY_USER;
const WS_PASS = process.env.WS_PROXY_PASS;

if (!WS_USER || !WS_PASS) {
  console.error("FATAL: WS_PROXY_USER and/or WS_PROXY_PASS env vars missing");
  process.exit(1);
}

let WS_PROXIES;
try {
  WS_PROXIES = JSON.parse(process.env.WS_PROXIES || "[]");
} catch (e) {
  console.error("FATAL: WS_PROXIES env var is not valid JSON:", e.message);
  process.exit(1);
}
if (!Array.isArray(WS_PROXIES) || WS_PROXIES.length === 0) {
  console.error("FATAL: WS_PROXIES env var is empty or not an array");
  process.exit(1);
}
console.log(`[startup] Loaded ${WS_PROXIES.length} proxies from WS_PROXIES env var`);

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
};

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
    "--js-flags=--max-old-space-size=256",
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

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

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
        () => document.querySelector(
          "article,[class*='complaint-item'],[class*='complaint-card'],a[href*='casino-complaints']"
        ) !== null,
        { timeout: 8000, polling: 500 }
      );
    } catch (e) {}

    return page;
  } catch (err) {
    try { await page.close(); } catch (e) {}
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════
// SCRAPE LIST
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
      await page.goto(pgUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      try {
        await page.waitForFunction(
          () => !document.title.includes("Just a moment") && document.title.length > 0,
          { timeout: 10000, polling: 500 }
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

  const decodedUrl = decodeURIComponent(url);
  const startTime  = Date.now();

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
    version: "v4-env-driven-proxies",
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
    proxy_pool_size: WS_PROXIES.length,
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

app.listen(PORT, () => console.log("AG Scraper v4 listening on port " + PORT));
