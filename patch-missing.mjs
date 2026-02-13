import fs from "fs";
import path from "path";
import crypto from "crypto";
import { chromium } from "playwright";

const OUT_DIR = path.resolve("./out");
const LOG_PATH = path.resolve("./output.txt");

// Where patched content goes (collision-proof)
const PATCH_PAGES_DIR = path.join(OUT_DIR, "_pages");
const PATCH_ASSETS_DIR = path.join(OUT_DIR, "_assets");
const PATCH_DOWNLOADS_DIR = path.join(OUT_DIR, "_downloads");
const PATCH_MANIFEST_PATH = path.join(OUT_DIR, "manifest.patch.json");

// If you have an existing manifest, we’ll use it to skip already-downloaded URLs.
const EXISTING_MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");

const NAV_TIMEOUT_MS = 45000;

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

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function normalizeUrl(urlStr) {
  const u = new URL(urlStr);
  u.hash = "";
  return u.toString();
}

function isAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    return ["http:", "https:"].includes(u.protocol) && ALLOWED_DOMAINS.has(u.host);
  } catch {
    return false;
  }
}

function looksLikePage(urlStr) {
  // Treat as “page” if it’s on getsayva.com and doesn't look like a static asset.
  const u = new URL(urlStr);
  const hostOk = u.host === "getsayva.com" || u.host === "www.getsayva.com";
  if (!hostOk) return false;

  const p = u.pathname.toLowerCase();

  // If it ends with a known asset extension, it's not a page.
  const assetExts = [".js", ".css", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".mp4", ".json", ".xml"];
  if (assetExts.some((ext) => p.endsWith(ext))) return false;

  return true;
}

function safeAssetPath(urlStr) {
  const u = new URL(urlStr);
  const host = u.host;

  // base path
  let p = u.pathname;
  if (p.endsWith("/")) p += "index";

  // Keep extension if present; otherwise guess later from content-type
  let ext = path.extname(p);
  let base = ext ? p.slice(0, -ext.length) : p;

  // Add query hash to avoid collisions
  if (u.search && u.search.length > 1) {
    const qh = sha1(u.search).slice(0, 10);
    base = `${base}__q_${qh}`;
  }

  // Prevent insanely long filenames:
  const fileName = path.basename(base) + (ext || "");
  let safeFileName = fileName;

  if (safeFileName.length > 180) {
    safeFileName = sha1(urlStr).slice(0, 24) + (ext || "");
  }

  // Prevent long directory segments too
  const dir = path.dirname(base)
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      return seg.length > 120 ? sha1(seg).slice(0, 24) : seg;
    })
    .join("/");

  return path.join(host, dir, safeFileName).replace(/\/+/g, "/");
}

function extractFailedUrlsFromLog(text) {
  const urls = new Set();

  // 1) Failed nav: <url>
  for (const m of text.matchAll(/Failed nav:\s+(https?:\/\/\S+)/g)) {
    urls.add(m[1].replace(/[)\]]+$/, ""));
  }

  // 2) ENAMETOOLONG lines include the URL earlier as "Failed body read: <url>"
  for (const m of text.matchAll(/Failed body read:\s+(https?:\/\/\S+)/g)) {
    urls.add(m[1].replace(/[)\]]+$/, ""));
  }

  // 3) Any explicit download starting lines (the URL appears in Failed nav already, but belt+suspenders)
  for (const m of text.matchAll(/navigating to\s+"(https?:\/\/[^"]+)"/g)) {
    urls.add(m[1]);
  }

  return [...urls].map(normalizeUrl).filter(isAllowed);
}

