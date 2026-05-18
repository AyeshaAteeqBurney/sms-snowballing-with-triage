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
npm install   # also runs prepare → installs git pre-commit hook
npm start
```

Open **http://localhost:3847** (or the port printed in the terminal).

### Security before commit

- **Git hook:** `npm install` sets `core.hooksPath` to `.githooks` and runs automated checks on staged files (secrets, API key patterns, `.env`, etc.). Re-install anytime: `npm run install-hooks`.
- **Cursor:** Rule `.cursor/rules/pre-commit-security.mdc` and subagent `.cursor/agents/security-reviewer.md` — ask **@security-reviewer** before commit for a full diff review; Critical findings should be fixed first.

## What to enter

### Bibliography CSV → snowball + merge

Choose a CSV from your own search (e.g. deduplicated **Scopus** / **IEEE** export), set **round/cap** values, then click **Start import & snowball**. **Title** must be present. **Only the first 50 data rows** are processed per run (larger files are truncated with a warning). **DOI** and/or OpenAlex **W…** ids become **snowball seeds**—but only the **first 12 unique** identifiers are expanded (order follows the CSV); the rest are skipped for API cost, while **all** CSV rows are still merged into the table where they do not overlap the graph. OpenAlex is called with your **round/cap** settings. Matching works can get **abstracts** copied from your CSV when OpenAlex has none.

If the file has **no** extractable identifiers, snowball is skipped and you keep CSV-only rows (add DOIs or OpenAlex ids and re-upload to expand).

Export **CSV** from the UI after the run (and again after triage for AI columns).

## CSV column reference

Both exports are plain CSV (comma-separated). Column order can vary slightly because headers are built from all keys present in the table; the columns below are what you get from a typical snowball + triage run.

**Excel note:** Cells in `ai_verify_in_pdf` that start with `-` (bullet lines) may show `#NAME?` in Excel. The file is fine—open in a text editor, or import the column as **Text**. A future app version may prefix those cells for Excel safety.

### Snowball export (`snowball_YYYY-MM-DD.csv`)

Downloaded with **Download snowball CSV** after import/snowball. One row per candidate work (seeds, snowballed neighbors, and CSV-only imports merged in).

| Column | Meaning | Example |
|--------|---------|---------|
| `openalex_id` | OpenAlex work id (`W…`), or a synthetic id when OpenAlex has no record (`doi:…`, `import:N`). | `W4291910381` |
| `doi` | DOI link or identifier when known (often a full `https://doi.org/…` URL in exports). | `https://doi.org/10.1109/access.2022.3198956` |
| `title` | Work title from OpenAlex or your uploaded CSV. | `Blockchain and Machine Learning for Fraud Detection: A Privacy-Preserving…` |
| `year` | Publication year. | `2022` |
| `cited_by_count` | OpenAlex citation count at fetch time (may be `0` for very new works). | `70` |
| `landing_url` | Publisher / landing page URL when OpenAlex provides one. | `https://doi.org/10.1109/access.2022.3198956` |
| `oa_url` | Open-access PDF or repository URL when available; empty if none. | `https://arxiv.org/pdf/1801.10408` |
| `direction` | How the row entered the corpus: `seed` (starting point), `backward` (reference of a parent), `forward` (cites a parent), or `upload` (CSV row without snowball expansion). | `seed` · `forward` |
| `parent_openalex_id` | OpenAlex id of the work that led to this row during snowballing; empty for seeds and CSV-only uploads. | `` (seed) · `W1565048244` (found while expanding that seed) |
| `discovered_round` | Snowball round when the work was first added: `0` = seed or import, `1` = first expansion round, etc. | `0` · `1` |

Example rows (abbreviated):

```csv
openalex_id,doi,title,year,...,direction,parent_openalex_id,discovered_round
W4291910381,https://doi.org/10.1109/access.2022.3198956,Blockchain and Machine Learning for Fraud Detection...,2022,...,seed,,0
W4296978576,https://doi.org/10.1145/3173574.3173951,'It's Reducing a Human Being to a Percentage',2018,...,forward,W1565048244,1
```

Optional columns (only if present in your table, e.g. abstract copied from your bibliography CSV): `abstract`.

### Triage export (`triage_accum_YYYY-MM-DD.csv`)

Downloaded with **Download triage CSV (accumulated)**. Contains **all snowball columns** for each triaged row, plus **advisory AI fields** from Gemini or Claude. Triage is **not** an inclusion decision—use these columns to prioritize manual screening.

