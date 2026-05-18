let lastRows = [];
let lastAudit = null;

/** Rows loaded for triage (CSV upload or copied from snowball). */
let triageSourceRows = [];
/** Merged triage outputs keyed by openalex id / doi / title. */
const triageAccumulatedMap = new Map();
let triageMergedRows = [];

const TABLE_PAGE_SIZE = 10;
let snowballTablePageIndex = 0;
let triageTablePageIndex = 0;

let chartRoundsInst = null;
let chartRelevanceInst = null;

const MAX_TRIAGE_BATCH = 10;
const THEME_STORAGE_KEY = "sra-theme";

function $(id) {
  return document.getElementById(id);
}

function resolveTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

function applyTheme(theme, options = {}) {
  const { refreshCharts = false } = options;
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);

  const btn = $("btnThemeToggle");
  if (btn) {
    const isDark = next === "dark";
    btn.setAttribute(
      "aria-label",
      isDark ? "Switch to light mode" : "Switch to dark mode"
    );
    const label = btn.querySelector(".theme-toggle__label");
    if (label) label.textContent = isDark ? "Light" : "Dark";
  }

  if (refreshCharts && typeof Chart !== "undefined") {
    updateChartsSnowball(lastRows);
    updateChartsTriage(triageMergedRows);
  }
}

function initThemeToggle() {
  applyTheme(resolveTheme(), { refreshCharts: false });

  const btn = $("btnThemeToggle");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next, { refreshCharts: true });
  });

  if (typeof window.matchMedia === "function") {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (localStorage.getItem(THEME_STORAGE_KEY)) return;
        applyTheme(resolveTheme(), { refreshCharts: true });
      });
  }
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