function loadExistingManifest() {
  try {
    if (!fs.existsSync(EXISTING_MANIFEST_PATH)) return {};
    return JSON.parse(fs.readFileSync(EXISTING_MANIFEST_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function fileExistsForManifestEntry(relPath) {
  if (!relPath) return false;
  const abs = path.join(OUT_DIR, relPath);
  return fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size > 0;
}

async function main() {
  ensureDir(OUT_DIR);
  ensureDir(PATCH_PAGES_DIR);
  ensureDir(PATCH_ASSETS_DIR);
  ensureDir(PATCH_DOWNLOADS_DIR);

  if (!fs.existsSync(LOG_PATH)) {
    console.error(`Couldn't find ${LOG_PATH}. Put your output.txt in this folder.`);
    process.exit(1);
  }

  const logText = fs.readFileSync(LOG_PATH, "utf-8");
  const candidates = extractFailedUrlsFromLog(logText);

  const existing = loadExistingManifest();
  const patchManifest = {};

  // Filter to truly-missing: not in manifest OR manifest file missing/empty
  const missing = candidates.filter((url) => {
    const rel = existing[url];
    if (!rel) return true;
    return !fileExistsForManifestEntry(rel);
  });

  console.log(`Found ${candidates.length} failed URL candidates.`);
  console.log(`Missing after checking manifest.json: ${missing.length}`);
  if (missing.length === 0) {
    console.log("✅ Nothing to patch.");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  // Download handler for PDFs etc.
  context.on("page", (page) => {
    page.on("download", async (dl) => {
      try {
        const url = normalizeUrl(dl.url());
        if (!isAllowed(url)) return;

        const suggested = dl.suggestedFilename();
        const outName = `${sha1(url).slice(0, 10)}__${suggested}`;
        const dest = path.join(PATCH_DOWNLOADS_DIR, outName);

        await dl.saveAs(dest);
        patchManifest[url] = path.relative(OUT_DIR, dest);
        console.log(`📥 Saved download: ${url} -> ${patchManifest[url]}`);
      } catch (e) {
        console.log(`⚠️  Download save failed: ${e.message}`);
      }
    });
  });

  // Use Playwright’s request API to fetch assets without navigation (fixes Typekit ENAMETOOLONG)
  const request = context.request;

  for (const url of missing) {
    try {
      if (looksLikePage(url)) {
        // Save page DOM into _pages/<sha>.html
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });

        // Trigger lazy-load images
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
        await page.waitForTimeout(500);

        const html = await page.content();
        const file = path.join(PATCH_PAGES_DIR, `${sha1(url)}.html`);
        fs.writeFileSync(file, html, "utf-8");
        patchManifest[url] = path.relative(OUT_DIR, file);
        console.log(`🧾 Patched page: ${url} -> ${patchManifest[url]}`);
        await page.close();
      } else {
        // Asset: fetch directly, store under _assets/<host>/...
        const resp = await request.get(url);
        if (!resp.ok()) {
          console.log(`⚠️  Asset fetch failed (${resp.status()}): ${url}`);
          continue;
        }

        const headers = resp.headers();
        const ct = (headers["content-type"] || "").toLowerCase();

        let rel = safeAssetPath(url);

        // If no extension, guess from content-type
        const absGuess = path.join(PATCH_ASSETS_DIR, rel);
        const ext = path.extname(absGuess);
        if (!ext) {
          if (ct.includes("javascript")) rel += ".js";
          else if (ct.includes("css")) rel += ".css";
          else if (ct.includes("html")) rel += ".html";
          else if (ct.includes("json")) rel += ".json";
        }

        const abs = path.join(PATCH_ASSETS_DIR, rel);
        ensureDir(path.dirname(abs));

        const body = await resp.body();
        fs.writeFileSync(abs, body);

        patchManifest[url] = path.relative(OUT_DIR, abs);
        console.log(`⬇️  Patched asset: ${url} -> ${patchManifest[url]}`);
      }
    } catch (e) {
      console.log(`❌ Patch failed: ${url} (${e.message})`);
    }
  }

  await browser.close();

  fs.writeFileSync(PATCH_MANIFEST_PATH, JSON.stringify(patchManifest, null, 2), "utf-8");
  console.log(`\n✅ Patch complete. Wrote ${Object.keys(patchManifest).length} entries to out/manifest.patch.json`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

