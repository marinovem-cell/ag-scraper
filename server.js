const express   = require("express");
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
puppeteer.use(Stealth());

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.AG_SECRET || "";
const CHROME = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

// ── Browser ────────────────────────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
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
      openEntries:[], // { hoursLeft, timer, url }
      totalPages:1
    };

    // Count statuses
    document.querySelectorAll("*").forEach(el => {
      if (el.children.length > 0) return;
      const t = (el.textContent||"").trim().toUpperCase();
      if (t==="RESOLVED")   r.resolved++;
      if (t==="REJECTED")   r.rejected++;
      if (t==="UNRESOLVED") r.unresolved++;
      if (t==="OPEN")       r.open++;
    });

    // Find complaint cards
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

    cards.forEach(card => {
      const link = card.querySelector("a[href*='casino-complaints']");
      if (!link) return;
      const url      = link.href;
      const cardText = (card.textContent||"").replace(/\s+/g," ").trim();
      const cardLow  = cardText.toLowerCase();

      // Extract hours from "74 HOURS LEFT" or "74 hours left for X to respond"
      const hoursMatch = cardLow.match(/(\d+)\s*hours?\s*left/i);
      if (hoursMatch) {
        const hoursLeft = parseInt(hoursMatch[1]);
        const d = Math.floor(hoursLeft/24), h = hoursLeft%24;
        const timer = d > 0 ? (d+"d "+h+"h") : (h+"h");
        if (!r.openEntries.find(e => e.url === url)) {
          r.openEntries.push({ hoursLeft, timer, url });
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

// ── Main handler ───────────────────────────────────────────────────
app.get("/api/scrape", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (SECRET && req.query.secret !== SECRET) {
    return res.status(401).json({ ok:false, error:"Unauthorized" });
  }

  const { url } = req.query;
  if (!url) return res.status(400).json({ ok:false, error:"Missing ?url=" });

  const decodedUrl = decodeURIComponent(url);
  let browser;

  try {
    browser = await launchBrowser();
    const page = await openPage(browser, decodedUrl);
    const title = await page.title();

    console.log("[scrape] " + decodedUrl);
    console.log("[scrape] title: " + title);

    if (title.includes("Just a moment") || title.includes("Attention Required")) {
      return res.status(503).json({ ok:false, error:"Cloudflare block" });
    }

    // Scrape page 1
    const data       = await scrapeList(page);
    const allEntries = [...data.openEntries];

    console.log("[scrape] pg1 — R=" + data.resolved + " J=" + data.rejected +
      " U=" + data.unresolved + " O=" + data.open + " pages=" + data.totalPages);

    // Pagination
    for (let pg = 2; pg <= data.totalPages && pg <= 50; pg++) {
      const sep   = decodedUrl.includes("?") ? "&" : "?";
      const pgUrl = decodedUrl + sep + "page=" + pg;
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
      console.log("[scrape] pg" + pg + " — O=" + pgData.open + " entries=" + pgData.openEntries.length);
    }

    const total = data.resolved + data.rejected + data.unresolved + data.open;

    res.json({
      ok:         true,
      title,
      resolved:   data.resolved,
      rejected:   data.rejected,
      unresolved: data.unresolved,
      open:       data.open,
      total,
      openEntries: allEntries, // { hoursLeft, timer, url } for each OPEN complaint
    });

  } catch(e) {
    console.error("[scrape] Error: " + e.message);
    res.status(500).json({ ok:false, error:e.message });
  } finally {
    if (browser) { try { await browser.close(); } catch(e) {} }
  }
});

app.get("/", (req, res) => res.json({ status:"AG Scraper running" }));
app.listen(PORT, () => console.log("AG Scraper listening on port " + PORT));
