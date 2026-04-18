# SMS snowball · OpenAlex + AI triage

Local web UI for **backward + forward citation snowballing** using the [OpenAlex API](https://openalex.org), with **advisory** screening hints via **Google Gemini** ([AI Studio free tier](https://aistudio.google.com/apikey)) or **Anthropic Claude** (not inclusion decisions).

## Requirements

- Node.js 18+
- **Snowball:** network access to `api.openalex.org`
- **Triage:** `generativelanguage.googleapis.com` (Gemini) and/or `api.anthropic.com` (Claude)
- **CSV upload:** seeds snowball via OpenAlex when DOIs or OpenAlex ids exist in the file; otherwise CSV-only rows until you add identifiers

## Run

```bash
cd sms-snowballing-with-triage
npm install
npm start
```

Open **http://localhost:3847** (or the port printed in the terminal).

## What to enter

### Bibliography CSV → snowball + merge

Choose a CSV from your own search (e.g. deduplicated **Scopus** / **IEEE** export), set **round/cap** values, then click **Start import & snowball**. **Title** must be present. **Only the first 50 data rows** are processed per run (larger files are truncated with a warning). **DOI** and/or OpenAlex **W…** ids become **snowball seeds**—but only the **first 12 unique** identifiers are expanded (order follows the CSV); the rest are skipped for API cost, while **all** CSV rows are still merged into the table where they do not overlap the graph. OpenAlex is called with your **round/cap** settings. Matching works can get **abstracts** copied from your CSV when OpenAlex has none.

If the file has **no** extractable identifiers, snowball is skipped and you keep CSV-only rows (add DOIs or OpenAlex ids and re-upload to expand).

Export **CSV** from the UI after the run (and again after triage for AI columns).

## AI triage

Paste your topic and IC/EC / RQ text. Choose **Google Gemini** (default) or **Anthropic Claude**. For Gemini, create a free API key in [Google AI Studio](https://aistudio.google.com/apikey) and paste it in the UI. The key is sent to **your local server only** for that request and is not stored by this app. Respect Google’s and Anthropic’s rate limits and terms.

**Gemini “quota exceeded” / `limit: 0`:** Prefer **Gemini 2.5 Flash** or **Flash-Lite** in the model menu; some projects see no free quota on **2.0 Flash**. The server **retries** rate limits automatically and spaces requests. If limits stay at zero, check [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) and your Cloud project / billing settings (Google often requires a linked billing account to unlock non-zero free-tier quotas even when usage stays within the free allowance).

## Method notes

- Snowballing produces **candidate** works for manual title/abstract/full-text screening.
- Document in your SMS protocol: databases used for seeds, snowball rounds, caps, OpenAlex retrieval date, and that AI outputs are advisory.

## Performance note

Snowball talks to OpenAlex many times **per seed** (expand backward references and forward cites). Using **dozens** of seeds from a long CSV multiplies runtime; this app caps **snowball seeds at 12** unique DOI/OpenAlex ids per run. Runs can still take **several minutes**. The code uses **parallel batched HTTP** for referenced-work lookups and parallel seed resolution; if OpenAlex returns **429** errors, reduce **max rounds** / caps or try again later.

## Troubleshooting “only 1 work” after snowball

After each run, the UI shows **OpenAlex graph (seed)** and **Expansion run** counts. If **references in payload** and **incoming citations** are both `0` in OpenAlex, no neighbors can be added. If those counts are healthy but **new unique** stays `0`, check the expansion line for **API issues**, lower caps rarely—more often it is **network/API errors** (now surfaced in the audit).

**DOI quirk:** For the same DOI, OpenAlex can return a **sparse stub** (0 refs / 0 cites) on a simple `filter=doi:` list request, while the canonical work at `https://doi.org/…` is full. This app now resolves DOIs by **richest** match: `GET /works/{encodeURIComponent('https://doi.org/…')}` first, then the best of up to 100 `filter=doi:` results, so the seed should match what you see on [openalex.org](https://openalex.org) for that DOI.
