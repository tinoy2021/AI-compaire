const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { chromium } = require("playwright");
const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");
const sharp = require("sharp");
const pixelmatchImport = require("pixelmatch");
const pixelmatch =
  typeof pixelmatchImport === "function" ? pixelmatchImport : pixelmatchImport.default;
const { PNG } = require("pngjs");

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AI_PROVIDER_RAW = (process.env.AI_PROVIDER || "").toLowerCase().trim();

function resolveAIProvider() {
  if (AI_PROVIDER_RAW === "openai") {
    if (!OPENAI_API_KEY) {
      console.error("AI_PROVIDER=openai but OPENAI_API_KEY is missing.");
      process.exit(1);
    }
    return "openai";
  }
  if (AI_PROVIDER_RAW === "gemini") {
    if (!GEMINI_API_KEY) {
      console.error(
        'AI_PROVIDER=gemini but GEMINI_API_KEY (or GOOGLE_API_KEY) is missing.'
      );
      process.exit(1);
    }
    return "gemini";
  }
  if (AI_PROVIDER_RAW) {
    console.error(`Unknown AI_PROVIDER="${process.env.AI_PROVIDER}". Use "gemini" or "openai".`);
    process.exit(1);
  }

  const hasGemini = Boolean(GEMINI_API_KEY);
  const hasOpenAI = Boolean(OPENAI_API_KEY);

  if (hasGemini && hasOpenAI) {
    console.log(
      'Both Gemini and OpenAI keys found; defaulting to gemini. Set AI_PROVIDER=openai for OpenAI.'
    );
    return "gemini";
  }
  if (hasGemini) return "gemini";
  if (hasOpenAI) return "openai";

  console.error("No API key found. Add one of the following to your .env file:");
  console.error("  GEMINI_API_KEY=...      (Gemini, from Google AI Studio)");
  console.error("  OPENAI_API_KEY=...      (OpenAI vision)");
  console.error('Optional when both keys exist: AI_PROVIDER=gemini | openai');
  process.exit(1);
}

const aiProvider = resolveAIProvider();

let geminiClient = null;
if (aiProvider === "gemini") {
  geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

let openaiClient = null;
if (aiProvider === "openai") {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * Gemini models tried in order (Pro first = premium-quality default).
 * Override with one model: GEMINI_MODEL=gemini-2.5-pro
 * Or explicit list: GEMINI_MODELS=gemini-2.5-pro,gemini-2.5-flash
 */
function resolveGeminiModelList() {
  const listEnv = process.env.GEMINI_MODELS;
  if (listEnv && listEnv.trim()) {
    return listEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const single = process.env.GEMINI_MODEL?.trim();
  if (single) return [single];
  // Pro first (premium); avoid gemini-1.5-pro — often 404 on current AI Studio v1beta.
  return ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
}

const GEMINI_MODELS = resolveGeminiModelList();

function buildComparisonPrompt(pagePairText) {
  return `
You are doing visual QA for webpage screenshots.
Compare screenshots from two different websites for equivalent pages:
${pagePairText}

Rules:
- "perfect" only if no meaningful visual difference for human eyes.
- "changes_visible" if any human-visible change exists.
- Ignore minor JPEG/PNG noise or anti-aliasing speckles.

Respond in STRICT JSON:
{
  "verdict": "perfect" | "changes_visible" | "unclear",
  "human_visible_changes": true | false,
  "confidence": number (0 to 1),
  "summary": "short sentence"
}
`;
}

function parseVerdictJson(raw, sourceLabel) {
  const trimmed = String(raw ?? "").trim();
  let cleaned = trimmed;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fenced) cleaned = fenced[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      verdict: "unclear",
      human_visible_changes: true,
      confidence: 0,
      summary: `Could not parse ${sourceLabel} JSON. Raw response: ${trimmed.slice(0, 200)}`,
    };
  }
}

const websiteA = process.argv[2];
const websiteB = process.argv[3];
const maxLinks = Number(process.argv[4] || 0);

/** Max unique pages to visit per site when discovering hyperlinks (env, default 1 = entry URL only). */
const CRAWL_MAX_PAGES = Math.max(
  1,
  Number.parseInt(process.env.CRAWL_MAX_PAGES || "1", 10) || 1
);

if (!websiteA || !websiteB) {
  console.error("Usage: node link-visual-compare.js <website_a_url> <website_b_url> [max_links]");
  console.error(
    "Optional: set CRAWL_MAX_PAGES in .env (e.g. 50) to discover links across more pages per site."
  );
  process.exit(1);
}

function sanitizeName(raw) {
  return raw.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 80);
}

