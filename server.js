const express   = require("express");
const puppeteer = require("puppeteer-core");

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.AG_SECRET || "";
const CHROME = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

const AG_BASE = "https://www.askgamblers.com";

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

async function waitForCF(page, timeout) {
  try {
    await page.waitForFunction(
      () => !document.title.includes("Just a moment") &&
            !document.title.includes("Attention Required") &&
            document.title.length > 0,
      { timeout: timeout || 30000, polling: 500 }
    );
  } catch(e) {}
}

async function navigateTo(page, url) {
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
  await waitForCF(page, 30000);
  return { title: await page.title(), finalUrl: page.url() };
}

async function scrapeListPage(page) {
  return page.evaluate(() => {
    const r = { resolved:0, rejected:0, unresolved:0, open:0, timerUrls:[], totalPages:1 };
    document.querySelectorAll("*").forEach(el => {
      if (el.children.length > 0) return;
      const t = (el.textContent||"").trim().toUpperCase();
      if (t==="RESOLVED")   r.resolved++;
      if (t==="REJECTED")   r.rejected++;
      if (t==="UNRESOLVED") r.unresolved++;
      if (t==="OPEN")       r.open++;
    });
    document.querySelectorAll("a[href*='casino-complaints']").forEach(a => {
      const card = a.closest("article,li,[class*='card'],[class*='complaint']");
      if (!card) return;
      const t = (card.textContent||"").toLowerCase();
      if ((t.includes("hours left")||t.includes(" open")) && !r.timerUrls.includes(a.href)) {
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

async function scrapeComplaintPage(page) {
  return page.evaluate(() => {
    const r = {
      hasTimer: false, casinoMustReply: false,
      hoursLeft: null, responder: null, timerText: null,
      debugSnippet: ""
    };
    const body = document.body
      ? (document.body.innerText || document.body.textContent || "")
      : "";
    const idx = body.toLowerCase().indexOf("hours");
    if (idx !== -1) r.debugSnippet = body.substring(Math.max(0, idx-60), idx+120);
    const m = body.match(/(\d+)\s*hours?\s*left\s*for\s*([^\.]+?)\s*to\s*respond/i);
    if (!m) return r;
    r.hasTimer  = true;
    r.hoursLeft = parseInt(m[1]);
    r.responder = m[2].trim();
    const rl = r.responder.toLowerCase();
    const isPlayer = rl.includes("player")||rl.includes("user")||rl.includes("complainant");
    const isAG     = rl.includes("askgamblers")||rl.includes("ask gamblers");
    r.casinoMustReply = !isPlayer && !isAG;
    const d = Math.floor(r.hoursLeft/24), h = r.hoursLeft%24;
    r.timerText = d > 0 ? (d+"d "+h+"h") : (h+"h");
    return r;
  });
}

app.get("/api/scrape", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (SECRET && req.query.secret !== SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const { type, url } = req.query;
  if (!url)  return res.status(400).json({ ok: false, error: "Missing ?url=" });
  if (!type) return res.status(400).json({ ok: false, error: "Missing ?type=" });
  if (type !== "list" && type !== "complaint") {
    return res.status(400).json({ ok: false, error: "type must be list or complaint" });
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await setupPage(browser);
    const decodedUrl = decodeURIComponent(url);

    if (type === "list") {
      // Direct navigation for list page
      const nav = await navigateTo(page, decodedUrl);
      console.log("List page — title: " + nav.title + " | url: " + nav.finalUrl);

      if (nav.title.includes("Just a moment") || nav.title.includes("Attention Required")) {
        return res.status(503).json({ ok: false, error: "Cloudflare challenge not solved" });
      }

      const data = await scrapeListPage(page);
      return res.json({ ok: true, title: nav.title, finalUrl: nav.finalUrl, ...data });

    } else {
      // For complaint pages: visit homepage first to establish session,
      // then navigate to the specific complaint
      console.log("Complaint — establishing session via homepage...");
      await navigateTo(page, AG_BASE + "/gambling-complaints");

      console.log("Complaint — navigating to: " + decodedUrl);
      const nav = await navigateTo(page, decodedUrl);
      console.log("Complaint — title: " + nav.title + " | finalUrl: " + nav.finalUrl);

      if (nav.title.includes("Just a moment") || nav.title.includes("Attention Required")) {
        return res.status(503).json({ ok: false, error: "Cloudflare challenge not solved" });
      }

      const data = await scrapeComplaintPage(page);
      return res.json({ ok: true, title: nav.title, finalUrl: nav.finalUrl, ...data });
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