function updateChartsSnowball(rows) {
  applyChartTheme();

  const grid = chartCss("--chart-grid", "rgba(60, 64, 67, 0.2)");
  const muted = chartCss("--chart-muted", "#5f6368");
  const accent = chartCss("--chart-accent", "rgba(26, 115, 232, 0.65)");
  const accentStrong = chartCss(
    "--chart-accent-strong",
    "rgba(26, 115, 232, 0.95)"
  );

  const roundAgg = aggregateRounds(rows);

  destroyChart(chartRoundsInst);
  const ctxR = $("chartRounds").getContext("2d");
  chartRoundsInst = new Chart(ctxR, {
    type: "bar",
    data: {
      labels: roundAgg.labels.length ? roundAgg.labels : ["—"],
      datasets: [
        {
          label: "Papers",
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
}

function updateChartsTriage(rows) {
  applyChartTheme();

  const muted = chartCss("--chart-muted", "#5f6368");
  const cardBg = chartCss("--chart-card", "#ffffff");

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
    captionEl.textContent =
      "Run screening on batches—combined results will appear here.";
    summaryEl.textContent = "";
  } else if (!rel.triaged) {
    labels = ["Waiting for scores"];
    data = [rows.length];
    colors = [muted];
    captionEl.textContent = `${rows.length} paper(s) loaded—run screening to see relevance scores.`;
    summaryEl.textContent =
      "Scores reflect fit to your criteria—they guide reading, not final decisions.";
  } else if (rel.totalLabeled === 0 && rel.emptyBand > 0) {
    labels = ["Unscored"];
    data = [rel.emptyBand];
    colors = ["#94a3b8"];
    captionEl.textContent =
      "Screening finished but no scores were returned—try clearer criteria and run again.";
    summaryEl.textContent =
      "Add more detail to your screening criteria, then screen another batch.";
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
    captionEl.textContent = `Score distribution across ${rows.length} screened paper(s).`;
    const denom = rel.totalLabeled + rel.emptyBand || 1;
    const pctFocus = Math.round(((rel.medium + rel.high) / denom) * 100);
    summaryEl.textContent =
      `About ${pctFocus}% rated medium or high—read titles and abstracts to confirm before including papers.`;
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

function renderSnowballTable() {
  const rows = lastRows;
  const total = rows.length;
  const tb = $("tblSnowball").querySelector("tbody");
  tb.innerHTML = "";

  const pager = $("tablePagerSnowball");
  const meta = $("tablePagerMetaSnow");
  const btnPrev = $("btnTablePrevSnow");
  const btnNext = $("btnTableNextSnow");
  const showPager = total > TABLE_PAGE_SIZE;

  if (pager) {
    pager.hidden = !showPager;
  }

  let slice = rows;
  if (showPager) {
    const pageCount = Math.ceil(total / TABLE_PAGE_SIZE);
    if (snowballTablePageIndex >= pageCount) {
      snowballTablePageIndex = Math.max(0, pageCount - 1);
    }
    const start = snowballTablePageIndex * TABLE_PAGE_SIZE;
    slice = rows.slice(start, start + TABLE_PAGE_SIZE);
    const end = Math.min(total, start + slice.length);
    if (meta) {
      meta.textContent = `${start + 1}–${end} of ${total} · page ${snowballTablePageIndex + 1} of ${pageCount}`;
    }
    if (btnPrev) btnPrev.disabled = snowballTablePageIndex <= 0;
    if (btnNext) btnNext.disabled = snowballTablePageIndex >= pageCount - 1;
  } else {
    snowballTablePageIndex = 0;
    if (meta) meta.textContent = "";
    if (btnPrev) btnPrev.disabled = true;
    if (btnNext) btnNext.disabled = true;
  }

  for (const r of slice) {
    const tr = document.createElement("tr");
    const link = r.landing_url || (r.doi ? `https://doi.org/${r.doi}` : "");
    tr.innerHTML = `
      <td>${escapeHtml(r.discovered_round)}</td>
      <td>${escapeHtml(r.direction)}</td>
      <td>${escapeHtml(r.year)}</td>
      <td>${escapeHtml(r.doi)}</td>
      <td>${escapeHtml(truncate(r.title, 120))}</td>
      <td><code>${escapeHtml(r.openalex_id)}</code></td>
      <td>${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">View</a>` : ""}</td>
    `;
    tb.appendChild(tr);
  }
}

function renderTriageTable() {
  const rows = triageMergedRows;
  const total = rows.length;
  const tb = $("tblTriage").querySelector("tbody");
  tb.innerHTML = "";

  const pager = $("tablePagerTriage");
  const meta = $("tablePagerMetaTriage");
  const btnPrev = $("btnTablePrevTriage");
  const btnNext = $("btnTableNextTriage");
  const showPager = total > TABLE_PAGE_SIZE;

  if (pager) {
    pager.hidden = !showPager;
  }

  let slice = rows;
  if (showPager) {
    const pageCount = Math.ceil(total / TABLE_PAGE_SIZE);
    if (triageTablePageIndex >= pageCount) {
      triageTablePageIndex = Math.max(0, pageCount - 1);
    }
    const start = triageTablePageIndex * TABLE_PAGE_SIZE;
    slice = rows.slice(start, start + TABLE_PAGE_SIZE);
    const end = Math.min(total, start + slice.length);
    if (meta) {
      meta.textContent = `${start + 1}–${end} of ${total} · page ${triageTablePageIndex + 1} of ${pageCount}`;
    }
    if (btnPrev) btnPrev.disabled = triageTablePageIndex <= 0;
    if (btnNext) btnNext.disabled = triageTablePageIndex >= pageCount - 1;
  } else {
    triageTablePageIndex = 0;
    if (meta) meta.textContent = "";
    if (btnPrev) btnPrev.disabled = true;
    if (btnNext) btnNext.disabled = true;
  }

  const hintEl = $("triageAccumHint");
  if (hintEl) {
    hintEl.textContent = total
      ? `${total} screened paper(s) so far—export results or screen the next batch.`
      : "No screening runs yet—screen a batch above to see results here.";
  }

  for (const r of slice) {
    const tr = document.createElement("tr");
    const link = r.landing_url || (r.doi ? `https://doi.org/${r.doi}` : "");
    const rel = escapeHtml(r.ai_relevance_likelihood ?? "");
    tr.innerHTML = `
      <td>${escapeHtml(r.discovered_round)}</td>
      <td>${escapeHtml(r.direction)}</td>
      <td>${escapeHtml(r.year)}</td>
      <td>${escapeHtml(r.doi)}</td>
      <td>${escapeHtml(truncate(r.title, 100))}</td>
      <td><code>${escapeHtml(r.openalex_id)}</code></td>
      <td>${rel ? `<span class="triage-rel">${rel}</span>` : "—"}</td>
      <td>${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer">View</a>` : ""}</td>
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

/** Phases used for CSV snowball NDJSON progress (avoid flicker from per-parent logs). */
const SNOWBALL_UI_PHASES = new Set([
  "resolve_seeds_start",
  "seed_resolved",
  "snowball_rounds_start",
  "round_start",
  "round_expand_progress",
  "round_done",
]);

function snowballProgressPercent(ev, state) {
  const R = Math.max(1, Number(state.maxRounds) || 2);
  const w = 0.1;
  const rs = (1 - w) / R;
  const p = ev.phase;
  if (p === "resolve_seeds_start") return 1;
  if (p === "seed_resolved") {
    const t = Number(ev.total) || 1;
    const i = Number(ev.idx) || 0;
    return Math.min(99, Math.round(100 * w * (i / t)));
  }
  if (p === "snowball_rounds_start") return Math.round(100 * w);
  if (p === "round_start") {
    const r = Number(ev.round) || 1;
    return Math.min(99, Math.round(100 * (w + rs * (r - 1))));
  }
  if (p === "round_expand_progress") {
    const r = Number(ev.round) || 1;
    const tot = Number(ev.total) || 1;
    const done = Number(ev.completed) || 0;
    const base = w + rs * (r - 1);
    const within = rs * (done / tot);
    return Math.min(99, Math.round(100 * (base + within)));
  }
  if (p === "round_done") {
    const r = Number(ev.round) || 1;
    return Math.min(99, Math.round(100 * (w + rs * r)));
  }
  return state.lastPct ?? 1;
}

function snowballProgressDetail(ev, state) {
  const R = Math.max(1, Number(state.maxRounds) || 2);
  switch (ev.phase) {
    case "resolve_seeds_start":
      return ev.count != null
        ? `linking to OpenAlex · ${ev.count} seed paper(s)`
        : "linking to OpenAlex";
    case "seed_resolved":
      return `preparing seeds ${ev.idx} of ${ev.total}`;
    case "snowball_rounds_start":
      return `expanding citations (${R} round(s))`;
    case "round_start":
      return `round ${ev.round} of ${R} · ${ev.frontierSize} paper(s) to expand`;
    case "round_expand_progress":
      return `round ${ev.round} of ${R} · ${ev.completed} of ${ev.total} expanded`;
    case "round_done":
      return `round ${ev.round} of ${R} done · ${ev.nextFrontier ?? 0} queued next`;
    default:
      return "";
  }
}

function formatImportSnowballBusyLine(ev, state) {
  if (ev.phase === "snowball_rounds_start" && ev.maxRounds != null) {
    state.maxRounds = Number(ev.maxRounds) || state.maxRounds;
  }
  const pct = snowballProgressPercent(ev, state);
  state.lastPct = pct;
  const detail = snowballProgressDetail(ev, state);
  let line = `Building network: ${pct}%`;
  if (detail) line += ` — ${detail}`;
  line += " · keep this tab open.";
  return line;
}

function formatTriageRunningFromProgress(ev) {
  const phase = ev.phase || "";
  const total = Math.max(1, Number(ev.totalRows) || 0);
  const pr = Math.min(Number(ev.processedRows) || 0, total);
  const wc = Math.max(1, Number(ev.waveCountApprox) || 1);

  let pct;
  let detail;

  if (phase === "triage_start") {
    pct = 0;
    detail = `preparing ${total} paper(s)`;
  } else if (phase === "triage_pacing") {
    pct = 3;
    const sec = Math.max(1, Math.ceil((Number(ev.waitMs) || 0) / 1000));
    detail = `waiting ${sec}s between requests`;
  } else if (phase === "triage_rate_limit_wait") {
    pct = Math.min(
      94,
      Math.max(
        5,
        Math.round((100 * (Number(ev.attempt) || 1)) / Math.max(1, Number(ev.maxAttempts) || 12))
      )
    );
    const sec = Math.max(1, Math.ceil((Number(ev.waitMs) || 0) / 1000));
    detail = `API limit reached — pausing ~${sec}s (retry ${Number(ev.attempt) || 1} of ${Number(ev.maxAttempts) || 12})`;
  } else if (phase === "triage_wave_start") {
    const wi = Math.max(1, Number(ev.waveIndex) || 1);
    pct = Math.max(1, Math.min(97, Math.round((100 * wi) / wc)));
    detail = `screening papers ${ev.rowFrom}–${ev.rowTo} · ${pr} of ${total} scored`;
    if (pr === 0 && wi <= 2) {
      detail += " · first response may take a few minutes";
    }
  } else {
    pct = Math.min(99, Math.ceil((100 * pr) / total));
    detail = `scored ${pr} of ${total} paper(s)`;
  }

  return (
    `<span class="triage-spinner-host-inline" aria-hidden="true"><span class="triage-spinner"></span></span>` +
    `<span class="triage-running-text"><strong>Screening:</strong> ${pct}% — ${detail}. Keep this tab open.</span>` +
    `<span class="visually-hidden"> Triage ${pct}%</span>`
  );
}

function formatTriageErrorHint(err) {
  const msg = String(err?.message ?? err ?? "");
  if (/quota|rate|429|ResourceExhausted|free_tier|exceeded your current quota/i.test(msg)) {
    return `${msg} — Try again in a minute, switch models, or use a paid API key if limits persist.`;
  }
  return msg;
}

async function consumeTriageNdjson(res, onProgressEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload = null;
  let streamErr = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.error) streamErr = msg.error;
      if (msg.progress) {
        const pr = msg.progress;
        if (
          pr.phase === "triage_start" ||
          pr.phase === "triage_wave_start" ||
          pr.phase === "triage_progress" ||
          pr.phase === "triage_pacing" ||
          pr.phase === "triage_rate_limit_wait"
        ) {
          onProgressEvent(pr);
        }
      }
      if (msg.result) finalPayload = msg.result;
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      const msg = JSON.parse(tail);
      if (msg.error) streamErr = msg.error;
      if (msg.result) finalPayload = msg.result;
    } catch {
      /* ignore truncated tail */
    }
  }

  if (streamErr) throw new Error(streamErr);
  if (!finalPayload) throw new Error("Incomplete response from server.");
  return finalPayload;
}

async function consumeImportCsvSnowballNdjson(res, state, onLine) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload = null;
  let streamErr = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.error) streamErr = msg.error;
      if (msg.progress) {
        const ph = msg.progress.phase;
        if (SNOWBALL_UI_PHASES.has(ph)) {
          onLine(formatImportSnowballBusyLine(msg.progress, state));
        }
      }
      if (msg.result) finalPayload = msg.result;
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      const msg = JSON.parse(tail);
      if (msg.error) streamErr = msg.error;
      if (msg.result) finalPayload = msg.result;
    } catch {
      /* ignore truncated tail */
    }
  }

  if (streamErr) throw new Error(streamErr);
  if (!finalPayload) throw new Error("Incomplete response from server.");
  return finalPayload;
}