function linkToFileSlug(urlString) {
  const hash = crypto.createHash("sha1").update(String(urlString)).digest("hex").slice(0, 10);
  const pathPart = sanitizeName(String(urlString)) || "root";
  return `${pathPart}_${hash}.png`;
}

function pathKey(urlString) {
  const urlObj = new URL(urlString);
  const normalizedPath = urlObj.pathname.replace(/\/+$/, "") || "/";
  const normalizedSearch = urlObj.search || "";
  return `${normalizedPath}${normalizedSearch}`;
}

function canonicalUrl(urlString) {
  try {
    const u = new URL(urlString);
    u.hash = "";
    return u.toString();
  } catch {
    return urlString;
  }
}

/**
 * Breadth-first crawl on same origin: visits up to maxPagesToVisit unique URLs
 * and unions every same-origin <a href> seen on those pages.
 */
async function collectSameOriginLinksByCrawl(context, startUrl, maxPagesToVisit) {
  const origin = new URL(startUrl).origin;
  const startCanon = canonicalUrl(startUrl);
  const discovered = new Set([startCanon]);
  const visited = new Set();
  const queue = [startCanon];
  const queued = new Set([startCanon]);

  while (queue.length > 0 && visited.size < maxPagesToVisit) {
    const url = queue.shift();
    const canon = canonicalUrl(url);
    queued.delete(canon);
    if (visited.has(canon)) continue;
    visited.add(canon);

    const page = await context.newPage();
    let linksOnPage = [];
    try {
      await page.goto(canon, { waitUntil: "networkidle", timeout: 60000 });
      linksOnPage = await getAllLinks(page, canon);
    } catch (err) {
      console.warn(`Crawl skip (load failed): ${canon} — ${String(err.message).slice(0, 100)}`);
    } finally {
      await page.close();
    }

    for (const link of linksOnPage) {
      let abs;
      try {
        abs = canonicalUrl(link);
        if (new URL(abs).origin !== origin) continue;
      } catch {
        continue;
      }
      discovered.add(abs);
      if (!visited.has(abs) && !queued.has(abs)) {
        queue.push(abs);
        queued.add(abs);
      }
    }
  }

  return Array.from(discovered);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function getAllLinks(page, baseUrl) {
  const links = await page.$$eval("a[href]", (anchors) =>
    anchors.map((a) => a.getAttribute("href")).filter(Boolean)
  );

  const normalized = links
    .map((href) => {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const unique = Array.from(new Set(normalized));
  const sameOrigin = unique.filter((link) => {
    try {
      return new URL(link).origin === new URL(baseUrl).origin;
    } catch {
      return false;
    }
  });

  return sameOrigin;
}

async function takeScreenshot(context, url, destinationFile) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.screenshot({ path: destinationFile, fullPage: true });
  } finally {
    await page.close();
  }
}

async function compareWithGemini(websiteABufferPath, websiteBBufferPath, pagePairText) {
  const [websiteABuffer, websiteBBuffer] = await Promise.all([
    fs.readFile(websiteABufferPath),
    fs.readFile(websiteBBufferPath),
  ]);

  const prompt = buildComparisonPrompt(pagePairText);

  let response;
  let lastError;
  for (const modelName of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await geminiClient.models.generateContent({
          model: modelName,
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: websiteABuffer.toString("base64"),
                  },
                },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: websiteBBuffer.toString("base64"),
                  },
                },
              ],
            },
          ],
          config: {
            responseMimeType: "application/json",
          },
        });
        break;
      } catch (error) {
        lastError = error;
        const errorText = String(error?.message || error);
        if (errorText.includes("API_KEY_INVALID")) {
          console.error("\nGemini API key is invalid.");
          console.error("Update your .env file with a valid key from Google AI Studio.");
          console.error("Expected: GEMINI_API_KEY=AIza...");
          console.error("Then rerun the command.");
          throw error;
        }

        const isModelNotFound =
          errorText.includes('"code":404') ||
          errorText.includes("not found for API version") ||
          errorText.includes("is not supported for generateContent") ||
          errorText.includes("NOT_FOUND");

        if (isModelNotFound) {
          console.warn(
            `Gemini model "${modelName}" is not available for this API key/region. Trying next model...`
          );
          break;
        }

        const isTransient =
          errorText.includes('"code":503') ||
          errorText.includes("UNAVAILABLE") ||
          errorText.includes('"code":429') ||
          errorText.includes("RESOURCE_EXHAUSTED");

        if (isTransient && attempt < 3) {
          const delayMs = attempt * 2000;
          console.log(
            `Gemini busy on ${modelName} (attempt ${attempt}/3). Retrying in ${delayMs / 1000}s...`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        console.warn(`Gemini ${modelName} error (attempt ${attempt}/3): ${errorText.slice(0, 160)}`);
        if (attempt === 3) break;
      }
    }
    if (response) {
      break;
    }
  }

  if (!response) {
    throw lastError || new Error("Gemini comparison failed after retries.");
  }

  const raw = response.text || "";
  return parseVerdictJson(raw, "Gemini");
}

