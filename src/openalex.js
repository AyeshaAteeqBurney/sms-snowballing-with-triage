/**
 * OpenAlex API helpers (polite pool: pass mailto on every request).
 * @see https://docs.openalex.org
 */

const BASE = "https://api.openalex.org";

function withMailto(url, mailto) {
  if (!mailto) return url;
  const u = new URL(url);
  u.searchParams.set("mailto", mailto);
  return u.toString();
}

export function parseOpenAlexIdFromString(s) {
  const t = s.trim();
  if (!t) return null;
  if (/^W\d+$/i.test(t)) return t.replace(/^w/i, "W");
  const m = t.match(/openalex\.org\/(W\d+)/i);
  if (m) return m[1].replace(/^w/i, "W");
  return null;
}

export function parseDoiFromString(s) {
  const t = s.trim();
  if (!t) return null;
  if (/^10\.\d+\//.test(t)) return t;
  const m = t.match(/10\.\d+\/[^\s)]+/);
  return m ? m[0] : null;
}

/** Strip wrappers and trailing punctuation often pasted from PDFs */
export function normalizeDoi(input) {
  let d = String(input)
    .replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, "")
    .trim();
  d = d.replace(/[.,;)\]\s]+$/g, "");
  return d.toLowerCase();
}

/** Higher = more citation graph signal in OpenAlex */
export function graphRichnessScore(w) {
  if (!w?.id) return -1;
  const refs = (w.referenced_works || []).length;
  const rc = w.referenced_works_count ?? refs;
  const cites = w.cited_by_count ?? 0;
  return cites * 100000 + rc * 1000 + refs;
}

