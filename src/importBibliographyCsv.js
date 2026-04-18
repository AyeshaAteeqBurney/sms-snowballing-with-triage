function normHeader(h) {
  return String(h).trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeDoi(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/^\uFEFF/, "");
  const m = s.match(/10\.\d{4,}\/[^\s,;]+/i);
  if (m) return m[0].replace(/[.,;:]+$/, "");
  try {
    const u = new URL(s);
    if (u.hostname.includes("doi.org")) {
      const path = u.pathname.replace(/^\//, "");
      const dm = path.match(/10\.\d{4,}\/.+/);
      if (dm) return dm[0];
    }
  } catch {
    /* ignore */
  }
  return s;
}

/** Extract OpenAlex work id like W2741809807 from text or URL. */
function extractOpenAlexId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const direct = s.match(/^W\d{8,}$/i);
  if (direct) return direct[0].toUpperCase();
  const url = s.match(/openalex\.org\/(?:works\/)?(W\d{8,})/i);
  if (url) return url[1].toUpperCase();
  return "";
}

function pickTitleColumn(headers) {
  const n = headers.map(normHeader);
  const prefer = [
    "document title",
    "article title",
    "paper title",
    "publication title",
    "title",
  ];
  for (const p of prefer) {
    const idx = n.findIndex((h) => h === p);
    if (idx >= 0) return idx;
  }
  for (let i = 0; i < n.length; i += 1) {
    const h = n[i];
    if (!h.includes("title")) continue;
    if (h.includes("source") || h.includes("journal") || h.includes("abbrev")) continue;
    return i;
  }
  return -1;
}

function pickColumn(headers, exactCandidates) {
  const n = headers.map(normHeader);
  for (const ex of exactCandidates) {
    const idx = n.findIndex((h) => h === ex);
    if (idx >= 0) return idx;
  }
  return -1;
}

function pickYearColumn(headers) {
  const n = headers.map(normHeader);
  const idx = pickColumn(headers, ["year", "publication year", "pub year"]);
  if (idx >= 0) return idx;
  const j = n.findIndex((h) => h.includes("year") && !h.includes("cited"));
  return j;
}

function pickDoiColumn(headers) {
  const n = headers.map(normHeader);
  const idx = pickColumn(headers, [
    "doi",
    "digital object identifier",
    "doi link",
    "digital object indentifier",
  ]);
  if (idx >= 0) return idx;
  const j = n.findIndex((h) => h.includes("doi"));
  return j;
}

function pickAbstractColumn(headers) {
  const n = headers.map(normHeader);
  const idx = pickColumn(headers, [
    "abstract",
    "abstract document",
    "abstracts",
    "article abstract",
  ]);
  if (idx >= 0) return idx;
  const j = n.findIndex((h) => h === "abstract note" || h.endsWith("abstract"));
  return j;
}