function rowMergeKey(r) {
  const id = String(r?.openalex_id ?? "").trim();
  if (id) return `oa:${id}`;
  const d = String(r?.doi ?? "").trim().toLowerCase();
  if (d) return `doi:${d}`;
  return `t:${String(r?.title ?? "").slice(0, 120)}`;
}

function mergeTriageIntoAccumulated(enrichedRows) {
  for (const r of enrichedRows) {
    const k = rowMergeKey(r);
    triageAccumulatedMap.set(k, { ...(triageAccumulatedMap.get(k) || {}), ...r });
  }
  triageMergedRows = [...triageAccumulatedMap.values()];
}

function clampTriageBatchSize() {
  const el = $("triageBatchSize");
  if (!el) return MAX_TRIAGE_BATCH;
  let n = Number(el.value) || MAX_TRIAGE_BATCH;
  n = Math.min(MAX_TRIAGE_BATCH, Math.max(1, Math.floor(n)));
  el.value = String(n);
  return n;
}

function getCurrentTriageSlice() {
  if (!triageSourceRows.length) return [];
  clampTriageBatchSize();
  const startOne = Number($("triageRowStart")?.value) || 1;
  const start = Math.max(0, Math.floor(startOne) - 1);
  const size = Number($("triageBatchSize")?.value) || MAX_TRIAGE_BATCH;
  const end = Math.min(triageSourceRows.length, start + size);
  return triageSourceRows.slice(start, end);
}

