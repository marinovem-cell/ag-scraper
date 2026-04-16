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

async function waitForCF(page, timeout) {
  try {
    await page.waitForFunction(
      () => !document.title.includes("Just a moment") &&
            !document.title.includes("Attention Required") &&
            document.title.length > 0,
      { timeout: timeout || 20000, polling: 500 }
    );
  } catch(e) {}
}

// Scrape counts + open complaint URLs from the list page
async function scrapeList(page) {
  return page.evaluate(() => {
    const r = {
      resolved:0, rejected:0, unresolved:0, open:0,
      timerUrls:[], totalPages:1,
      casinoOpenEntries:[] // populated when timer text found directly in card
    };

    document.querySelectorAll("*").forEach(el => {
      if (el.children.length > 0) return;
      const t = (el.textContent||"").trim().toUpperCase();
      if (t==="RESOLVED")   r.resolved++;
      if (t==="REJECTED")   r.rejected++;
      if (t==="UNRESOLVED") r.unresolved++;
      if (t==="OPEN")       r.open++;
    });

    // Find complaint cards — try multiple selectors
    const cardSelectors = [
      "article",
      "[class*='complaint-item']",
      "[class*='complaint_item']",
      "[class*='complaint-card']",
      "[class*='complaintCard']",
      ".complaint",
    ];

    let cards = [];
    for (const sel of cardSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > 0) { cards = found; break; }
    }

    // Fallback: find all casino-complaints links and use parent containers
    if (cards.length === 0) {
      document.querySelectorAll("a[href*='casino-complaints']").forEach(a => {
        const card = a.closest("article,li,div[class],[class*='card']");
        if (card && !cards.includes(card)) cards.push(card);
      });
    }

    cards.forEach(card => {
      const cardText = card.textContent || "";
      const link = card.querySelector("a[href*='casino-complaints']");
      if (!link) return;
      const url = link.href;

      // Try to extract "X hours left for NAME to respond" directly from card
      const timerMatch = cardText.match(/(\d+)\s*hours?\s*left\s*for\s*(.+?)\s*to\s*respond/i);
      if (timerMatch) {
        const hoursLeft = parseInt(timerMatch[1]);
        const responder = timerMatch[2].trim();
        const rl = responder.toLowerCase();
        const isPlayer = rl.includes("player")||rl.includes("user")||rl.includes("complainant");
        const isAG     = rl.includes("askgamblers")||rl.includes("ask gamblers");
        if (!isPlayer && !isAG) {
          const d = Math.floor(hoursLeft/24), h = hoursLeft%24;
          r.casinoOpenEntries.push({
            timer:     d > 0 ? (d+"d "+h+"h") : (h+"h"),
            url:       url,
            hoursLeft: hoursLeft,
            responder: responder,
          });
        }
        if (!r.timerUrls.includes(url)) r.timerUrls.push(url);
        return;
      }

      // Fallback: card has "hours left" or "open" but no responder text
      const tl = cardText.toLowerCase();
      if ((tl.includes("hours left") || tl.includes(" open")) && !r.timerUrls.includes(url)) {
        r.timerUrls.push(url);
        // Debug: show what text is near "hours" so we can adjust the regex
        const idx = tl.indexOf("hours");
        if (idx !== -1) {
          r.debugCardSnippet = (r.debugCardSnippet || "") +
            "[card]" + cardText.substring(Math.max(0, idx-80), idx+120).replace(/\s+/g," ").trim() + " ";
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

      // ── Step 3: resolve casinoOpenEntries ────────────────────────
      // AskGamblers blocks direct navigation to individual complaint pages.
      // Solution: fetch the complaint page HTML from WITHIN the browser's
      // JS context using fetch() — this uses the established session cookies
      // and looks like an internal XHR request, not a bot navigation.

      let casinoOpenEntries = [...(listData.casinoOpenEntries || [])];
      const needsVisit = allTimerUrls.filter(u =>
        !casinoOpenEntries.find(e => e.url === u)
      );

      console.log("[full] casinoOpenEntries from list: " + casinoOpenEntries.length);
      console.log("[full] Fetching " + needsVisit.length + " complaint pages via in-page fetch");

      for (let i = 0; i < needsVisit.length; i++) {
        const cpUrl = needsVisit[i];
        console.log("[full] Fetching: " + cpUrl);

        try {
          // Fetch HTML from within the page context — uses existing session
          const cpHtml = await page.evaluate(async (url) => {
            try {
              const res = await fetch(url, {
                method: "GET",
                credentials: "include",
                headers: {
                  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                  "Accept-Language": "en-US,en;q=0.9",
                }
              });
              if (!res.ok) return null;
              return await res.text();
            } catch(e) {
              return null;
            }
          }, cpUrl);

          if (!cpHtml) {
            console.log("[full] fetch returned null for: " + cpUrl);
            continue;
          }

          console.log("[full] HTML length: " + cpHtml.length);

          // Parse timer text from the fetched HTML
          const timerMatch = cpHtml.match(/(\d+)\s*hours?\s*left\s*for\s*(.+?)\s*to\s*respond/i);
          if (!timerMatch) {
            // Show snippet for debugging
            const idx = cpHtml.toLowerCase().indexOf("hours");
            if (idx !== -1) {
              console.log("[full] hours snippet: " + cpHtml.substring(Math.max(0,idx-60), idx+100).replace(/\s+/g," ").trim());
            } else {
              console.log("[full] no 'hours' found in fetched HTML");
            }
            continue;
          }

          const hoursLeft = parseInt(timerMatch[1]);
          const responder = timerMatch[2].trim();
          const rl = responder.toLowerCase();
          const isPlayer = rl.includes("player")||rl.includes("user")||rl.includes("complainant");
          const isAG     = rl.includes("askgamblers")||rl.includes("ask gamblers");
          const casinoMustReply = !isPlayer && !isAG;

          console.log("[full] → " + hoursLeft + "h left for '" + responder + "' casinoMustReply=" + casinoMustReply);

          if (casinoMustReply) {
            const d = Math.floor(hoursLeft/24), h = hoursLeft%24;
            casinoOpenEntries.push({
              timer:     d > 0 ? (d+"d "+h+"h") : (h+"h"),
              url:       cpUrl,
              hoursLeft: hoursLeft,
              responder: responder,
            });
          }

        } catch(cpErr) {
          console.log("[full] fetch error: " + cpErr.message);
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