async function compareWithOpenAI(websiteABufferPath, websiteBBufferPath, pagePairText) {
  const [websiteABuffer, websiteBBuffer] = await Promise.all([
    fs.readFile(websiteABufferPath),
    fs.readFile(websiteBBufferPath),
  ]);

  const prompt = buildComparisonPrompt(pagePairText);
  const urlA = `data:image/png;base64,${websiteABuffer.toString("base64")}`;
  const urlB = `data:image/png;base64,${websiteBBuffer.toString("base64")}`;

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const completion = await openaiClient.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: urlA } },
              { type: "image_url", image_url: { url: urlB } },
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 500,
      });
      const raw = completion.choices[0]?.message?.content ?? "";
      return parseVerdictJson(raw, "OpenAI");
    } catch (error) {
      lastError = error;
      const errorText = String(error?.message || error);
      if (
        errorText.includes("Incorrect API key") ||
        errorText.includes("invalid_api_key") ||
        errorText.includes("401")
      ) {
        console.error("\nOpenAI API key is invalid or unauthorized.");
        console.error("Check OPENAI_API_KEY in your .env file.");
        throw error;
      }
      const rateLimited =
        errorText.includes("429") || errorText.includes("rate_limit") || errorText.includes("Rate limit");
      if (!rateLimited || attempt === 3) {
        throw error;
      }
      const delayMs = attempt * 2000;
      console.log(`OpenAI busy or rate limited (attempt ${attempt}/3). Retrying in ${delayMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error("OpenAI comparison failed after retries.");
}

function buildLinkMap(links) {
  const map = new Map();
  for (const link of links) {
    map.set(pathKey(link), link);
  }
  return map;
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(results) {
  const headers = [
    "ai_provider",
    "match_key",
    "website_a_url",
    "website_b_url",
    "verdict",
    "human_visible_changes",
    "confidence",
    "summary",
  ];

  const rows = results.map((r) =>
    [
      r.ai_provider,
      r.match_key,
      r.website_a_url,
      r.website_b_url,
      r.verdict,
      r.human_visible_changes,
      r.confidence,
      r.summary,
    ]
      .map(csvCell)
      .join(",")
  );

  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function relPathForReport(reportDir, absolutePath) {
  return path.relative(reportDir, absolutePath).split(path.sep).join("/");
}

/** Compressed JPEG data URL so the HTML report works when shared as one file. */
async function embedImageDataUrl(filePath) {
  if (!filePath) return null;
  try {
    const buf = await sharp(filePath)
      .resize({ width: 900, withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch (err) {
    console.warn(`Could not embed image ${filePath}: ${err.message}`);
    return null;
  }
}

async function prepareResultsForHtml(results) {
  const prepared = [];
  for (const r of results) {
    const copy = { ...r };
    if (r.screenshot_a_path) {
      copy.screenshot_a_src = await embedImageDataUrl(r.screenshot_a_path);
    }
    if (r.screenshot_b_path) {
      copy.screenshot_b_src = await embedImageDataUrl(r.screenshot_b_path);
    }
    if (r.diff_highlight_path) {
      copy.diff_highlight_src = await embedImageDataUrl(r.diff_highlight_path);
    }
    prepared.push(copy);
  }
  return prepared;
}

function imgSrcForRow(row, srcKey, relKey) {
  if (row[srcKey]) return row[srcKey];
  if (row[relKey]) return escapeHtml(row[relKey]);
  return null;
}

/** Align two full-page PNGs to the same size (top-left, white padding). */
async function loadAlignedPngPair(pathA, pathB, targetWidth = 1200) {
  const bufA = await sharp(pathA).resize({ width: targetWidth, withoutEnlargement: true }).png().toBuffer();
  const bufB = await sharp(pathB).resize({ width: targetWidth, withoutEnlargement: true }).png().toBuffer();
  const imgA = PNG.sync.read(bufA);
  const imgB = PNG.sync.read(bufB);

  const width = Math.max(imgA.width, imgB.width);
  const height = Math.max(imgA.height, imgB.height);

  const pad = (img) => {
    const out = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (width * y + x) << 2;
        out.data[idx] = 255;
        out.data[idx + 1] = 255;
        out.data[idx + 2] = 255;
        out.data[idx + 3] = 255;
      }
    }
    PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
    return out;
  };

  return { imgA: pad(imgA), imgB: pad(imgB), width, height };
}

/**
 * Writes highlight image (A + red diff overlay) and raw diff map for the report.
 */
async function createDiffHighlightImages(pathA, pathB, highlightOutPath, diffMapOutPath) {
  const { imgA, imgB, width, height } = await loadAlignedPngPair(pathA, pathB);

  const diff = new PNG({ width, height });
  const numDiffPixels = pixelmatch(imgA.data, imgB.data, diff.data, width, height, {
    threshold: 0.12,
    includeAA: false,
  });

  const highlight = new PNG({ width, height });
  PNG.bitblt(imgA, highlight, 0, 0, width, height, 0, 0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const dr = diff.data[i];
      const dg = diff.data[i + 1];
      const db = diff.data[i + 2];
      if (dr === 255 && dg === 0 && db === 0) {
        highlight.data[i] = 255;
        highlight.data[i + 1] = 60;
        highlight.data[i + 2] = 60;
        highlight.data[i + 3] = 255;
      }
    }
  }

  await fs.writeFile(diffMapOutPath, PNG.sync.write(diff));
  await fs.writeFile(highlightOutPath, PNG.sync.write(highlight));

  return { numDiffPixels, width, height };
}

function buildHtmlReport({
  results,
  perfect,
  changed,
  unclear,
  onlyInA,
  onlyInB,
  matchedCount,
  runId,
}) {
  const rows = results
    .map((r) => {
      let verdictClass = "unknown";
      if (r.verdict === "perfect") verdictClass = "ok";
      else if (r.verdict === "changes_visible") verdictClass = "warn";
      else if (r.verdict === "only_in_website_a" || r.verdict === "only_in_website_b") verdictClass = "only";

      const cellA = r.website_a_url
        ? `<a href="${escapeHtml(r.website_a_url)}" target="_blank" rel="noreferrer">A</a>`
        : "—";
      const cellB = r.website_b_url
        ? `<a href="${escapeHtml(r.website_b_url)}" target="_blank" rel="noreferrer">B</a>`
        : "—";

      const mainRow = `<tr>
<td>${escapeHtml(r.ai_provider)}</td>
<td>${escapeHtml(r.match_key)}</td>
<td>${cellA}</td>
<td>${cellB}</td>
<td class="${verdictClass}">${escapeHtml(r.verdict)}</td>
<td>${escapeHtml(r.human_visible_changes)}</td>
<td>${escapeHtml(r.confidence)}</td>
<td>${escapeHtml(r.summary)}</td>
</tr>`;

      if (r.verdict !== "changes_visible" || !(r.diff_highlight_src || r.diff_highlight_rel)) {
        return mainRow;
      }

      const srcA = imgSrcForRow(r, "screenshot_a_src", "screenshot_a_rel");
      const srcB = imgSrcForRow(r, "screenshot_b_src", "screenshot_b_rel");
      const srcDiff = imgSrcForRow(r, "diff_highlight_src", "diff_highlight_rel");

      const imgA = srcA
        ? `<figure><img src="${srcA}" alt="Website A" loading="lazy" /><figcaption>Website A</figcaption></figure>`
        : "";
      const imgB = srcB
        ? `<figure><img src="${srcB}" alt="Website B" loading="lazy" /><figcaption>Website B</figcaption></figure>`
        : "";
      const imgDiff = srcDiff
        ? `<figure class="diff-figure"><img src="${srcDiff}" alt="Highlighted differences" loading="lazy" /><figcaption>Highlighted differences (red)</figcaption></figure>`
        : "";
      const pixelNote =
        r.diff_pixel_count != null
          ? `<p class="diff-meta">~${Number(r.diff_pixel_count).toLocaleString()} differing pixels (automated overlay on Website A).</p>`
          : "";

      const galleryRow = `<tr class="diff-gallery-row">
<td colspan="8">
  <div class="diff-gallery">
    <p class="diff-title"><strong>Visual diff — ${escapeHtml(r.match_key)}</strong></p>
    ${pixelNote}
    <div class="diff-shots">${imgA}${imgB}${imgDiff}</div>
  </div>
</td>
</tr>`;

      return `${mainRow}\n${galleryRow}`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Visual Comparison Report ${escapeHtml(runId)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; color: #111; }
    h1 { margin-bottom: 8px; }
    .stats { margin-bottom: 16px; display: flex; gap: 16px; flex-wrap: wrap; }
    .card { padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; }
    table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f7f7f7; }
    .ok { color: #0a7a22; font-weight: 700; }
    .warn { color: #b35400; font-weight: 700; }
    .unknown { color: #6c6c6c; font-weight: 700; }
    .only { color: #1565c0; font-weight: 700; }
    .diff-gallery-row td { background: #fff8f0; padding: 16px; }
    .diff-gallery .diff-title { margin: 0 0 8px; }
    .diff-meta { margin: 0 0 12px; font-size: 13px; color: #555; }
    .diff-shots { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
    .diff-shots figure { margin: 0; max-width: 380px; }
    .diff-shots img { max-width: 100%; height: auto; border: 1px solid #ccc; border-radius: 4px; }
    .diff-shots figcaption { font-size: 12px; color: #444; margin-top: 6px; text-align: center; }
    .diff-figure img { border-color: #e53935; box-shadow: 0 0 0 2px rgba(229, 57, 53, 0.25); }
    .share-note { font-size: 13px; color: #555; margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>Website Visual Comparison Report</h1>
  <p>Run ID: <strong>${escapeHtml(runId)}</strong></p>
  <p class="share-note">Screenshots are embedded in this file — you can share this HTML alone; images do not depend on local folders.</p>
  <div class="stats">
    <div class="card">Perfect: <strong>${perfect}</strong></div>
    <div class="card">Visible changes: <strong>${changed}</strong></div>
    <div class="card">Unclear: <strong>${unclear}</strong></div>
    <div class="card">Matched pairs (AI) : <strong>${matchedCount}</strong></div>
    <div class="card">Only in Website A: <strong>${onlyInA.length}</strong></div>
    <div class="card">Only in Website B: <strong>${onlyInB.length}</strong></div>
  </div>
  <table>
    <thead>
      <tr>
        <th>AI</th>
        <th>Match key</th>
        <th>Website A</th>
        <th>Website B</th>
        <th>Verdict</th>
        <th>Human-visible changes</th>
        <th>Confidence</th>
        <th>Summary</th>
      </tr>
    </thead>
    <tbody>
${rows || "<tr><td colspan=\"8\">No matched hyperlinks found.</td></tr>"}
    </tbody>
  </table>
</body>
</html>`;
}

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const siteADir = path.join(process.cwd(), "screenshots", "site-a", runId);
  const siteBDir = path.join(process.cwd(), "screenshots", "site-b", runId);
  const reportDir = path.join(process.cwd(), "reports");
  const diffDir = path.join(reportDir, `diffs-${runId}`);
  const reportJsonFile = path.join(reportDir, `visual-report-${runId}.json`);
  const reportCsvFile = path.join(reportDir, `visual-report-${runId}.csv`);
  const reportHtmlFile = path.join(reportDir, `visual-report-${runId}.html`);

  await Promise.all([ensureDir(siteADir), ensureDir(siteBDir), ensureDir(reportDir), ensureDir(diffDir)]);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  try {
    console.log(
      `Using AI provider: ${aiProvider}${
        aiProvider === "openai" ? ` (model: ${OPENAI_MODEL})` : ""
      }`
    );
    if (aiProvider === "gemini") {
      console.log(`Gemini models (try in order): ${GEMINI_MODELS.join(", ")}`);
    }
    console.log(
      `Crawl: up to ${CRAWL_MAX_PAGES} unique page visit(s) per site to discover hyperlinks (set CRAWL_MAX_PAGES in .env for deeper sites).`
    );

    const linksA = await collectSameOriginLinksByCrawl(context, websiteA, CRAWL_MAX_PAGES);
    const linksB = await collectSameOriginLinksByCrawl(context, websiteB, CRAWL_MAX_PAGES);

    console.log(`Discovered ${linksA.length} unique same-origin URL(s) for Website A.`);
    console.log(`Discovered ${linksB.length} unique same-origin URL(s) for Website B.`);

    const mapA = buildLinkMap(linksA);
    const mapB = buildLinkMap(linksB);
    const commonKeys = Array.from(mapA.keys()).filter((key) => mapB.has(key));
    const limitedMatchedKeys = maxLinks > 0 ? commonKeys.slice(0, maxLinks) : commonKeys;
    const onlyInAKeys = Array.from(mapA.keys()).filter((key) => !mapB.has(key));
    const onlyInBKeys = Array.from(mapB.keys()).filter((key) => !mapA.has(key));

    console.log(
      `Matched by path+query: ${limitedMatchedKeys.length} pair(s) for AI comparison` +
        (maxLinks > 0
          ? ` (capped from ${commonKeys.length} total; raise max_links or unset for all).`
          : ` (${commonKeys.length} total).`)
    );
    console.log(
      `Unpaired URLs: ${onlyInAKeys.length} only on A, ${onlyInBKeys.length} only on B (screenshots + report, no AI compare).`
    );

    const results = [];

    for (const key of limitedMatchedKeys) {
      const linkA = mapA.get(key);
      const linkB = mapB.get(key);
      const fileName = linkToFileSlug(`matched_${key}_${runId}`);
      const shotA = path.join(siteADir, fileName);
      const shotB = path.join(siteBDir, fileName);

      console.log(`[pair] Capturing A: ${linkA}`);
      await takeScreenshot(context, linkA, shotA);

      console.log(`[pair] Capturing B: ${linkB}`);
      await takeScreenshot(context, linkB, shotB);

      let comparison;
      try {
        if (aiProvider === "gemini") {
          comparison = await compareWithGemini(
            shotA,
            shotB,
            `Website A URL: ${linkA}\nWebsite B URL: ${linkB}\nMatch key: ${key}`
          );
        } else {
          comparison = await compareWithOpenAI(
            shotA,
            shotB,
            `Website A URL: ${linkA}\nWebsite B URL: ${linkB}\nMatch key: ${key}`
          );
        }
      } catch (error) {
        comparison = {
          verdict: "unclear",
          human_visible_changes: true,
          confidence: 0,
          summary: `AI comparison failed: ${String(error?.message || error).slice(0, 180)}`,
        };
      }

      const row = {
        ai_provider: aiProvider,
        match_key: key,
        website_a_url: linkA,
        website_b_url: linkB,
        screenshot_a_path: shotA,
        screenshot_b_path: shotB,
        screenshot_a_rel: relPathForReport(reportDir, shotA),
        screenshot_b_rel: relPathForReport(reportDir, shotB),
        ...comparison,
      };

      if (comparison.verdict === "changes_visible") {
        const diffBase = linkToFileSlug(`diff_${key}_${runId}`).replace(/\.png$/, "");
        const highlightPath = path.join(diffDir, `${diffBase}-highlight.png`);
        const diffMapPath = path.join(diffDir, `${diffBase}-map.png`);
        try {
          const { numDiffPixels } = await createDiffHighlightImages(
            shotA,
            shotB,
            highlightPath,
            diffMapPath
          );
          row.diff_highlight_path = highlightPath;
          row.diff_highlight_rel = relPathForReport(reportDir, highlightPath);
          row.diff_map_rel = relPathForReport(reportDir, diffMapPath);
          row.diff_pixel_count = numDiffPixels;
          console.log(`[diff] Highlight saved for ${key} (${numDiffPixels} pixels)`);
        } catch (diffErr) {
          console.warn(`[diff] Could not build highlight for ${key}: ${diffErr.message}`);
        }
      }

      results.push(row);
    }

    for (const key of onlyInAKeys) {
      const linkA = mapA.get(key);
      const fileName = linkToFileSlug(`only-a_${key}_${runId}`);
      const shotA = path.join(siteADir, fileName);
      console.log(`[only A] Capturing: ${linkA}`);
      await takeScreenshot(context, linkA, shotA);
      results.push({
        ai_provider: aiProvider,
        match_key: key,
        website_a_url: linkA,
        website_b_url: null,
        verdict: "only_in_website_a",
        human_visible_changes: "",
        confidence: "",
        summary:
          "No page on website B with the same path and query; screenshot saved for A only. Not a two-image AI comparison.",
      });
    }

    for (const key of onlyInBKeys) {
      const linkB = mapB.get(key);
      const fileName = linkToFileSlug(`only-b_${key}_${runId}`);
      const shotB = path.join(siteBDir, fileName);
      console.log(`[only B] Capturing: ${linkB}`);
      await takeScreenshot(context, linkB, shotB);
      results.push({
        ai_provider: aiProvider,
        match_key: key,
        website_a_url: null,
        website_b_url: linkB,
        verdict: "only_in_website_b",
        human_visible_changes: "",
        confidence: "",
        summary:
          "No page on website A with the same path and query; screenshot saved for B only. Not a two-image AI comparison.",
      });
    }

    const perfect = results.filter((r) => r.verdict === "perfect").length;
    const changed = results.filter((r) => r.verdict === "changes_visible").length;
    const unclear = results.filter((r) => r.verdict === "unclear").length;
    const onlyARows = results.filter((r) => r.verdict === "only_in_website_a").length;
    const onlyBRows = results.filter((r) => r.verdict === "only_in_website_b").length;
    const csvContent = buildCsv(results);
    console.log("Embedding screenshots into HTML report (shareable single file)...");
    const htmlResults = await prepareResultsForHtml(results);
    const htmlContent = buildHtmlReport({
      results: htmlResults,
      perfect,
      changed,
      unclear,
      onlyInA: onlyInAKeys,
      onlyInB: onlyInBKeys,
      matchedCount: limitedMatchedKeys.length,
      runId,
    });

    const jsonForDisk = results.map(({ screenshot_a_src, screenshot_b_src, diff_highlight_src, ...rest }) => rest);

    await Promise.all([
      fs.writeFile(reportJsonFile, JSON.stringify(jsonForDisk, null, 2), "utf8"),
      fs.writeFile(reportCsvFile, csvContent, "utf8"),
      fs.writeFile(reportHtmlFile, htmlContent, "utf8"),
    ]);

    console.log("\nWebsite-to-website visual comparison finished.");
    console.log(`AI compared pairs         : ${limitedMatchedKeys.length}`);
    console.log(`Perfect (AI)              : ${perfect}`);
    console.log(`Visible changes (AI)      : ${changed}`);
    console.log(`Unclear (AI)              : ${unclear}`);
    console.log(`Only on A (screenshot)    : ${onlyARows}`);
    console.log(`Only on B (screenshot)    : ${onlyBRows}`);
    console.log(`JSON report               : ${reportJsonFile}`);
    console.log(`CSV report                : ${reportCsvFile}`);
    console.log(`HTML report               : ${reportHtmlFile}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