async function parseTriageCsvViaApi(csvText, filename) {
  const res = await fetch("/api/import-csv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csvText, filename }),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Could not parse CSV (${res.status})`);
  }
  return data.rows || [];
}

let activeWorkflowTab = "snowball";

function resizeWorkflowCharts() {
  requestAnimationFrame(() => {
    chartRoundsInst?.resize?.();
    chartRelevanceInst?.resize?.();
  });
}

function setWorkflowTab(tabId) {
  if (tabId !== "snowball" && tabId !== "triage") return;
  activeWorkflowTab = tabId;

  document.querySelectorAll(".workflow-tabs__btn").forEach((btn) => {
    const on = btn.dataset.tab === tabId;
    btn.classList.toggle("workflow-tabs__btn--active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    btn.tabIndex = on ? 0 : -1;
  });

  document.querySelectorAll(".workflow-panel").forEach((panel) => {
    const on = panel.id === `panel-${tabId}`;
    panel.classList.toggle("workflow-panel--active", on);
    panel.setAttribute("aria-hidden", on ? "false" : "true");
  });

  resizeWorkflowCharts();
}

function initWorkflowTabs() {
  document.querySelectorAll(".workflow-tabs__btn").forEach((btn) => {
    btn.addEventListener("click", () => setWorkflowTab(btn.dataset.tab));
    btn.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      setWorkflowTab(activeWorkflowTab === "snowball" ? "triage" : "snowball");
    });
  });

  const goTriage = $("btnGoToTriage");
  if (goTriage) {
    goTriage.addEventListener("click", () => setWorkflowTab("triage"));
  }

  setWorkflowTab("snowball");
}

