const express   = require("express");
const puppeteer = require("puppeteer-core");

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.AG_SECRET || "";
const CHROME = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

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
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ],
    ignoreHTTPSErrors: true,
  });
}

async function setupPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  });
  return page;
}

async function gotoAndWait(page, url) {
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
  try {
    await page.waitForFunction(
      () => !document.title.includes("Just a moment") &&
            !document.title.includes("Attention Required") &&
            document.title.length > 0,
      { timeout: 30000, polling: 500 }
    );
  } catch(e) {}
  return { title: await page.title(), finalUrl: page.url() };
}

// Scrape counts + open complaint URLs from the list page
async function scrapeList(page) {
  return page.evaluate(() => {
    const r = {
      resolved:0, rejected:0, unresolved:0, open:0,
      timerUrls:[], totalPages:1
    };
    document.querySelectorAll("*").forEach(el => {
      if (el.children.length > 0) return;
      const t = (el.textContent||"").trim().toUpperCase();
      if (t==="RESOLVED")   r.resolved++;
      if (t==="REJECTED")   r.rejected++;
      if (t==="UNRESOLVED") r.unresolved++;
      if (t==="OPEN")       r.open++;
    });
    // Collect URLs of cards that have a timer (OPEN cards)
    document.querySelectorAll("a[href*='casino-complaints']").forEach(a => {
      const card = a.closest("article,li,[class*='card'],[class*='complaint']");
      if (!card) return;
      const t = (card.textContent||"").toLowerCase();
      if ((t.includes("hours left") || t.includes(" open")) &&
          !r.timerUrls.includes(a.href)) {
        r.timerUrls.push(a.href);
      }
    });
    document.querySelectorAll("a[href*='page=']").forEach(a => {
      const m = (a.href||"").match(/page=(\d+)/);
      if (m && parseInt(m[1]) > r.totalPages) r.totalPages = parseInt(m[1]);
    });
    return r;
  });
}

// Scrape timer info from an individual complaint page
async function scrapeComplaint(page) {
  return page.evaluate(() => {
    const body = document.body
      ? (document.body.innerText || document.body.textContent || "")
      : "";

    // Match: "75 hours left for Alf Casino to respond."
    const m = body.match(/(\d+)\s*hours?\s*left\s*for\s*(.+?)\s*to\s*respond/i);
    if (!m) return { hasTimer: false, casinoMustReply: false };

    const hoursLeft = parseInt(m[1]);
    const responder = m[2].trim();
    const rl = responder.toLowerCase();

    // If responder is NOT player/user/askgamblers → casino must reply
    const isPlayer = rl.includes("player") || rl.includes("user") || rl.includes("complainant");
    const isAG     = rl.includes("askgamblers") || rl.includes("ask gamblers");
    const casinoMustReply = !isPlayer && !isAG;

    const d = Math.floor(hoursLeft / 24);
    const h = hoursLeft % 24;
    const timerText = d > 0 ? (d + "d " + h + "h") : (h + "h");

    return { hasTimer: true, casinoMustReply, hoursLeft, responder, timerText };
  });
}

// ══════════════════════════════════════════
// MAIN HANDLER
//
// type=full  → scrapes list page + all open complaint pages in ONE session
//              returns complete data including casinoOpenEntries
//
// type=list  → scrapes list page only (counts + timerUrls)
// type=complaint → scrapes one complaint page (must visit list page first)
// ══════════════════════════════════════════

