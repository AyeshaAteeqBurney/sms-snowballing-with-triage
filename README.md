# SMS snowball · OpenAlex + AI triage

Local web UI for **backward + forward citation snowballing** using the [OpenAlex API](https://openalex.org), with **advisory** screening hints via **Google Gemini** ([AI Studio free tier](https://aistudio.google.com/apikey)) or **Anthropic Claude** (not inclusion decisions).

## Requirements

- Node.js 18+
- Network access to `api.openalex.org`, and if you use triage: `generativelanguage.googleapis.com` (Gemini) and/or `api.anthropic.com` (Claude)

## Run

```bash
cd sms-snowballing-with-triage
npm install
npm start
```

Open **http://localhost:3847** (or the port printed in the terminal).

## What to enter

1. **Seeds:** DOIs (`10.x/…`), OpenAlex ids (`W123…`), or `openalex.org/…` URLs — one per line.
2. **Polite pool email:** recommended by OpenAlex (`mailto` query on every request).
3. **Rounds / caps:** max expansion rounds after seeds; per-parent limits on backward references and forward citations to control volume.

Export **CSV** from the UI after snowball (and again after triage for AI columns).

## AI triage

Paste your topic and IC/EC / RQ text. Choose **Google Gemini** (default) or **Anthropic Claude**. For Gemini, create a free API key in [Google AI Studio](https://aistudio.google.com/apikey) and paste it in the UI. The key is sent to **your local server only** for that request and is not stored by this app. Respect Google’s and Anthropic’s rate limits and terms.

**Gemini “quota exceeded” / `limit: 0`:** Prefer **Gemini 2.5 Flash** or **Flash-Lite** in the model menu; some projects see no free quota on **2.0 Flash**. The server **retries** rate limits automatically and spaces requests. If limits stay at zero, check [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) and your Cloud project / billing settings (Google often requires a linked billing account to unlock non-zero free-tier quotas even when usage stays within the free allowance).

## Method notes

- Snowballing produces **candidate** works for manual title/abstract/full-text screening.
- Document in your SMS protocol: databases used for seeds, snowball rounds, caps, OpenAlex retrieval date, and that AI outputs are advisory.

## Troubleshooting “only 1 work” after snowball

After each run, the UI shows **OpenAlex graph (seed)** and **Expansion run** counts. If **references in payload** and **incoming citations** are both `0` in OpenAlex, no neighbors can be added. If those counts are healthy but **new unique** stays `0`, check the expansion line for **API issues**, lower caps rarely—more often it is **network/API errors** (now surfaced in the audit).

**DOI quirk:** For the same DOI, OpenAlex can return a **sparse stub** (0 refs / 0 cites) on a simple `filter=doi:` list request, while the canonical work at `https://doi.org/…` is full. This app now resolves DOIs by **richest** match: `GET /works/{encodeURIComponent('https://doi.org/…')}` first, then the best of up to 100 `filter=doi:` results, so the seed should match what you see on [openalex.org](https://openalex.org) for that DOI.
