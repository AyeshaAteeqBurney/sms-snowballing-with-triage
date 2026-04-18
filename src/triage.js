/**
 * Advisory-only LLM triage for screening prep (not inclusion decisions).
 * Supports Anthropic Messages API or Google Gemini (AI Studio free tier).
 */

export const TRIAGE_PROMPT_VERSION = "triage-v1";

function compactRow(r) {
  return {
    openalex_id: r.openalex_id,
    doi: r.doi ?? "",
    title: r.title ?? "",
    year: r.year ?? "",
    direction: r.direction ?? "",
    discovered_round: r.discovered_round ?? "",
  };
}

function buildUserPrompt(criteriaText, payload) {
  return [
    "## Screening context (candidate must be assessed by a human afterwards)\n\n",
    criteriaText.trim(),
    "\n\n## Papers (metadata only)\n\n",
    JSON.stringify(payload, null, 2),
    '\n\nReturn JSON only: array of objects, one per paper in the SAME ORDER as input.',
    'Each object keys: openalex_id (string), relevance_likelihood ("low"|"medium"|"high"), screening_hint (2-4 short sentences), verify_in_pdf (bullet list string or empty), uncertainty ("low"|"medium"|"high", e.g. high when abstract unknown).',
    "Rules: advisory only; never claim include/exclude; flag when title alone is insufficient.",
  ].join("");
}

const SYSTEM_TEXT = [
  "You assist systematic mapping / literature screening preparation.",
  "Outputs are hints for human screeners—not decisions.",
  "Never output words like included, excluded, rejected, accepted as final judgments.",
  "Respond with JSON array only. No markdown fences.",
].join(" ");

function mergeSliceResults(slice, parsed, model, aiProvider) {
  const enriched = [];
  for (let j = 0; j < slice.length; j += 1) {
    const row = slice[j];
    const t = parsed[j] || {};
    enriched.push({
      ...row,
      ai_relevance_likelihood: t.relevance_likelihood ?? "",
      ai_screening_hint: t.screening_hint ?? "",
      ai_verify_in_pdf: t.verify_in_pdf ?? "",
      ai_uncertainty: t.uncertainty ?? "",
      ai_model: model,
      ai_provider: aiProvider,
      ai_prompt_version: TRIAGE_PROMPT_VERSION,
    });
  }
  return enriched;
}

function parseJsonArrayFromModelText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\[[\s\S]*\]/);
    if (m) parsed = JSON.parse(m[0]);
    else throw new Error("Could not parse triage JSON from model.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Triage model output must be a JSON array.");
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses "Please retry in 38.07s" from Gemini error messages. */
function parseRetryDelayMsFromMessage(message) {
  if (!message) return null;
  const m = String(message).match(/retry in\s+([\d.]+)\s*s/i);
  if (!m) return null;
  return Math.ceil(Number(m[1]) * 1000);
}

/**
 * Calls generateContent with retries on 429 / quota / rate limit.
 */
async function fetchGeminiGenerateContent(url, body, signal) {
  const maxAttempts = 8;
  let lastText = "";

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    lastText = raw;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      if (!res.ok && attempt < maxAttempts - 1) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new Error(`Gemini error (non-JSON): ${raw.slice(0, 400)}`);
    }

    if (res.ok) {
      return data;
    }

    const msg = data.error?.message || data.message || raw;
    const retryable =
      res.status === 429 ||
      /quota|rate|ResourceExhausted|exceeded|try again later/i.test(msg);

    if (!retryable || attempt === maxAttempts - 1) {
      let hint = "";
      if (/limit:\s*0/i.test(msg)) {
        hint =
          " Try model Gemini 2.5 Flash or Flash-Lite in the UI, or check Google AI billing / quota (free tier often needs a linked billing account for non-zero limits).";
      }
      throw new Error(msg + hint);
    }

    const retryAfterHdr = res.headers.get("retry-after");
    let waitMs =
      parseRetryDelayMsFromMessage(msg) ??
      (retryAfterHdr && /^\d+$/.test(retryAfterHdr.trim())
        ? Number(retryAfterHdr) * 1000
        : null) ??
      Math.min(90_000, 3000 * 2 ** attempt);

    waitMs = Math.min(120_000, Math.max(1500, waitMs));
    await sleep(waitMs);
  }

  throw new Error(lastText.slice(0, 500));
}

/**
 * Score a batch of papers against free-text inclusion context.
 */
export async function triageRowsWithAnthropic(rows, options) {
  const {
    criteriaText,
    anthropicApiKey,
    model = "claude-sonnet-4-20250514",
    signal,
  } = options;

  if (!anthropicApiKey?.trim()) {
    throw new Error("Missing anthropic_api_key for triage.");
  }
  if (!criteriaText?.trim()) {
    throw new Error("Paste your topic / IC / EC / RQ text for triage.");
  }

  const BATCH = 12;
  const enriched = [];

  for (let i = 0; i < rows.length; i += BATCH) {
    if (signal?.aborted) break;
    const slice = rows.slice(i, i + BATCH);
    const payload = slice.map(compactRow);

    const userContent = buildUserPrompt(criteriaText, payload);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicApiKey.trim(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM_TEXT,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Anthropic error (non-JSON): ${raw.slice(0, 400)}`);
    }

    if (!res.ok) {
      throw new Error(data.error?.message || raw.slice(0, 400));
    }

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const parsed = parseJsonArrayFromModelText(text);
    enriched.push(...mergeSliceResults(slice, parsed, model, "anthropic"));
  }

  return enriched;
}

/**
 * Google Gemini via Generative Language API (free tier key from AI Studio).
 * @see https://aistudio.google.com/apikey
 */
export async function triageRowsWithGemini(rows, options) {
  const {
    criteriaText,
    geminiApiKey,
    model = "gemini-2.5-flash",
    signal,
  } = options;

  if (!geminiApiKey?.trim()) {
    throw new Error("Missing Google AI Studio API key for Gemini triage.");
  }
  if (!criteriaText?.trim()) {
    throw new Error("Paste your topic / IC / EC / RQ text for triage.");
  }

  /** Smaller batches + gap between calls help stay under free-tier RPM/TPM. */
  const BATCH = 6;
  const pauseMsBetweenOkBatches = 2200;
  const enriched = [];

  for (let i = 0; i < rows.length; i += BATCH) {
    if (signal?.aborted) break;
    const slice = rows.slice(i, i + BATCH);
    const payload = slice.map(compactRow);
    const userContent = buildUserPrompt(criteriaText, payload);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(geminiApiKey.trim())}`;

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_TEXT }] },
      contents: [
        {
          role: "user",
          parts: [{ text: userContent }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,
      },
    };

    const data = await fetchGeminiGenerateContent(url, body, signal);

    const cand = data.candidates?.[0];
    const text =
      cand?.content?.parts?.map((p) => p.text || "").join("") || "";

    if (!text.trim()) {
      const reason =
        cand?.finishReason ||
        data.promptFeedback?.blockReason ||
        "empty";
      throw new Error(
        `Gemini returned no text (finish: ${reason}). Retry or shorten the batch.`
      );
    }

    const parsed = parseJsonArrayFromModelText(text.trim());
    enriched.push(...mergeSliceResults(slice, parsed, model, "gemini"));

    if (i + BATCH < rows.length) {
      await sleep(pauseMsBetweenOkBatches);
    }
  }

  return enriched;
}
