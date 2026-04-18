let lastRows = [];
let lastAudit = null;

let chartRoundsInst = null;
let chartRelevanceInst = null;

function $(id) {
  return document.getElementById(id);
}

function escapeCell(s) {
  const t = String(s ?? "");
  if (/[",\r\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function rowsToCsv(rows) {
  if (!rows.length) return "";
  const keySet = new Set();
  for (const r of rows) Object.keys(r).forEach((k) => keySet.add(k));
  const keys = [...keySet];
  const header = keys.map(escapeCell).join(",");
  const lines = rows.map((r) =>
    keys.map((k) => escapeCell(r[k])).join(",")
  );
  return [header, ...lines].join("\r\n");
}

function downloadCsv(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function normRelevanceLikelihood(s) {
  const x = String(s ?? "")
    .trim()
    .toLowerCase();
  if (!x) return "";
  if (x === "high" || x.includes("high")) return "high";
  if (x === "medium" || x.includes("medium")) return "medium";
  if (x === "low" || x.includes("low")) return "low";
  return "other";
}

function aggregateRounds(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = Number(r.discovered_round ?? 0);
    m.set(k, (m.get(k) || 0) + 1);
  }
  const keys = [...m.keys()].sort((a, b) => a - b);
  return {
    labels: keys.map(String),
    values: keys.map((k) => m.get(k)),
  };
}

function aggregateRelevance(rows) {
  let low = 0;
  let medium = 0;
  let high = 0;
  let other = 0;
  let emptyBand = 0;
  const triaged = rows.some((r) => !!r.ai_prompt_version);
  for (const r of rows) {
    const raw = String(r.ai_relevance_likelihood ?? "").trim();
    if (!triaged || !raw) {
      if (triaged && !raw) emptyBand += 1;
      continue;
    }
    const v = normRelevanceLikelihood(raw);
    if (v === "low") low += 1;
    else if (v === "medium") medium += 1;
    else if (v === "high") high += 1;
    else other += 1;
  }
  const totalLabeled = low + medium + high + other;
  return { low, medium, high, other, emptyBand, totalLabeled, triaged };
}

function chartCss(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function applyChartTheme() {
  if (typeof Chart === "undefined") return;
  const fg = chartCss("--chart-fg", "#202124");
  const muted = chartCss("--chart-muted", "#5f6368");
  const border = chartCss("--chart-border", "#dadce0");
  Chart.defaults.color = muted;
  Chart.defaults.borderColor = border;
  Chart.defaults.plugins = Chart.defaults.plugins || {};
  Chart.defaults.plugins.legend = Chart.defaults.plugins.legend || {};
  Chart.defaults.plugins.legend.labels = {
    ...(Chart.defaults.plugins.legend.labels || {}),
    color: fg,
  };
}

function destroyChart(inst) {
  if (inst) {
    inst.destroy();
  }
  return null;
}

function updateCharts(rows) {
  applyChartTheme();

  const grid = chartCss("--chart-grid", "rgba(60, 64, 67, 0.2)");
  const muted = chartCss("--chart-muted", "#5f6368");
  const accent = chartCss("--chart-accent", "rgba(26, 115, 232, 0.65)");
  const accentStrong = chartCss(
    "--chart-accent-strong",
    "rgba(26, 115, 232, 0.95)"
  );
  const cardBg = chartCss("--chart-card", "#ffffff");

  const roundAgg = aggregateRounds(rows);

  destroyChart(chartRoundsInst);
  const ctxR = $("chartRounds").getContext("2d");
  chartRoundsInst = new Chart(ctxR, {
    type: "bar",
    data: {
      labels: roundAgg.labels.length ? roundAgg.labels : ["—"],
      datasets: [
        {
          label: "Works",
          data: roundAgg.values.length ? roundAgg.values : [0],
          backgroundColor: accent,
          borderColor: accentStrong,
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { color: grid },
          title: {
            display: true,
            text: "Discovery round",
            color: muted,
          },
        },
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1 },
          grid: { color: grid },
        },
      },
      plugins: {
        legend: { display: false },
      },
    },
  });

  const rel = aggregateRelevance(rows);
  const captionEl = $("relevanceCaption");
  const summaryEl = $("relevanceSummary");

  destroyChart(chartRelevanceInst);
  const ctxRel = $("chartRelevance").getContext("2d");

  let labels;
  let data;
  let colors;

  if (!rows.length) {
    labels = ["No data"];
    data = [1];
    colors = [muted];
    captionEl.textContent = "Run snowball first.";
    summaryEl.textContent = "";
  } else if (!rel.triaged) {
    labels = ["Awaiting AI triage"];
    data = [rows.length];
    colors = [muted];
    captionEl.textContent =
      `${rows.length} candidate paper(s)—Advisory AI triage above fills estimated relevance bands on this chart.`;
    summaryEl.textContent =
      "AI hints estimate fit to your IC/EC so you can prioritize manual screening faster (they are not inclusion decisions).";
  } else if (rel.totalLabeled === 0 && rel.emptyBand > 0) {
    labels = ["Band not parsed"];
    data = [rel.emptyBand];
    colors = ["#94a3b8"];
    captionEl.textContent =
      "Triage ran but relevance labels were empty—check CSV or rerun triage.";
    summaryEl.textContent =
      "Refine your criteria text and rerun triage to get a clearer relevance chart.";
  } else {
    labels = [];
    data = [];
    colors = [];
    if (rel.low) {
      labels.push("Low");
      data.push(rel.low);
      colors.push("#f87171");
    }
    if (rel.medium) {
      labels.push("Medium");
      data.push(rel.medium);
      colors.push("#fbbf24");
    }
    if (rel.high) {
      labels.push("High");
      data.push(rel.high);
      colors.push("#34d399");
    }
    if (rel.other) {
      labels.push("Other / parse");
      data.push(rel.other);
      colors.push("#94a3b8");
    }
    if (rel.emptyBand) {
      labels.push("No band");
      data.push(rel.emptyBand);
      colors.push("#64748b");
    }
    captionEl.textContent = `Advisory distribution (${rows.length} rows, model output).`;
    const denom = rel.totalLabeled + rel.emptyBand || 1;
    const pctFocus = Math.round(((rel.medium + rel.high) / denom) * 100);
    summaryEl.textContent =
      `About ${pctFocus}% medium or high by model estimate—validate in title/abstract/PDF; use hints to focus reading, not as final accuracy.`;
  }

  chartRelevanceInst = new Chart(ctxRel, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: colors,
          borderColor: cardBg,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: { boxWidth: 12 },
        },
      },
    },
  });
}

