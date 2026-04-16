const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

function json(res, data, status) {
  res.setHeader("Content-Type", "application/json");
  res.status(status || 200).json(data);
}
function err(res, message, status) {
  json(res, { ok: false, error: message }, status || 500);
}

async function launchBrowser() {
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
}

async function openPage(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
  try {
    await page.waitForFunction(
      () => !document.title.includes("Just a moment"),
      { timeout: 12000 }
    );
  } catch(e) {}
  return page;
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
    const r = { hasTimer:false, casinoMustReply:false, hoursLeft:null, responder:null, timerText:null };
    const body = document.body ? (document.body.innerText||document.body.textContent||"") : "";
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

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const secret = process.env.AG_SECRET;
  if (secret && req.query.secret !== secret) return err(res, "Unauthorized", 401);

  const { type, url } = req.query;
  if (!url)  return err(res, "Missing ?url=", 400);
  if (!type) return err(res, "Missing ?type= (list or complaint)", 400);
  if (type !== "list" && type !== "complaint") return err(res, "type must be list or complaint", 400);

  let browser;
  try {
    browser = await launchBrowser();
    const page = await openPage(browser, decodeURIComponent(url));
    const title = await page.title();

    if (title.includes("Just a moment") || title.includes("Attention Required")) {
      return err(res, "Cloudflare challenge not solved", 503);
    }

    const data = type === "list"
      ? await scrapeListPage(page)
      : await scrapeComplaintPage(page);

    json(res, { ok: true, title, ...data });
  } catch(e) {
    err(res, e.message);
  } finally {
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
  }
};