app.get("/api/scrape", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (SECRET && req.query.secret !== SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const { type, url } = req.query;
  if (!url)  return res.status(400).json({ ok: false, error: "Missing ?url=" });
  if (!type) return res.status(400).json({ ok: false, error: "Missing ?type=" });

  const decodedUrl = decodeURIComponent(url);
  let browser;

  try {
    browser = await launchBrowser();
    const page = await setupPage(browser);

    if (type === "full") {
      // ── Step 1: visit list page ──────────────────────────────────
      console.log("[full] List: " + decodedUrl);
      const listNav = await gotoAndWait(page, decodedUrl);
      console.log("[full] Title: " + listNav.title + " | url: " + listNav.finalUrl);

      if (listNav.title.includes("Just a moment")) {
        return res.status(503).json({ ok: false, error: "Cloudflare block on list page" });
      }

      const listData = await scrapeList(page);

      // ── Step 2: handle pagination ────────────────────────────────
      const allTimerUrls = [...listData.timerUrls];
      for (let pg = 2; pg <= listData.totalPages && pg <= 20; pg++) {
        const sep    = decodedUrl.includes("?") ? "&" : "?";
        const pgUrl  = decodedUrl + sep + "page=" + pg;
        await gotoAndWait(page, pgUrl);
        const pgData = await scrapeList(page);
        listData.resolved   += pgData.resolved;
        listData.rejected   += pgData.rejected;
        listData.unresolved += pgData.unresolved;
        listData.open       += pgData.open;
        pgData.timerUrls.forEach(u => { if (!allTimerUrls.includes(u)) allTimerUrls.push(u); });
      }

      // ── Step 3: visit each open complaint in same session ────────
      const casinoOpenEntries = []; // { timer, url } where casino must reply

      for (let i = 0; i < allTimerUrls.length; i++) {
        const cpUrl = allTimerUrls[i];
        console.log("[full] Complaint " + (i+1) + "/" + allTimerUrls.length + ": " + cpUrl);
        const cpNav = await gotoAndWait(page, cpUrl);
        console.log("[full] → title: " + cpNav.title + " finalUrl: " + cpNav.finalUrl);

        // If still being redirected, skip
        if (cpNav.finalUrl === "https://www.askgamblers.com/casino-complaints" ||
            cpNav.finalUrl === "https://www.askgamblers.com/gambling-complaints") {
          console.log("[full] ← redirected, skipping");
          continue;
        }

        const cpData = await scrapeComplaint(page);
        console.log("[full] → hasTimer=" + cpData.hasTimer +
          " casinoMustReply=" + cpData.casinoMustReply +
          " responder=" + cpData.responder);

        if (cpData.hasTimer && cpData.casinoMustReply) {
          casinoOpenEntries.push({
            timer: cpData.timerText,
            url:   cpUrl,
            hoursLeft: cpData.hoursLeft,
            responder: cpData.responder,
          });
        }
      }

      const total = listData.resolved + listData.rejected +
                    listData.unresolved + listData.open;

      return res.json({
        ok: true,
        title: listNav.title,
        resolved:   listData.resolved,
        rejected:   listData.rejected,
        unresolved: listData.unresolved,
        open:       listData.open,
        total,
        casinoOpenEntries, // entries where casino must reply — for the sheet
      });

    } else if (type === "list") {
      const nav  = await gotoAndWait(page, decodedUrl);
      if (nav.title.includes("Just a moment")) {
        return res.status(503).json({ ok: false, error: "Cloudflare block" });
      }
      const data = await scrapeList(page);
      return res.json({ ok: true, title: nav.title, finalUrl: nav.finalUrl, ...data });

    } else if (type === "complaint") {
      // Visit list page first to establish session, then navigate to complaint
      const listBase = decodedUrl.replace(/\/casino-complaints\/.*/, "/gambling-complaints");
      await gotoAndWait(page, "https://www.askgamblers.com/gambling-complaints");
      const nav  = await gotoAndWait(page, decodedUrl);
      const data = await scrapeComplaint(page);
      return res.json({ ok: true, title: nav.title, finalUrl: nav.finalUrl, ...data });

    } else {
      return res.status(400).json({ ok: false, error: "type must be full, list, or complaint" });
    }

  } catch(e) {
    console.error("Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    if (browser) { try { await browser.close(); } catch(e) {} }
  }
});

app.get("/", (req, res) => res.json({ status: "AG Scraper running" }));

app.listen(PORT, () => console.log("AG Scraper listening on port " + PORT));