function syncTriageAvailability() {
  const hasSource = triageSourceRows.length > 0;
  $("btnLoadSnowballIntoTriage").disabled = lastRows.length === 0;
  const goTriage = $("btnGoToTriage");
  if (goTriage) goTriage.hidden = lastRows.length === 0;
  const slice = getCurrentTriageSlice();
  $("btnTriage").disabled = !hasSource || slice.length === 0;
  const gate = $("triageGateHint");
  if (gate) gate.hidden = hasSource;
}

$("btnTablePrevSnow").addEventListener("click", () => {
  if (snowballTablePageIndex > 0) {
    snowballTablePageIndex -= 1;
    renderSnowballTable();
  }
});

$("btnTableNextSnow").addEventListener("click", () => {
  const total = lastRows.length;
  if (total <= TABLE_PAGE_SIZE) return;
  const pageCount = Math.ceil(total / TABLE_PAGE_SIZE);
  if (snowballTablePageIndex < pageCount - 1) {
    snowballTablePageIndex += 1;
    renderSnowballTable();
  }
});

$("btnTablePrevTriage").addEventListener("click", () => {
  if (triageTablePageIndex > 0) {
    triageTablePageIndex -= 1;
    renderTriageTable();
  }
});

$("btnTableNextTriage").addEventListener("click", () => {
  const total = triageMergedRows.length;
  if (total <= TABLE_PAGE_SIZE) return;
  const pageCount = Math.ceil(total / TABLE_PAGE_SIZE);
  if (triageTablePageIndex < pageCount - 1) {
    triageTablePageIndex += 1;
    renderTriageTable();
  }
});

function formatCsvCapCalloutHtml(audit) {
  const c = audit?.csvRowCap;
  if (!c?.applied) return "";
  return (
    `<div class="callout" role="alert"><strong>Large list shortened</strong>: processed the first <strong>${c.limit}</strong> of ${c.totalRowsInFile} papers (${c.skipped} not included this run).</div>`
  );
}

function formatSeedCapCalloutHtml(audit) {
  const s = audit?.csvSnowball?.seedCap;
  if (!s?.applied) return "";
  return (
    `<div class="callout" role="alert"><strong>Seed limit reached</strong>: expanded the first <strong>${s.limit}</strong> of ${s.totalUnique} identifiable papers (${s.skipped} seeds not expanded this run). Other entries from your list are still listed when they do not overlap the network.</div>`
  );
}

function formatImportCalloutsHtml(audit) {
  return formatCsvCapCalloutHtml(audit) + formatSeedCapCalloutHtml(audit);
}

function formatCsvCapAuditPrefix(audit) {
  const c = audit?.csvRowCap;
  if (!c?.applied) return "";
  return `First ${c.limit} of ${c.totalRowsInFile} papers processed. `;
}