function pickOpenAlexColumn(headers) {
  const n = headers.map(normHeader);
  for (let i = 0; i < n.length; i += 1) {
    const h = n[i];
    if (
      h.includes("openalex") ||
      (h.includes("open alex") && h.includes("id"))
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Map bibliography CSV records (Scopus / IEEE / generic) to snowball-compatible row shapes.
 * Rows use synthetic openalex_id when missing so triage JSON keys stay stable.
 */
export function rowsFromBibliographyCsv(records, headers, filename = "") {
  const ti = pickTitleColumn(headers);
  const yi = pickYearColumn(headers);
  const di = pickDoiColumn(headers);
  const ai = pickAbstractColumn(headers);
  const oi = pickOpenAlexColumn(headers);

  if (ti < 0) {
    throw new Error(
      'Could not find a "Title" column. Expected headers like Title, Document Title, or Article Title.'
    );
  }

  const keys = headers;
  const rows = [];

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    const title = String(rec[keys[ti]] ?? "").trim();
    if (!title) continue;

    const doi = di >= 0 ? normalizeDoi(rec[keys[di]]) : "";
    let openalexRaw = oi >= 0 ? String(rec[keys[oi]] ?? "").trim() : "";
    let openalex_id = extractOpenAlexId(openalexRaw);
    if (!openalex_id && doi) {
      openalex_id = `doi:${doi}`;
    }
    if (!openalex_id) {
      openalex_id = `import:${i + 1}`;
    }

    const yearRaw = yi >= 0 ? String(rec[keys[yi]] ?? "").trim() : "";
    const year = yearRaw.replace(/\..*$/, "").slice(0, 4);

    const abstract =
      ai >= 0 ? String(rec[keys[ai]] ?? "").trim().slice(0, 8000) : "";

    const landing_url = doi ? `https://doi.org/${doi}` : "";

    rows.push({
      openalex_id,
      doi: doi || "",
      title,
      year: year || "",
      direction: "upload",
      discovered_round: 0,
      parent_openalex_id: "",
      landing_url,
      oa_url: "",
      abstract: abstract || undefined,
      source_import: filename || "upload.csv",
    });
  }

  return rows;
}

/**
 * Unique seed lines for OpenAlex (plain DOI or W… id) from imported rows.
 */
export function extractSeedLinesFromImportedRows(rows) {
  const seen = new Set();
  const seeds = [];
  const add = (line) => {
    const t = String(line ?? "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    seeds.push(t);
  };

  for (const r of rows) {
    const doi = normalizeDoi(r.doi ?? "");
    if (doi) add(doi);

    const oid = String(r.openalex_id ?? "").trim();
    const w = oid.match(/^W\d{8,}$/i);
    if (w) add(w[0].toUpperCase());
    else if (oid.toLowerCase().startsWith("doi:")) {
      const d = normalizeDoi(oid.slice(4));
      if (d) add(d);
    }
  }

  return seeds;
}

function matchKeysForRow(r) {
  const keys = new Set();
  const d = normalizeDoi(r.doi ?? "");
  if (d) keys.add(`doi:${d}`);
  const oid = String(r.openalex_id ?? "").trim();
  if (/^W\d{8,}$/i.test(oid)) keys.add(`oa:${oid.toUpperCase()}`);
  if (oid.toLowerCase().startsWith("doi:")) {
    const d2 = normalizeDoi(oid.slice(4));
    if (d2) keys.add(`doi:${d2}`);
  }
  return keys;
}

/** Prefer CSV abstracts on snowball rows when OpenAlex row has none. */
export function enrichSnowRowsWithCsvAbstracts(snowRows, importedRows) {
  const doiToAbstract = new Map();
  for (const ir of importedRows) {
    const d = normalizeDoi(ir.doi ?? "");
    const abs = String(ir.abstract ?? "").trim();
    if (d && abs && !doiToAbstract.has(`doi:${d}`)) {
      doiToAbstract.set(`doi:${d}`, abs.slice(0, 8000));
    }
  }
  return snowRows.map((r) => {
    const d = normalizeDoi(r.doi ?? "");
    if (!d) return r;
    const abs = doiToAbstract.get(`doi:${d}`);
    if (abs && !String(r.abstract ?? "").trim()) {
      return { ...r, abstract: abs };
    }
    return r;
  });
}

/**
 * Keep full snowball graph; append CSV rows that did not resolve into the graph (e.g. no DOI / no OpenAlex match).
 */
export function mergeSnowballWithOrphanImports(snowRows, importedRows) {
  const snowHit = new Set();
  for (const r of snowRows) {
    for (const k of matchKeysForRow(r)) {
      snowHit.add(k);
    }
  }

  const merged = [...snowRows];
  for (const ir of importedRows) {
    const ik = matchKeysForRow(ir);
    let found = false;
    for (const k of ik) {
      if (snowHit.has(k)) {
        found = true;
        break;
      }
    }
    if (!found) merged.push(ir);
  }

  return merged.sort((a, b) => {
    const ra = Number(a.discovered_round ?? 0);
    const rb = Number(b.discovered_round ?? 0);
    if (ra !== rb) return ra - rb;
    return String(a.title ?? "").localeCompare(String(b.title ?? ""));
  });
}