function renderTable(rows) {
  const tb = $("tbl").querySelector("tbody");
  tb.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    const link = r.landing_url || (r.doi ? `https://doi.org/${r.doi}` : "");
    tr.innerHTML = `
      <td>${escapeHtml(r.discovered_round)}</td>
      <td>${escapeHtml(r.direction)}</td>
      <td>${escapeHtml(r.year)}</td>
      <td>${escapeHtml(r.doi)}</td>
      <td>${escapeHtml(truncate(r.title, 120))}</td>
      <td><code>${escapeHtml(r.openalex_id)}</code></td>
      <td>${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">open</a>` : ""}</td>
    `;
    tb.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}

function truncate(s, n) {
  const t = String(s ?? "");
  return t.length <= n ? t : t.slice(0, n) + "…";
}

$("btnSnowball").addEventListener("click", async () => {
  const snowStatus = $("snowStatus");
  snowStatus.textContent = "Running… (can take several minutes)";
  snowStatus.classList.remove("err");
  $("btnTriage").disabled = true;
  $("btnCsv").disabled = true;
  lastRows = [];
  lastAudit = null;
  $("tbl").querySelector("tbody").innerHTML = "";
  $("audit").textContent = "";
  $("expansionDetail").innerHTML = "";

  try {
    const res = await fetch("/api/snowball", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seedsText: $("seeds").value,
        maxRounds: Number($("maxRounds").value),
        maxBackwardPerWork: Number($("maxBack").value),
        maxForwardPerWork: Number($("maxFwd").value),
        mailto: $("mailto").value.trim(),
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Snowball failed");

    lastRows = data.rows || [];
    lastAudit = data.audit || null;
    $("audit").textContent = `Seeds resolved: ${data.audit?.seedsResolved ?? "—"} · Works: ${data.audit?.totalWorks ?? lastRows.length} · Rounds executed: ${data.audit?.roundsExecuted ?? "—"}`;
    $("expansionDetail").innerHTML = formatExpansionHtml(data.audit);
    renderTable(lastRows);
    updateCharts(lastRows);
    $("btnCsv").disabled = lastRows.length === 0;
    $("btnTriage").disabled = lastRows.length === 0;
    snowStatus.textContent = "Done.";
  } catch (e) {
    snowStatus.textContent = e.message || String(e);
    snowStatus.classList.add("err");
    $("expansionDetail").textContent = "";
    updateCharts([]);
  }
});

function formatExpansionHtml(audit) {
  if (!audit) return "";
  const sg = audit.seedGraph;
  const ex = audit.expansion;
  const parts = [];

  if (sg) {
    const doiLine =
      sg.doi_resolution_via != null
        ? ` DOI matched via <code>${escapeHtml(sg.doi_resolution_via)}</code>` +
          (sg.doi_merge_candidates != null
            ? ` (${escapeHtml(String(sg.doi_merge_candidates))} OpenAlex rows for that DOI).`
            : ".")
        : "";
    parts.push(
      `<strong>OpenAlex graph (seed)</strong>: references in payload <code>${sg.referenced_works_array_len ?? "—"}</code>` +
        (sg.referenced_works_reported_count != null
          ? ` · reported count <code>${sg.referenced_works_reported_count}</code>`
          : "") +
        (sg.cited_by_count != null
          ? ` · incoming citations (index) <code>${sg.cited_by_count}</code>`
          : "") +
        doiLine +
        ` If references are 0 and citations are 0, snowball cannot add neighbors (the record may truly be isolated in OpenAlex).`
    );
  }

  if (ex?.totals) {
    const t = ex.totals;
    parts.push(
      `<strong>Expansion run</strong>: backward ref IDs queued <code>${t.backwardRefIdsQueued}</code>, resolved <code>${t.backwardWorksResolved}</code>, new unique <code>${t.backwardUniqueAdded}</code>; forward rows fetched <code>${t.forwardWorksFetched}</code>, new unique <code>${t.forwardUniqueAdded}</code>.`
    );
  }

  if (ex?.errors?.length) {
    parts.push(
      `<strong>API issues</strong>: ${escapeHtml(ex.errors.map((e) => e.message || e.scope).join("; "))}`
    );
  }

  return parts.join("<br/><br/>");
}

$("btnCsv").addEventListener("click", () => {
  if (!lastRows.length) return;
  const csv = rowsToCsv(lastRows);
  downloadCsv(`snowball_${new Date().toISOString().slice(0, 10)}.csv`, csv);
});

const TRIAGE_MODELS = {
  gemini: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash (recommended)" },
    { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash (may show 0 quota)" },
    { value: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
  ],
  anthropic: [
    { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
  ],
};

function syncTriageModelSelect() {
  const sel = $("model");
  const prov = $("triageProvider").value;
  const opts = TRIAGE_MODELS[prov] || TRIAGE_MODELS.gemini;
  sel.innerHTML = "";
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
}

function syncTriageKeyLabel() {
  const prov = $("triageProvider").value;
  const span = $("llmKeyLabelText");
  if (!span) return;
  span.textContent =
    prov === "gemini"
      ? "Google AI Studio API key (sent to this local server only; never stored)"
      : "Anthropic API key (sent to this local server only; never stored)";
}

$("triageProvider").addEventListener("change", () => {
  syncTriageModelSelect();
  syncTriageKeyLabel();
});

syncTriageModelSelect();
syncTriageKeyLabel();

$("btnTriage").addEventListener("click", async () => {
  const st = $("triageStatus");
  st.textContent = "Triage running…";
  st.classList.remove("err");

  try {
    const res = await fetch("/api/triage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rows: lastRows,
        criteriaText: $("criteria").value,
        provider: $("triageProvider").value,
        apiKey: $("llmKey").value,
        model: $("model").value,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Triage failed");
    lastRows = data.rows || [];
    $("btnCsv").disabled = lastRows.length === 0;
    st.textContent = `Triage done (${lastRows.length} rows). Charts updated—download CSV for full AI columns.`;
    renderTable(lastRows);
    updateCharts(lastRows);
  } catch (e) {
    st.textContent = e.message || String(e);
    st.classList.add("err");
  }
});

// Initial empty charts
if (typeof Chart !== "undefined") {
  updateCharts([]);
}

if (typeof window.matchMedia === "function") {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => updateCharts(lastRows));
}