function formatSeedCapAuditPrefix(audit) {
  const s = audit?.csvSnowball?.seedCap;
  if (!s?.applied) return "";
  return `Expanded ${s.limit} of ${s.totalUnique} seeds. `;
}

/** Summary line after CSV upload + automatic snowball merge. */
function formatCsvSnowballAuditLine(audit) {
  if (!audit) return "";
  const capP = formatCsvCapAuditPrefix(audit) + formatSeedCapAuditPrefix(audit);
  if (audit.snowballSkipped) {
    const fn = audit.filename || "upload.csv";
    return (
      capP +
      `${audit.rowCount ?? "—"} papers from ${fn} · citation expansion skipped (add DOIs or IDs to expand).`
    );
  }
  const cs = audit.csvSnowball;
  let line =
    capP +
    `${audit.seedsResolved ?? "—"} seeds · ${audit.totalWorks ?? "—"} papers found · ${audit.roundsExecuted ?? "—"} expansion round(s)`;
  if (cs) {
    line +=
      ` · ${cs.seedLinesUsed} of ${cs.csvRowCount} starting papers expanded`;
    if (
      cs.seedLinesTotalUnique != null &&
      cs.seedLinesTotalUnique > cs.seedLinesUsed
    ) {
      line += ` (${cs.seedLinesTotalUnique} identifiable in file)`;
    }
    line += ` · ${cs.orphansMerged} from your list only · ${cs.totalAfterMerge} total`;
  }
  return line;
}

function formatExpansionHtml(audit) {
  if (!audit) return "";
  const sg = audit.seedGraph;
  const ex = audit.expansion;
  const parts = [];

  const capHtml = formatImportCalloutsHtml(audit);
  if (capHtml) parts.push(capHtml);

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

  if (ex?.frontierCaps?.length) {
    const lines = ex.frontierCaps.map(
      (c) =>
        `Round ${escapeHtml(String(c.round))}: expanded ${escapeHtml(String(c.expanded))} of ${escapeHtml(String(c.total))} frontier works (skipped ${escapeHtml(String(c.skipped))} lower-priority nodes by citation count).`
    );
    parts.push(
      `<strong>Frontier cap</strong> (per round): ${lines.join(" ")}`
    );
  }

  return parts.join("<br/><br/>");
}

$("btnCsvSnowball").addEventListener("click", () => {
  if (!lastRows.length) return;
  const csv = rowsToCsv(lastRows);
  downloadCsv(`snowball_${new Date().toISOString().slice(0, 10)}.csv`, csv);
});

$("btnCsvTriage").addEventListener("click", () => {
  if (!triageMergedRows.length) return;
  const csv = rowsToCsv(triageMergedRows);
  downloadCsv(`triage_accum_${new Date().toISOString().slice(0, 10)}.csv`, csv);
});

