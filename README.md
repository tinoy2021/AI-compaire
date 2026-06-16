# Two-Website Hyperlink Screenshot Comparison (Playwright + AI)

This project discovers same-origin hyperlinks on each site (optional crawl), captures a screenshot for **every** discovered URL, runs AI comparison on **matched** path+query pairs, and reports URLs that exist on only one site.

The AI returns:
- `perfect` -> screenshot looks the same to human eye
- `changes_visible` -> human-visible differences detected

## Setup

1. Install dependencies:
   - `npm install`
2. Install Playwright browser:
   - `npx playwright install chromium`
3. Configure API keys in `.env` (see `.env.example`):
   - **Gemini:** `GEMINI_API_KEY=...` (or `GOOGLE_API_KEY`)
   - **OpenAI:** `OPENAI_MODEL=gpt-4o-mini` (optional) and `OPENAI_API_KEY=sk-...`
   - If both keys are set, the tool defaults to **Gemini** unless you set `AI_PROVIDER=openai`.
4. Optional — discover **more hyperlinks** on each site (same-origin crawl):
   - `CRAWL_MAX_PAGES=50` visits up to 50 unique pages per site (BFS from the start URL) and unions every `<a href>` found. Default is `1` (only the URL you pass for that site).

## Run

- Compare Website A vs Website B:
  - `npm run compare -- https://site-a.com https://site-b.com`
- Limit **AI comparisons** to the first N **matched** path+query pairs (unpaired URLs are still all captured):
  - `npm run compare -- https://site-a.com https://site-b.com 10`

## How it works

1. Opens Website A and Website B (and optionally crawls same-origin pages up to `CRAWL_MAX_PAGES` per site).
2. Collects all same-origin `<a href>` links discovered on those visits.
3. **Matched** URLs (same path + query on both sites): full-page screenshots on A and B, then Gemini/OpenAI compares the pair.
4. **Only on A** or **only on B**: still takes a screenshot for that site and records `only_in_website_a` / `only_in_website_b` (no two-image AI compare).
5. Generates JSON, CSV, and HTML reports under `reports/`.

## Output folders

- Website A screenshots: `screenshots/site-a/<timestamp>/`
- Website B screenshots: `screenshots/site-b/<timestamp>/`
- JSON report: `reports/visual-report-<timestamp>.json`
- CSV report: `reports/visual-report-<timestamp>.csv`
- HTML dashboard: `reports/visual-report-<timestamp>.html` — **self-contained** (images embedded as base64; safe to email or share as one file). For **`changes_visible`**, includes Website A/B thumbnails and a **red-highlighted diff** image.
- Diff images: `reports/diffs-<timestamp>/` (`*-highlight.png` overlay, `*-map.png` raw diff)

## Notes

- This is direct site-to-site comparison (no baseline creation needed).
- Every discovered URL gets a screenshot on its site; matched pairs additionally get an AI verdict (`perfect` / `changes_visible` / `unclear`).
- Comparison quality depends on screenshot stability (ads, dynamic banners, popups may create visible differences).

## Choosing Gemini vs OpenAI

| Env | Meaning |
| --- | ------- |
| `AI_PROVIDER=gemini` | Use Gemini (needs `GEMINI_API_KEY` or `GOOGLE_API_KEY`) |
| `AI_PROVIDER=openai` | Use OpenAI (needs `OPENAI_API_KEY`) |
| `GEMINI_MODEL` | Single Gemini model id (e.g. `gemini-2.5-pro` for premium) |
| `GEMINI_MODELS` | Comma-separated list, tried in order (overrides default Pro → Flash fallbacks) |
| (omit `AI_PROVIDER` when only one key is set) | Uses whichever key you provided |

Default when using Gemini: **`gemini-2.5-pro`**, then **`gemini-2.5-flash`**, **`gemini-2.0-flash`**, **`gemini-1.5-flash`**. (`gemini-1.5-pro` is omitted — it often returns 404 on the current AI Studio API.) Override with `GEMINI_MODEL` or `GEMINI_MODELS` — see [Gemini models](https://ai.google.dev/gemini-api/docs/models/gemini).
