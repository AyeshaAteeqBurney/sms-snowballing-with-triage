import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import { runSnowball } from "./src/snowball.js";
import { parseCsv } from "./src/parseCsv.js";
import { applyCsvRowCap, applySnowballSeedCap } from "./src/csvLimits.js";
import {
  enrichSnowRowsWithCsvAbstracts,
  extractSeedLinesFromImportedRows,
  mergeSnowballWithOrphanImports,
  rowsFromBibliographyCsv,
} from "./src/importBibliographyCsv.js";
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

function logSnowballProgress(ev) {
  const p = ev?.phase;
  if (
    p === "resolve_seeds_start" ||
    p === "snowball_rounds_start" ||
    p === "round_start" ||
    p === "round_done"
  ) {
    console.log("[snowball]", p, ev.round ?? "", ev.frontierSize ?? ev.nextFrontier ?? "");
  }
  if (p === "round_expand_progress") {
    const tot = Number(ev.total) || 0;
    const done = Number(ev.completed) || 0;
    const step = Math.max(5, Math.ceil(tot / 25));
    if (tot && (done === 1 || done === tot || done % step === 0)) {
      console.log("[snowball]", "expand", ev.round ?? "", `${done}/${tot}`);
    }
  }
}

app.post("/api/import-csv-snowball", async (req, res) => {
  try {
    const {
      csvText,
      filename = "",
      mailto = "",
      maxRounds = 2,
      maxBackwardPerWork = 40,
      maxForwardPerWork = 60,
    } = req.body || {};

    const text = String(csvText || "");
    if (!text.trim()) {
      return res.status(400).json({ error: "No CSV text. Choose a .csv file." });
    }

    let { headers, records } = parseCsv(text);
    if (!headers.length) {
      return res.status(400).json({ error: "Could not read CSV headers (empty file?)." });
    }

    const capped = applyCsvRowCap(records);
    records = capped.records;
    const csvRowCap = capped.cap;

    const safeName = String(filename || "upload.csv")
      .replace(/[/\\?%*:|"<>]/g, "_")
      .slice(0, 200);

    const importedRows = rowsFromBibliographyCsv(records, headers, safeName);
    if (importedRows.length === 0) {
      return res.status(400).json({
        error: "No data rows with a non-empty title. Check the file and title column mapping.",
      });
    }

    let seedLines = extractSeedLinesFromImportedRows(importedRows);
    if (seedLines.length === 0) {
      return res.json({
        ok: true,
        rows: importedRows,
        audit: {
          source: "csv_import",
          snowballSkipped: true,
          filename: safeName,
          columnCount: headers.length,
          rowCount: importedRows.length,
          csvRowCap,
          reason:
            "No DOI or OpenAlex W… id in any row—cannot run snowball. Add identifiers to the CSV and re-upload.",
        },
      });
    }

    const seedCapped = applySnowballSeedCap(seedLines);
    seedLines = seedCapped.seedLines;
    const seedCap = seedCapped.seedCap;

    const maxRoundsClamped = Math.min(10, Math.max(1, Number(maxRounds) || 2));

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45 * 60 * 1000);

    const onProgress = (ev) => {
      try {
        res.write(`${JSON.stringify({ progress: ev })}\n`);
      } catch (_) {
        /* client disconnected */
      }
      logSnowballProgress(ev);
    };

    try {
      const result = await runSnowball({
        seedLines,
        maxRounds: maxRoundsClamped,
        maxBackwardPerWork: Math.min(500, Math.max(1, Number(maxBackwardPerWork) || 40)),
        maxForwardPerWork: Math.min(500, Math.max(1, Number(maxForwardPerWork) || 60)),
        mailto: String(mailto || "").trim(),
        signal: controller.signal,
        onProgress,
      });

      clearTimeout(timeout);

      let enriched = enrichSnowRowsWithCsvAbstracts(result.rows, importedRows);
      const merged = mergeSnowballWithOrphanImports(enriched, importedRows);

      res.write(
        `${JSON.stringify({
          result: {
            ok: true,
            rows: merged,
            audit: {
              ...result.audit,
              csvSnowball: {
                filename: safeName,
                csvRowCount: importedRows.length,
                seedLinesUsed: seedLines.length,
                seedLinesTotalUnique: seedCap.totalUnique,
                seedCap,
                snowballWorks: result.rows.length,
                orphansMerged: merged.length - result.rows.length,
                totalAfterMerge: merged.length,
              },
              csvRowCap,
            },
          },
        })}\n`
      );
      res.end();
    } catch (snowErr) {
      clearTimeout(timeout);
      console.error(snowErr);
      try {
        res.write(
          `${JSON.stringify({
            error: snowErr.message || String(snowErr),
          })}\n`
        );
        res.end();
      } catch (_) {}
    }
  } catch (e) {
    console.error(e);
    if (res.headersSent) {
      try {
        res.write(`${JSON.stringify({ error: e.message || String(e) })}\n`);
        res.end();
      } catch (_) {}
    } else {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  }
});

app.post("/api/import-csv", (req, res) => {
  try {
    const { csvText, filename = "" } = req.body || {};
    const text = String(csvText || "");
    if (!text.trim()) {
      return res.status(400).json({ error: "No CSV text. Choose a .csv file or paste content." });
    }

    let { headers, records } = parseCsv(text);
    if (!headers.length) {
      return res.status(400).json({ error: "Could not read CSV headers (empty file?)." });
    }

    const cappedPlain = applyCsvRowCap(records);
    records = cappedPlain.records;
    const csvRowCapPlain = cappedPlain.cap;

    const safeName = String(filename || "upload.csv")
      .replace(/[/\\?%*:|"<>]/g, "_")
      .slice(0, 200);
    const rows = rowsFromBibliographyCsv(records, headers, safeName);
    if (rows.length === 0) {
      return res.status(400).json({
        error: "No data rows with a non-empty title. Check the file and title column mapping.",
      });
    }

    res.json({
      ok: true,
      rows,
      audit: {
        source: "csv_import",
        filename: safeName,
        columnCount: headers.length,
        rowCount: rows.length,
        titleColumn: "auto-detected (e.g. Title, Document Title)",
        csvRowCap: csvRowCapPlain,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

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
      onProgress: logSnowballProgress,
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

    const MAX_TRIAGE_ROWS = 10;
    if (rows.length > MAX_TRIAGE_ROWS) {
      return res.status(400).json({
        error: `Triage accepts at most ${MAX_TRIAGE_ROWS} rows per request. Split your corpus into smaller batches.`,
      });
    }

    const criteria = String(criteriaText || "").trim();
    if (!criteria) {
      return res.status(400).json({
        error: "Paste your topic / inclusion-exclusion logic for triage.",
      });
    }

    const anthLegacy = String(anthropicApiKey || "").trim();
    const gemLegacy = String(geminiApiKey || "").trim();
    const genericKey = String(apiKey || "").trim();

    let provider = String(providerRaw || "").toLowerCase().trim();
    if (!provider) {
      provider = anthLegacy ? "anthropic" : "gemini";
    }

    if (provider !== "gemini" && provider !== "anthropic") {
      return res.status(400).json({
        error: 'provider must be "gemini" or "anthropic".',
      });
    }

    const geminiKey = gemLegacy || genericKey;
    const anthKey = anthLegacy || genericKey;
    if (provider === "gemini" && !geminiKey) {
      return res.status(400).json({ error: "Missing Google AI Studio API key." });
    }
    if (provider === "anthropic" && !anthKey) {
      return res.status(400).json({ error: "Missing Anthropic API key." });
    }

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const onProgress = (ev) => {
      try {
        res.write(`${JSON.stringify({ progress: ev })}\n`);
      } catch (_) {}
    };

    let enriched;
    if (provider === "gemini") {
      enriched = await triageRowsWithGemini(rows, {
        criteriaText: criteria,
        geminiApiKey: geminiKey,
        model: model || "gemini-2.5-flash",
        onProgress,
      });
    } else {
      enriched = await triageRowsWithAnthropic(rows, {
        criteriaText: criteria,
        anthropicApiKey: anthKey,
        model: model || "claude-sonnet-4-20250514",
        onProgress,
      });
    }

    res.write(`${JSON.stringify({ result: { ok: true, rows: enriched } })}\n`);
    res.end();
  } catch (e) {
    console.error(e);
    if (res.headersSent) {
      try {
        res.write(`${JSON.stringify({ error: e.message || String(e) })}\n`);
        res.end();
      } catch (_) {}
    } else {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  }
});

app.listen(PORT, () => {
  console.log(`SMS snowball UI: http://localhost:${PORT}`);
});
