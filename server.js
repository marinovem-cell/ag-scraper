const express   = require("express");
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
puppeteer.use(Stealth());

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.AG_SECRET || "";
const CHROME = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

// ── Shared browser instance (reused across requests) ──────────────
let sharedBrowser = null;
let browserLastUsed = 0;
const BROWSER_TTL = 5 * 60 * 1000; // recycle after 5 min idle

async function getBrowser() {
  const now = Date.now();
  // Recycle if idle too long or crashed
  if (sharedBrowser) {
    try {
      await sharedBrowser.version(); // ping
      if (now - browserLastUsed > BROWSER_TTL) {
        await sharedBrowser.close().catch(()=>{});
        sharedBrowser = null;
      }
    } catch(e) {
      sharedBrowser = null;
    }
  }
  if (!sharedBrowser) {
    console.log("[browser] Launching new instance");
    sharedBrowser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", "--disable-gpu",
        "--no-first-run", "--no-zygote", "--single-process",
        "--window-size=1920,1080",
      ],
      ignoreHTTPSErrors: true,
    });
  }
  browserLastUsed = now;
  return sharedBrowser;
}

// ── Page helpers ───────────────────────────────────────────────────
async function openPage(browser, url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  });
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
  try {
    await page.waitForFunction(
      () => !document.title.includes("Just a moment") &&
            !document.title.includes("Attention Required") &&
            document.title.length > 0,
      { timeout: 30000, polling: 500 }
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

    // Find complaint cards first
    const selectors = ["article","[class*='complaint-item']","[class*='complaint_item']",
                       "[class*='complaint-card']","[class*='complaintCard']"];
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

    // Count status ONCE per card by finding the status element
    cards.forEach(card => {
      // Find the status badge — it's typically the first/most prominent text
      // that exactly matches a status word
      const statusEl = card.querySelector(
        "[class*='status'],[class*='badge'],[class*='label'],[class*='state']"
      );
      let status = "";
      if (statusEl) {
        status = statusEl.textContent.trim().toUpperCase();
      } else {
        // Fallback: find leaf node with exact status text
        const leaves = Array.from(card.querySelectorAll("*")).filter(el =>
          el.children.length === 0
        );
        for (const leaf of leaves) {
          const t = leaf.textContent.trim().toUpperCase();
          if (t === "RESOLVED" || t === "REJECTED" || t === "UNRESOLVED" || t === "OPEN") {
            status = t; break;
          }
        }
      }

      if (status === "RESOLVED")   r.resolved++;
      if (status === "REJECTED")   r.rejected++;
      if (status === "UNRESOLVED") r.unresolved++;
      if (status === "OPEN")       r.open++;

      // Extract timer for OPEN cards
      const link = card.querySelector("a[href*='casino-complaints']");
      if (!link) return;
      const url     = link.href;
      const cardLow = (card.textContent||"").replace(/\s+/g," ").toLowerCase();
      const m = cardLow.match(/(\d+)\s*hours?\s*left/i);
      if (m) {
        const hoursLeft = parseInt(m[1]);
        const d = Math.floor(hoursLeft/24), h = hoursLeft%24;
        if (!r.openEntries.find(e => e.url === url)) {
          r.openEntries.push({ hoursLeft, timer: d>0?(d+"d "+h+"h"):(h+"h"), url });
        }
      }
    });

    // Pagination
    document.querySelectorAll("a[href*='page=']").forEach(a => {
      const m = (a.href||"").match(/page=(\d+)/);
      if (m && parseInt(m[1]) > r.totalPages) r.totalPages = parseInt(m[1]);
    });

    return r;
  });
}

// ── Scrape one casino URL (reuses shared browser) ─────────────────
async function scrapeCasino(url) {
  const browser = await getBrowser();
  let page;
  try {
    page = await openPage(browser, url);
    const title = await page.title();
    console.log("[scrape] " + url + " → " + title);

    if (title.includes("Just a moment") || title.includes("Attention Required")) {
      return { ok: false, error: "Cloudflare block" };
    }

    const data       = await scrapeList(page);
    const allEntries = [...data.openEntries];

    // Pagination — navigate within same page (faster than new page)
    for (let pg = 2; pg <= data.totalPages && pg <= 50; pg++) {
      const sep   = url.includes("?") ? "&" : "?";
      const pgUrl = url + sep + "page=" + pg;
      await page.goto(pgUrl, { waitUntil: "networkidle2", timeout: 45000 });
      try {
        await page.waitForFunction(
          () => !document.title.includes("Just a moment") && document.title.length > 0,
          { timeout: 15000, polling: 500 }
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
  } finally {
    // Close page but keep browser alive
    if (page) { try { await page.close(); } catch(e) {} }
  }
}

// ── Main handler ───────────────────────────────────────────────────
app.get("/api/scrape", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (SECRET && req.query.secret !== SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const { url } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: "Missing ?url=" });

  try {
    const result = await scrapeCasino(decodeURIComponent(url));
    res.json(result);
  } catch(e) {
    console.error("[error] " + e.message);
    // Browser may have crashed — reset it
    sharedBrowser = null;
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Batch handler — scrapes multiple URLs in one request ──────────
// Called by GAS with ?urls=URL1,URL2,URL3 (comma separated, encoded)
app.get("/api/batch", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (SECRET && req.query.secret !== SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const rawUrls = req.query.urls;
  if (!rawUrls) return res.status(400).json({ ok: false, error: "Missing ?urls=" });

  const urls = rawUrls.split(",").map(u => decodeURIComponent(u.trim())).filter(Boolean);
  if (urls.length === 0) return res.status(400).json({ ok: false, error: "No valid URLs" });

  console.log("[batch] Processing " + urls.length + " URLs");

  const results = [];
  for (const url of urls) {
    try {
      const r = await scrapeCasino(url);
      results.push({ url, ...r });
    } catch(e) {
      console.error("[batch] Error for " + url + ": " + e.message);
      sharedBrowser = null; // reset on crash
      results.push({ url, ok: false, error: e.message });
    }
  }

  res.json({ ok: true, results });
});

app.get("/", (req, res) => res.json({ status: "AG Scraper running", browserAlive: !!sharedBrowser }));
app.listen(PORT, () => console.log("AG Scraper listening on port " + PORT));
