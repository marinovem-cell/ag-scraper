const express   = require("express");
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
puppeteer.use(Stealth());

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.AG_SECRET || "";
const CHROME = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

// ── WebShare proxy config — 10 rotating IPs ──────────────────────
// Same username/password for all, different IP:port per proxy
// Set WS_PROXY_USER and WS_PROXY_PASS as Render environment variables
const WS_USER = process.env.WS_PROXY_USER || "YOUR_WEBSHARE_USERNAME";
const WS_PASS = process.env.WS_PROXY_PASS || "YOUR_WEBSHARE_PASSWORD";

// Add your 10 proxy IPs and ports from WebShare dashboard
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

// Pick a random proxy from the list
function getRandomProxy() {
  return WS_PROXIES[Math.floor(Math.random() * WS_PROXIES.length)];
}

// ── Browser launch ─────────────────────────────────────────────────
async function launchBrowser(useProxy) {
  const args = [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--disable-dev-shm-usage", "--disable-gpu",
    "--no-first-run", "--no-zygote", "--single-process",
    "--window-size=1280,800",
    "--disable-extensions", "--disable-background-networking",
    "--disable-default-apps", "--mute-audio",
  ];

  let proxyInfo = null;
  if (useProxy && hasProxy) {
    proxyInfo = getRandomProxy();
    args.push("--proxy-server=http://" + proxyInfo.host + ":" + proxyInfo.port);
    console.log("[browser] Launching with WebShare proxy " + proxyInfo.host + ":" + proxyInfo.port);
  } else {
    console.log("[browser] Launching with Render IP (direct)");
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args,
    ignoreHTTPSErrors: true,
  });

  return { browser, proxyInfo };
}

// ── Page setup ─────────────────────────────────────────────────────
async function openPage(browser, url, proxyInfo) {
  const page = await browser.newPage();

  // Proxy auth if using WebShare
  if (proxyInfo) {
    await page.authenticate({
      username: WS_USER,
      password: WS_PASS,
    });
  }

  // Block unnecessary resources
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
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });

  try {
    await page.waitForFunction(
      () => !document.title.includes("Just a moment") &&
            !document.title.includes("Attention Required") &&
            document.title.length > 0,
      { timeout: 20000, polling: 500 }
    );
  } catch(e) {}

  try {
    await page.waitForFunction(
      () => document.querySelector(
        "article,[class*='complaint-item'],[class*='complaint-card'],a[href*='casino-complaints']"
      ) !== null,
      { timeout: 10000, polling: 500 }
    );
  } catch(e) {}

  return page;
}

// ── List page scraper ──────────────────────────────────────────────
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

// ── Scrape one casino (with optional proxy) ────────────────────────
async function scrapeCasino(url, useProxy) {
  let browser;
  try {
    const launched = await launchBrowser(useProxy);
    browser = launched.browser;
    const proxyInfo = launched.proxyInfo;
    const page  = await openPage(browser, url, proxyInfo);
    const title = await page.title();
    const mode  = proxyInfo ? "[proxy:" + proxyInfo.host + "]" : "[direct]";
    console.log(mode + " " + url.split("/").slice(-2).join("/") + " → " + title);

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
      } catch(e) {}
      const pgData = await scrapeList(page);
      data.resolved   += pgData.resolved;
      data.rejected   += pgData.rejected;
      data.unresolved += pgData.unresolved;
      data.open       += pgData.open;
      pgData.openEntries.forEach(e => {
        if (!allEntries.find(x => x.url === e.url)) allEntries.push(e);
      });
    }

    return {
      ok:         true,
      title,
      resolved:   data.resolved,
      rejected:   data.rejected,
      unresolved: data.unresolved,
      open:       data.open,
      total:      data.resolved + data.rejected + data.unresolved + data.open,
      openEntries: allEntries,
    };

  } catch(e) {
    console.error("[error] " + e.message);
    return { ok: false, error: e.message };
  } finally {
    if (browser) { try { await browser.close(); } catch(e) {} }
  }
}

// ── Main route ─────────────────────────────────────────────────────
app.get("/api/scrape", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (SECRET && req.query.secret !== SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const { url } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: "Missing ?url=" });

  const decodedUrl = decodeURIComponent(url);

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Render timeout after 70s")), 70000)
  );

  try {
    // ── Attempt 1: Render's own IP (direct) ───────────────────────
    let result = await Promise.race([
      scrapeCasino(decodedUrl, false),
      timeout
    ]);

    // ── Attempt 2: WebShare proxy (if direct was CF blocked) ──────
    if (result.cfBlocked && hasProxy) {
      console.log("[fallback] Direct blocked — retrying with WebShare proxy");
      result = await Promise.race([
        scrapeCasino(decodedUrl, true),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Proxy timeout after 70s")), 70000)
        )
      ]);
    }

    // ── Attempt 3: Back to direct (if proxy also blocked) ─────────
    if (result.cfBlocked && hasProxy) {
      console.log("[fallback] Proxy also blocked — final attempt direct");
      result = await Promise.race([
        scrapeCasino(decodedUrl, false),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Final timeout after 70s")), 70000)
        )
      ]);
    }

    res.json(result);
  } catch(e) {
    console.error("[error] " + e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/", (req, res) => res.json({
  status: "AG Scraper running",
  proxy: hasProxy ? "WebShare configured" : "No proxy — direct only"
}));

app.listen(PORT, () => console.log("AG Scraper listening on port " + PORT));
