import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import { runSnowball } from "./src/snowball.js";
import {
  triageRowsWithAnthropic,
  triageRowsWithGemini,
} from "./src/triage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json({ limit: "15mb" }));

app.use(express.static(path.join(__dirname, "public")));

function parseSeedText(text) {
  return text
    .split(/[\r\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

app.post("/api/snowball", async (req, res) => {
  try {
    const {
      seedsText,
      maxRounds = 2,
      maxBackwardPerWork = 40,
      maxForwardPerWork = 60,
      mailto = "",
    } = req.body || {};

    const seedLines = parseSeedText(String(seedsText || ""));
    if (seedLines.length === 0) {
      return res.status(400).json({ error: "Add at least one DOI or OpenAlex ID." });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45 * 60 * 1000);

    const result = await runSnowball({
      seedLines,
      maxRounds: Math.min(10, Math.max(1, Number(maxRounds) || 2)),
      maxBackwardPerWork: Math.min(500, Math.max(1, Number(maxBackwardPerWork) || 40)),
      maxForwardPerWork: Math.min(500, Math.max(1, Number(maxForwardPerWork) || 60)),
      mailto: String(mailto || "").trim(),
      signal: controller.signal,
      onProgress: (ev) => {
        /* optional: could stream SSE later */
      },
    });

    clearTimeout(timeout);

    res.json({
      ok: true,
      rows: result.rows,
      audit: result.audit,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: e.message || String(e),
    });
  }
});

app.post("/api/triage", async (req, res) => {
  try {
    const body = req.body || {};
    const {
      rows,
      criteriaText,
      provider: providerRaw,
      apiKey,
      anthropicApiKey,
      geminiApiKey,
      model,
    } = body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows to triage." });
    }

    const anthLegacy = String(anthropicApiKey || "").trim();
    const gemLegacy = String(geminiApiKey || "").trim();
    const genericKey = String(apiKey || "").trim();

    let provider = String(providerRaw || "").toLowerCase().trim();
    if (!provider) {
      provider = anthLegacy ? "anthropic" : "gemini";
    }

    let enriched;
    if (provider === "gemini") {
      const key = gemLegacy || genericKey;
      enriched = await triageRowsWithGemini(rows, {
        criteriaText: String(criteriaText || ""),
        geminiApiKey: key,
        model: model || "gemini-2.5-flash",
      });
    } else if (provider === "anthropic") {
      const key = anthLegacy || genericKey;
      enriched = await triageRowsWithAnthropic(rows, {
        criteriaText: String(criteriaText || ""),
        anthropicApiKey: key,
        model: model || "claude-sonnet-4-20250514",
      });
    } else {
      return res.status(400).json({
        error: 'provider must be "gemini" or "anthropic".',
      });
    }

    res.json({ ok: true, rows: enriched });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`SMS snowball UI: http://localhost:${PORT}`);
});