export async function fetchJson(url, { mailto, signal } = {}) {
  const finalUrl = withMailto(url, mailto);
  const res = await fetch(finalUrl, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAlex ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

/**
 * Resolve a user line: OpenAlex id, DOI, or openalex.org URL
 */
export async function resolveToWorkId(line, { mailto, signal } = {}) {
  const oa = parseOpenAlexIdFromString(line);
  if (oa) {
    const w = await getWork(oa, { mailto, signal });
    return { workId: oa, work: w, source: "openalex_id" };
  }
  const doi = parseDoiFromString(line);
  if (doi) {
    const r = await resolveDoiToRichestWork(doi, { mailto, signal });
    if (!r.work || !r.workId) {
      return {
        workId: null,
        work: null,
        source: "doi",
        error: "not_found",
        doiResolution: r.via,
        doiCandidatesConsidered: r.candidatesConsidered,
      };
    }
    return {
      workId: r.workId,
      work: r.work,
      source: "doi",
      doiResolution: r.via,
      doiCandidatesConsidered: r.candidatesConsidered,
    };
  }
  return { workId: null, work: null, source: "unknown", error: "unparsed" };
}

export function workIdFromObject(work) {
  if (!work) return null;
  const fromIds = work.ids?.openalex ? String(work.ids.openalex).match(/(W\d+)/i) : null;
  if (fromIds) return fromIds[1].replace(/^w/i, "W");
  if (!work?.id) return null;
  const m = String(work.id).match(/(W\d+)/i);
  return m ? m[1].replace(/^w/i, "W") : null;
}

export function landingPageFromWork(work) {
  return (
    work?.primary_location?.landing_page_url ||
    work?.ids?.doi ||
    (work?.doi ? `https://doi.org/${work.doi}` : null) ||
    work?.id
  );
}

export function oaUrlFromWork(work) {
  return work?.best_oa_location?.url || work?.open_access?.oa_url || null;
}

export async function getWork(workId, { mailto, signal } = {}) {
  const id = workId.replace(/^w/i, "W");
  const url = `${BASE}/works/${id}`;
  return fetchJson(url, { mailto, signal });
}

/**
 * OpenAlex often returns multiple Works for one DOI (merges/stubs). The first
 * `filter=doi:` row can be an empty stub (0 refs / 0 cites). Prefer:
 * 1) GET /works/{encodeURIComponent('https://doi.org/…')} (canonical)
 * 2) Richest among filter results + full GET by W-id
 */
export async function resolveDoiToRichestWork(rawDoi, { mailto, signal } = {}) {
  const clean = normalizeDoi(rawDoi);
  if (!/^10\.\d+\//.test(clean)) {
    return { workId: null, work: null, via: null, candidatesConsidered: 0 };
  }

  const doiLocator = `https://doi.org/${clean}`;
  let best = null;
  let via = null;
  let candidatesConsidered = 0;

  try {
    const pathUrl = `${BASE}/works/${encodeURIComponent(doiLocator)}`;
    const w = await fetchJson(pathUrl, { mailto, signal });
    if (w?.id) {
      best = w;
      via = "doi_org_url_path";
    }
  } catch {
    /* try list next */
  }

  try {
    const listUrl = `${BASE}/works?filter=doi:${encodeURIComponent(
      clean
    )}&per-page=100`;
    const data = await fetchJson(listUrl, { mailto, signal });
    const results = data?.results || [];
    candidatesConsidered = results.length;

    if (results.length > 0) {
      results.sort((a, b) => graphRichnessScore(b) - graphRichnessScore(a));
      const top = results[0];
      const wid = workIdFromObject(top);
      let full = top;
      if (wid) {
        try {
          full = await getWork(wid, { mailto, signal });
        } catch {
          full = top;
        }
      }
      if (!best || graphRichnessScore(full) > graphRichnessScore(best)) {
        best = full;
        via = "doi_filter_richest";
      }
    }
  } catch {
    /* keep best from path */
  }

  if (!best?.id) {
    return { workId: null, work: null, via: null, candidatesConsidered };
  }

  if (workIdFromObject(best)) {
    try {
      const hydrated = await getWork(workIdFromObject(best), {
        mailto,
        signal,
      });
      if (hydrated?.id) best = hydrated;
    } catch {
      /* keep */
    }
  }

  return {
    workId: workIdFromObject(best),
    work: best,
    via,
    candidatesConsidered,
  };
}

/** @deprecated Use resolveDoiToRichestWork — filter-first row is often a sparse stub */
export async function getWorkByDoi(doi, { mailto, signal } = {}) {
  const r = await resolveDoiToRichestWork(doi, { mailto, signal });
  return r.work;
}

/**
 * Batch fetch works by W-id (sequential with small chunking to stay polite)
 */
export async function getWorksByIds(ids, { mailto, signal, onProgress } = {}) {
  const out = new Map();
  const unique = [...new Set(ids.map((i) => i.replace(/^w/i, "W")))];

  for (let i = 0; i < unique.length; i += 1) {
    if (signal?.aborted) break;
    const id = unique[i];
    try {
      const w = await getWork(id, { mailto, signal });
      if (w) out.set(id, w);
    } catch {
      // missing or hidden
    }
    onProgress?.({ done: i + 1, total: unique.length });
  }
  return out;
}

/**
 * Parse referenced_works URL list to W-ids
 */
export function referencedWorkIdsFromWork(work) {
  const urls = work?.referenced_works || [];
  const ids = [];
  for (const u of urls) {
    const s = String(u);
    const m = s.match(/\/(W\d+)/i) || s.match(/^(W\d+)/i);
    if (m) ids.push(m[1].replace(/^w/i, "W"));
  }
  return ids;
}

/**
 * Forward citations: works that cite this work
 * filter=cites:W123
 */
export async function fetchCitingWorks(
  workId,
  { mailto, max, signal, onPage } = {}
) {
  const id = workId.replace(/^w/i, "W");

  /** Try shorthand W id first; full OpenAlex URL is an alternate filter shape. */
  const filterVariants = [
    `cites:${id}`,
    `cites:${encodeURIComponent(`https://openalex.org/${id}`)}`,
  ];

  for (let vi = 0; vi < filterVariants.length; vi += 1) {
    const filterParam = filterVariants[vi];
    const collected = [];
    let cursor = null;
    let page = 1;

    while (collected.length < max) {
      if (signal?.aborted) break;
      const perPage = Math.min(200, max - collected.length);
      let url = `${BASE}/works?filter=${encodeURIComponent(
        filterParam
      )}&per-page=${perPage}&sort=cited_by_count:desc`;
      if (cursor) {
        url += `&cursor=${encodeURIComponent(cursor)}`;
      }

      const data = await fetchJson(url, { mailto, signal });
      const results = data?.results || [];

      for (const r of results) {
        collected.push(r);
        if (collected.length >= max) break;
      }

      onPage?.({ page, received: results.length, totalCollected: collected.length });

      const meta = data.meta;
      if (!meta?.next_cursor || results.length === 0) break;
      cursor = meta.next_cursor;
      page += 1;

      if (page > 500) break;
    }

    if (collected.length > 0 || vi === filterVariants.length - 1) {
      return collected.slice(0, max);
    }
  }

  return [];
}