const TRIAGE_MODELS = {
  gemini: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash (recommended)" },
    { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
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
      ? "Google AI Studio API key (used on this computer only, not saved)"
      : "Anthropic API key (used on this computer only, not saved)";
}

$("triageProvider").addEventListener("change", () => {
  syncTriageModelSelect();
  syncTriageKeyLabel();
});

syncTriageModelSelect();
syncTriageKeyLabel();

$("btnTriage").addEventListener("click", async () => {
  const st = $("triageStatus");
  const batchRows = getCurrentTriageSlice();
  if (!batchRows.length) {
    st.className = "triage-status-msg err";
    st.textContent = "No papers in this batch—check the starting paper number and that a dataset is loaded.";
    return;
  }
  if (batchRows.length > MAX_TRIAGE_BATCH) {
    st.className = "triage-status-msg err";
    st.textContent = `Review at most ${MAX_TRIAGE_BATCH} papers per run.`;
    return;
  }

  const triageTotal = batchRows.length;
  st.className = "triage-running-alert callout callout-danger";
  st.innerHTML = formatTriageRunningFromProgress({
    phase: "triage_start",
    processedRows: 0,
    totalRows: triageTotal,
    waveCountApprox: Math.max(1, Math.ceil(triageTotal / 13)),
  });

  try {
    const res = await fetch("/api/triage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rows: batchRows,
        criteriaText: $("criteria").value,
        provider: $("triageProvider").value,
        apiKey: $("llmKey").value,
        model: $("model").value,
      }),
    });
    const ct = res.headers.get("content-type") || "";

    let data;
    if (ct.includes("application/x-ndjson")) {
      if (!res.ok) {
        const raw = await res.text();
        throw new Error(`Triage failed (HTTP ${res.status}). ${raw.slice(0, 300)}`);
      }
      data = await consumeTriageNdjson(res, (ev) => {
        st.innerHTML = formatTriageRunningFromProgress(ev);
      });
    } else {
      const raw = await res.text();
      let parsed;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(
          res.ok
            ? "Server returned invalid JSON."
            : `Triage failed (HTTP ${res.status}). ${raw.slice(0, 200)}`
        );
      }
      if (!res.ok || parsed.ok === false) {
        throw new Error(parsed.error || `Triage failed (HTTP ${res.status})`);
      }
      data = parsed;
    }

    if (!data.ok) throw new Error(data.error || "Triage failed");
    const enriched = data.rows || [];
    mergeTriageIntoAccumulated(enriched);
    triageTablePageIndex = 0;
    $("btnCsvTriage").disabled = triageMergedRows.length === 0;
    st.className = "triage-status-msg";
    st.textContent = `Screening complete for ${enriched.length} paper(s). Results are below—increase the starting paper number for the next batch or export all results.`;
    renderTriageTable();
    updateChartsTriage(triageMergedRows);
    syncTriageAvailability();
  } catch (e) {
    st.className = "triage-status-msg err";
    st.textContent = formatTriageErrorHint(e);
    syncTriageAvailability();
  }
});

initThemeToggle();

// Initial empty charts
if (typeof Chart !== "undefined") {
  updateChartsSnowball([]);
  updateChartsTriage([]);
}

function setImportSpinner(on) {
  const spin = $("importSpinner");
  if (spin) spin.hidden = !on;
}

let pendingImportFile = null;
let importRunActive = false;

function setSnowballControlsLocked(locked) {
  importRunActive = locked;
  const ids = ["csvFile", "btnStartSnowball", "maxRounds", "maxBack", "maxFwd"];
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    el.disabled = locked;
  }
  if (!locked && $("btnStartSnowball")) {
    $("btnStartSnowball").disabled = !pendingImportFile;
  }
}

function updateFilePickHint() {
  const hint = $("filePickHint");
  if (!hint) return;
  if (!pendingImportFile || importRunActive) {
    hint.hidden = true;
    return;
  }
  hint.hidden = false;
  hint.textContent =
    `Selected: ${pendingImportFile.name} — adjust settings if needed, then click Build citation network.`;
}

$("csvFile").addEventListener("change", (ev) => {
  const st = $("importStatus");
  pendingImportFile = ev.target.files?.[0] || null;
  st.classList.remove("err", "status-busy");
  setImportSpinner(false);
  if (!pendingImportFile) {
    st.textContent = "";
    $("btnStartSnowball").disabled = true;
    updateFilePickHint();
    return;
  }
  $("btnStartSnowball").disabled = false;
  if (!importRunActive) {
    st.textContent = "";
  }
  updateFilePickHint();
});