| Column | Meaning | Example |
|--------|---------|---------|
| *(snowball columns)* | Same as snowball export above (`openalex_id` through `discovered_round`). | `W4289655771`, `seed`, `0`, … |
| `ai_relevance_likelihood` | Model’s advisory fit to your pasted criteria: `low`, `medium`, or `high`. | `high` · `low` |
| `ai_screening_hint` | Short explanation of that relevance band based on **metadata only** (title, optional abstract snippet)—not a final include/exclude. | `The title explicitly mentions 'Blockchain' and 'Privacy-Preserving'…` |
| `ai_verify_in_pdf` | Checklist for **you** when reading the full paper; empty if the model did not need extra checks. Not text from a PDF the model read. | *(empty)* · `- Check abstract for any mention of blockchain or DLT.` |
| `ai_uncertainty` | How unsure the model is: `low`, `medium`, or `high` (often higher when only the title was available). | `low` · `high` |
| `ai_model` | Model id used for that batch. | `gemini-2.5-flash` |
| `ai_provider` | API provider. | `gemini` |
| `ai_prompt_version` | Prompt/schema version tag for reproducibility in your protocol. | `triage-v1` |

Example rows (abbreviated):

```csv
...,ai_relevance_likelihood,ai_screening_hint,ai_verify_in_pdf,ai_uncertainty,ai_model,...
...,high,The title explicitly mentions 'Blockchain' and 'Privacy-Preserving'…,,low,gemini-2.5-flash,...
...,low,"The title mentions 'Credit Scoring…over Encrypted Data,' which hints at privacy/security…",- Check abstract for any mention of blockchain or DLT.,medium,gemini-2.5-flash,...
...,low,"The title ''It's Reducing a Human Being to a Percentage''' is highly generic…","- Check abstract for any mention of blockchain, security, or privacy.",high,gemini-2.5-flash,...
```

Rows appear in the accumulated file after each **Run triage on batch**; re-running a batch updates the same logical paper (matched by `openalex_id` / DOI / title) in the export.

## AI triage

Paste your topic and IC/EC / RQ text. Choose **Google Gemini** (default) or **Anthropic Claude**. For Gemini, create a free API key in [Google AI Studio](https://aistudio.google.com/apikey) and paste it in the UI. The key is sent to **your local server only** (`127.0.0.1`) for that request, is **not saved** to disk or `localStorage`, and is **cleared from the form** after a successful screening run. The field is masked but **not** a browser password field—if Chrome still offers **Save password?**, choose **Never** (it is an API token). While a batch is running, the key can still appear in **DevTools → Network**—use a scoped/revocable key and avoid screen-sharing during triage. Respect Google’s and Anthropic’s rate limits and terms.

**Gemini “quota exceeded” / `limit: 0`:** Prefer **Gemini 2.5 Flash** or **Flash-Lite** in the model menu; some projects see no free quota on **2.0 Flash**. The server **retries** rate limits automatically and spaces requests. If limits stay at zero, check [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) and your Cloud project / billing settings (Google often requires a linked billing account to unlock non-zero free-tier quotas even when usage stays within the free allowance).

## Method notes

- Snowballing produces **candidate** works for manual title/abstract/full-text screening.
- Document in your SMS protocol: databases used for seeds, snowball rounds, caps, OpenAlex retrieval date, and that AI outputs are advisory.

## Performance note

Snowball talks to OpenAlex many times **per seed** (expand backward references and forward cites). Using **dozens** of seeds from a long CSV multiplies runtime; this app caps **snowball seeds at 12** unique DOI/OpenAlex ids per run. Runs can still take **several minutes**. The code uses **parallel batched HTTP** for referenced-work lookups and parallel seed resolution; if OpenAlex returns **429** errors, reduce **max rounds** / caps or try again later.

## Troubleshooting “only 1 work” after snowball

After each run, the UI shows **OpenAlex graph (seed)** and **Expansion run** counts. If **references in payload** and **incoming citations** are both `0` in OpenAlex, no neighbors can be added. If those counts are healthy but **new unique** stays `0`, check the expansion line for **API issues**, lower caps rarely—more often it is **network/API errors** (now surfaced in the audit).

**DOI quirk:** For the same DOI, OpenAlex can return a **sparse stub** (0 refs / 0 cites) on a simple `filter=doi:` list request, while the canonical work at `https://doi.org/…` is full. This app now resolves DOIs by **richest** match: `GET /works/{encodeURIComponent('https://doi.org/…')}` first, then the best of up to 100 `filter=doi:` results, so the seed should match what you see on [openalex.org](https://openalex.org) for that DOI.
