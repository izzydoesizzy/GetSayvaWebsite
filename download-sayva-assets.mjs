import fs from "fs";
import path from "path";
import crypto from "crypto";
import { chromium } from "playwright";

const START_URL = "https://getsayva.com/";
const OUT_DIR = path.resolve("./out");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");

// Crawl knobs
const MAX_PAGES = 80;           // max pages to visit
const MAX_CONCURRENCY = 3;      // parallel page workers
const NAV_TIMEOUT_MS = 45000;   // navigation timeout

// Domains Squarespace sites commonly use.
// You can add more if you notice assets coming from elsewhere.
const ALLOWED_DOMAINS = new Set([
  "getsayva.com",
  "www.getsayva.com",
  "static1.squarespace.com",
  "static.squarespace.com",
  "assets.squarespace.com",
  "images.squarespace-cdn.com",
  "definitions.sqspcdn.com",
  "use.typekit.net",
  "p.typekit.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
]);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function isAllowedUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    return ALLOWED_DOMAINS.has(u.host);
  } catch {
    return false;
  }
}

function normalizeUrl(urlStr) {
  // Normalize fragments away; keep query since it often matters for Squarespace image sizes.
  const u = new URL(urlStr);
  u.hash = "";
  return u.toString();
}

function safeLocalPathFromUrl(urlStr) {
  const u = new URL(urlStr);
  const host = u.host;

  // Keep the URL path, but ensure a filename exists.
  let filePath = u.pathname;
  if (filePath.endsWith("/")) filePath += "index.html";

  // If there’s a querystring, append a short hash to avoid overwrites.
  if (u.search && u.search.length > 1) {
    const hash = crypto.createHash("sha1").update(u.search).digest("hex").slice(0, 10);
    const ext = path.extname(filePath);
    const base = ext ? filePath.slice(0, -ext.length) : filePath;
    filePath = `${base}__q_${hash}${ext || ""}`;
  }

  filePath = filePath.replace(/\/+/g, "/"); // normalize repeated slashes
  return path.join(host, filePath);
}

function looksLikeHtml(headers) {
  const ct = (headers["content-type"] || "").toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml+xml");
}

async function autoScroll(page) {
  // Helps trigger lazy-loaded images on Squarespace pages
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight - window.innerHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 150);
    });
  });
}

function extractLinksFromHtml(html, baseUrl) {
  // Quick-and-dirty link extraction to find more internal pages to crawl
  // We prioritize <a href="..."> but also capture src/href values.
  const urls = new Set();

  const add = (v) => {
    if (!v) return;
    try {
      const abs = new URL(v, baseUrl).toString();
      urls.add(abs);
    } catch {}
  };

  // href="..."
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  // src="..."
  for (const m of html.matchAll(/src\s*=\s*["']([^"']+)["']/gi)) add(m[1]);

  return [...urls];
}

async function main() {
  ensureDir(OUT_DIR);

  const manifest = {};
  const downloaded = new Set();      // asset URLs downloaded
  const visitedPages = new Set();    // page URLs visited
  const queue = [];                 // page URLs to visit (FIFO)

  const enqueuePage = (url) => {
    const u = normalizeUrl(url);
    if (!isAllowedUrl(u)) return;
    // Only crawl pages on getsayva.com or www.getsayva.com
    const host = new URL(u).host;
    if (!["getsayva.com", "www.getsayva.com"].includes(host)) return;
    if (visitedPages.has(u)) return;
    if (queue.includes(u)) return;
    queue.push(u);
  };

  enqueuePage(START_URL);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  async function downloadAsset(url, response) {
    const u = normalizeUrl(url);
    if (!isAllowedUrl(u)) return;
    if (downloaded.has(u)) return;

    downloaded.add(u);

    const localRel = safeLocalPathFromUrl(u);
    const localAbs = path.join(OUT_DIR, localRel);
    ensureDir(path.dirname(localAbs));

    try {
      const buf = await response.body();
      fs.writeFileSync(localAbs, buf);
      manifest[u] = localRel;
      process.stdout.write(`⬇️  ${u}\n`);
    } catch (e) {
      // Some responses (redirects, etc.) might not have a body available.
      process.stdout.write(`⚠️  Failed body read: ${u} (${e.message})\n`);
    }
  }

  async function worker(workerId) {
    while (queue.length && visitedPages.size < MAX_PAGES) {
      const pageUrl = queue.shift();
      if (!pageUrl) break;
      const normalized = normalizeUrl(pageUrl);
      if (visitedPages.has(normalized)) continue;

      visitedPages.add(normalized);
      process.stdout.write(`\n🧭 [${workerId}] Visiting (${visitedPages.size}/${MAX_PAGES}): ${normalized}\n`);

      const page = await context.newPage();

      // Capture every response; save allowed assets
      page.on("response", async (resp) => {
        try {
          const url = resp.url();
          if (!isAllowedUrl(url)) return;

          // Save assets broadly; but also save HTML pages as files.
          const headers = resp.headers();
          if (looksLikeHtml(headers)) {
            // Save HTML snapshots too
            const html = await resp.text();
            const localRel = safeLocalPathFromUrl(url);
            const localAbs = path.join(OUT_DIR, localRel);
            ensureDir(path.dirname(localAbs));
            fs.writeFileSync(localAbs, html, "utf-8");
            manifest[normalizeUrl(url)] = localRel;

            // Enqueue more internal links
            for (const link of extractLinksFromHtml(html, url)) {
              enqueuePage(link);
            }
          } else {
            await downloadAsset(url, resp);
          }
        } catch {
          // swallow per-response errors
        }
      });

      try {
        await page.goto(normalized, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
        await autoScroll(page);
        await page.waitForTimeout(800);

        // Also grab the final DOM HTML (sometimes differs from initial response)
        const finalHtml = await page.content();
        const finalRel = safeLocalPathFromUrl(normalized);
        const finalAbs = path.join(OUT_DIR, finalRel);
        ensureDir(path.dirname(finalAbs));
        fs.writeFileSync(finalAbs, finalHtml, "utf-8");
        manifest[normalized] = finalRel;

        // Enqueue <a> links from DOM as well
        const domLinks = await page.evaluate(() => {
          const out = new Set();
          document.querySelectorAll("a[href]").forEach((a) => out.add(a.getAttribute("href")));
          return Array.from(out);
        });
        for (const href of domLinks) {
          try {
            const abs = new URL(href, normalized).toString();
            enqueuePage(abs);
          } catch {}
        }
      } catch (e) {
        process.stdout.write(`❌ [${workerId}] Failed nav: ${normalized} (${e.message})\n`);
      } finally {
        await page.close();
      }
    }
  }

  // Start workers
  const workers = [];
  for (let i = 0; i < MAX_CONCURRENCY; i++) {
    workers.push(worker(i + 1));
  }
  await Promise.all(workers);

  // Write manifest + summary
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");

  await browser.close();

  const summary = {
    startUrl: START_URL,
    outDir: OUT_DIR,
    pagesVisited: visitedPages.size,
    assetsDownloaded: Object.keys(manifest).length,
    manifestFile: MANIFEST_PATH,
  };

  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  console.log("\n✅ Done.");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