$("btnStartSnowball").addEventListener("click", async () => {
  const file = pendingImportFile;
  if (!file || importRunActive) return;

  const st = $("importStatus");
  st.classList.remove("err");
  $("btnCsvSnowball").disabled = true;

  setSnowballControlsLocked(true);
  setImportSpinner(true);
  st.classList.add("status-busy");
  st.textContent =
    "Reading your reference list and preparing seed papers…";

  let csvText;
  try {
    csvText = await file.text();
  } catch (e) {
    st.classList.remove("status-busy");
    st.textContent = e.message || String(e);
    st.classList.add("err");
    setImportSpinner(false);
    setSnowballControlsLocked(false);
    updateFilePickHint();
    syncTriageAvailability();
    return;
  }

  const progressState = {
    maxRounds: Math.min(10, Math.max(1, Number($("maxRounds").value) || 2)),
    lastPct: 0,
  };
  st.textContent =
    `Building network: 1% — linking to OpenAlex · ${progressState.maxRounds} round(s) · keep this tab open.`;

  try {
    const res = await fetch("/api/import-csv-snowball", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        csvText,
        filename: file.name,
        mailto: "",
        maxRounds: progressState.maxRounds,
        maxBackwardPerWork: Number($("maxBack").value),
        maxForwardPerWork: Number($("maxFwd").value),
      }),
    });
    const ct = res.headers.get("content-type") || "";

    let data;
    if (ct.includes("application/x-ndjson")) {
      if (!res.ok) {
        const raw = await res.text();
        throw new Error(
          `Import failed (HTTP ${res.status}). ${raw.slice(0, 300)}`
        );
      }
      data = await consumeImportCsvSnowballNdjson(res, progressState, (line) => {
        st.textContent = line;
      });
    } else {
      const raw = await res.text();
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(
          res.ok
            ? "Server returned invalid JSON."
            : `Import failed (HTTP ${res.status}). ${raw.slice(0, 200)}`
        );
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `Import failed (HTTP ${res.status})`);
      }
    }

    lastRows = data.rows || [];
    lastAudit = data.audit || null;
    snowballTablePageIndex = 0;
    $("audit").textContent = formatCsvSnowballAuditLine(data.audit);
    if (data.audit?.snowballSkipped) {
      $("expansionDetail").innerHTML =
        formatImportCalloutsHtml(data.audit) +
        `<em>${escapeHtml(data.audit.reason || "")}</em>`;
    } else {
      $("expansionDetail").innerHTML = formatExpansionHtml(data.audit);
    }
    renderSnowballTable();
    updateChartsSnowball(lastRows);
    $("btnCsvSnowball").disabled = lastRows.length === 0;
    let doneMsg = data.audit?.snowballSkipped
      ? `Loaded ${lastRows.length} paper(s) (citation expansion skipped—see results below).`
      : `Done: ${lastRows.length} paper(s) in your expanded corpus.`;
    if (data.audit?.csvRowCap?.applied) {
      const c = data.audit.csvRowCap;
      doneMsg += ` · First ${c.limit} of ${c.totalRowsInFile} from your list were processed.`;
    }
    const sc = data.audit?.csvSnowball?.seedCap;
    if (sc?.applied) {
      doneMsg += ` · Expanded ${sc.limit} of ${sc.totalUnique} seed papers.`;
    }
    st.classList.remove("status-busy");
    st.textContent = doneMsg;
  } catch (e) {
    st.classList.remove("status-busy");
    st.textContent = e.message || String(e);
    st.classList.add("err");
    $("expansionDetail").innerHTML = "";
    $("audit").textContent = "";
    updateChartsSnowball([]);
  } finally {
    setImportSpinner(false);
    setSnowballControlsLocked(false);
    updateFilePickHint();
    syncTriageAvailability();
  }
});

$("btnLoadSnowballIntoTriage").addEventListener("click", () => {
  if (!lastRows.length) return;
  triageSourceRows = JSON.parse(JSON.stringify(lastRows));
  const hint = $("triageCsvHint");
  if (hint) {
    hint.hidden = false;
    hint.textContent = `Using ${triageSourceRows.length} paper(s) from your latest citation network. Choose where to start and how many to review (up to ${MAX_TRIAGE_BATCH}), then screen.`;
  }
  const fileInput = $("triageCsvFile");
  if (fileInput) fileInput.value = "";
  syncTriageAvailability();
});

$("triageCsvFile").addEventListener("change", async (ev) => {
  const f = ev.target.files?.[0];
  const hint = $("triageCsvHint");
  if (!f) {
    triageSourceRows = [];
    if (hint) hint.hidden = true;
    syncTriageAvailability();
    return;
  }
  try {
    const text = await f.text();
    triageSourceRows = await parseTriageCsvViaApi(text, f.name);
    if (hint) {
      hint.hidden = false;
      hint.textContent = `Loaded ${triageSourceRows.length} paper(s) from ${f.name}. Review up to ${MAX_TRIAGE_BATCH} at a time—set the starting paper and batch size.`;
    }
  } catch (e) {
    triageSourceRows = [];
    if (hint) {
      hint.hidden = false;
      hint.textContent = e.message || String(e);
    }
  }
  syncTriageAvailability();
});

["triageRowStart", "triageBatchSize"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("input", () => syncTriageAvailability());
});

initWorkflowTabs();
syncTriageAvailability();
