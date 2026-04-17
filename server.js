const express   = require("express");
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
puppeteer.use(Stealth());

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.AG_SECRET || "";
const CHROME = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

// ── Browser — fresh launch per request, no shared state ───────────
// Shared browser caused OOM on Render's free 512MB tier after ~8 pages.
// Fresh launch adds ~15s but is 100% reliable.
async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--window-size=1280,800",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--hide-scrollbars",
      "--metrics-recording-only",
      "--mute-audio",
      "--safebrowsing-disable-auto-update",
    ],
    ignoreHTTPSErrors: true,
  });
}

// ── Page setup ─────────────────────────────────────────────────────
async function openPage(browser, url) {
  const page = await browser.newPage();

  // Block unnecessary resources to save memory & speed up loading
  await page.setRequestInterception(true);
  page.on("request", req => {
    const type = req.resourceType();
    if (["image","stylesheet","font","media","websocket"].includes(type)) {
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

  // Wait for Cloudflare to clear (up to 20s)
  try {
    await page.waitForFunction(
      () => !document.title.includes("Just a moment") &&
            !document.title.includes("Attention Required") &&
            document.title.length > 0,
      { timeout: 20000, polling: 500 }
    );
  } catch(e) {}

  // Wait for complaint cards
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

    // Find cards
    const selectors = [
      "article",
      "[class*='complaint-item']",
      "[class*='complaint_item']",
      "[class*='complaint-card']",
      "[class*='complaintCard']",
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

    // Count status ONCE per card
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
          r.openEntries.push({
            hoursLeft,
            timer: d > 0 ? (d+"d "+h+"h") : (h+"h"),
            url
          });
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

// ── Scrape one casino ──────────────────────────────────────────────
async function scrapeCasino(url) {
  let browser;
  try {
    browser = await launchBrowser();
    const page  = await openPage(browser, url);
    const title = await page.title();
    console.log("[scrape] " + url.split("/").slice(-2).join("/") + " → " + title);

    if (title.includes("Just a moment") || title.includes("Attention Required")) {
      return { ok: false, error: "Cloudflare block" };
    }

    const data       = await scrapeList(page);
    const allEntries = [...data.openEntries];

    // Pagination
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
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
  }
}

// ── Routes ─────────────────────────────────────────────────────────
app.get("/api/scrape", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (SECRET && req.query.secret !== SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const { url } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: "Missing ?url=" });

  // Hard 70s timeout — GAS must get a response before its 6-min limit
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Render timeout after 70s")), 70000)
  );

  try {
    const result = await Promise.race([
      scrapeCasino(decodeURIComponent(url)),
      timeout
    ]);
    res.json(result);
  } catch(e) {
    console.error("[error] " + e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/", (req, res) => res.json({ status: "AG Scraper running" }));

app.listen(PORT, () => console.log("AG Scraper listening on port " + PORT));
