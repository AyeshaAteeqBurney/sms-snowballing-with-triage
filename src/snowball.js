import {
  fetchCitingWorks,
  getWork,
  getWorksByIds,
  landingPageFromWork,
  oaUrlFromWork,
  referencedWorkIdsFromWork,
  resolveToWorkId,
  workIdFromObject,
} from "./openalex.js";

/** Resolve independent seeds in parallel batches (was strictly sequential). */
const SEED_RESOLVE_CONCURRENCY = 6;

/**
 * Beyond round 1 the frontier can explode (hundreds of parents). Expanding each
 * sequentially against OpenAlex can take many hours. We cap parents per round
 * and prioritize higher cited_by_count (from rows we already have).
 */
const MAX_FRONTIER_PER_ROUND = 100;

/** Bound parallel parent expansion (higher risks 429s; 3 is a stable default). */
const PARENT_EXPAND_CONCURRENCY = 3;

async function mapWithConcurrency(items, concurrency, fn) {
  if (!items.length) return;
  let cursor = 0;
  const n = Math.min(Math.max(1, concurrency), items.length);
  const worker = async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) break;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: n }, () => worker()));
}

function summarizeWorkRow(work, extras) {
  const id = workIdFromObject(work);
  const doi =
    work?.doi ||
    work?.ids?.doi?.replace?.("https://doi.org/", "") ||
    null;
  return {
    openalex_id: id,
    doi,
    title: work?.display_name || work?.title || "",
    year: work.publication_year ?? "",
    cited_by_count:
      typeof work?.cited_by_count === "number" ? work.cited_by_count : null,
    landing_url: landingPageFromWork(work),
    oa_url: oaUrlFromWork(work),
    ...extras,
  };
}

/**
 * Run backward + forward snowballing for resolved seed lines.
 *
 * @param {object} opts
 * @param {string[]} opts.seedLines raw DOIs / OpenAlex URLs / W-ids
 * @param {number} opts.maxRounds number of expansion rounds after seeds (1 = one hop from seeds only)
 * @param {number} opts.maxBackwardPerWork cap referenced works per seed work per round expansion
 * @param {number} opts.maxForwardPerWork cap citing works per seed work per round expansion
 * @param {string} [opts.mailto]
 */
export async function runSnowball(opts) {
  const {
    seedLines,
    maxRounds = 2,
    maxBackwardPerWork = 40,
    maxForwardPerWork = 60,
    mailto,
    signal,
    onProgress,
  } = opts;

  const expansionAudit = {
    seedLinesAttempted: seedLines.length,
    errors: [],
    rounds: [],
    frontierCaps: [],
    totals: {
      backwardRefIdsQueued: 0,
      backwardWorksResolved: 0,
      backwardUniqueAdded: 0,
      forwardWorksFetched: 0,
      forwardUniqueAdded: 0,
    },
  };

  /** @type {Map<string, any>} */
  const rowsById = new Map();
  /** @type {Map<string, number>} discovered round */
  const roundOf = new Map();

  const report = (msg, data = {}) =>
    onProgress?.({ phase: msg, ...data });

  /** @type {Set<string>} */
  const seeds = new Set();

  /** Last resolved DOI merge strategy (OpenAlex stubs vs canonical Work) */
  let doiResolveMeta = null;

  report("resolve_seeds_start", { count: seedLines.length });

  for (
    let batchStart = 0;
    batchStart < seedLines.length;
    batchStart += SEED_RESOLVE_CONCURRENCY
  ) {
    if (signal?.aborted) break;
    const batch = seedLines.slice(batchStart, batchStart + SEED_RESOLVE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((line) => resolveToWorkId(line, { mailto, signal }))
    );

    for (let j = 0; j < batch.length; j += 1) {
      if (signal?.aborted) break;
      const i = batchStart + j;
      const line = batch[j];
      const resolved = batchResults[j];
      report("seed_resolved", {
        line,
        ok: !!resolved.workId,
        idx: i + 1,
        total: seedLines.length,
      });
      if (!resolved.workId || !resolved.work) continue;

      if (resolved.source === "doi") {
        doiResolveMeta = {
          doi_resolution_via: resolved.doiResolution ?? null,
          doi_merge_candidates: resolved.doiCandidatesConsidered ?? null,
        };
      }

      seeds.add(resolved.workId);
      roundOf.set(resolved.workId, 0);

      let full = resolved.work;
      if (!full?.id || !Array.isArray(full.referenced_works)) {
        full = await getWork(resolved.workId, { mailto, signal });
      }
      rowsById.set(
        resolved.workId,
        summarizeWorkRow(full, {
          direction: "seed",
          parent_openalex_id: "",
          discovered_round: 0,
        })
      );
    }
  }

  if (rowsById.size === 0) {
    return {
      rows: [],
      audit: { seedsResolved: 0, roundsExecuted: 0 },
      frontierByRound: [],
    };
  }

  /** frontier at start of round r */
  let frontier = [...rowsById.keys()].filter((id) => roundOf.get(id) === 0);

  report("snowball_rounds_start", {
    frontier: frontier.length,
    maxRounds,
  });

  let roundsExecuted = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    if (signal?.aborted) break;
    roundsExecuted += 1;

    const discoveredThisRound = [];
    report("round_start", { round, frontierSize: frontier.length });

    const frontierTotal = frontier.length;
    let expandedFrontier = frontier;
    let capMeta = {
      applied: false,
      limit: MAX_FRONTIER_PER_ROUND,
      total: frontierTotal,
      expanded: frontierTotal,
      skipped: 0,
    };

    if (frontierTotal > MAX_FRONTIER_PER_ROUND) {
      expandedFrontier = [...frontier].sort((a, b) => {
        const ca = rowsById.get(a)?.cited_by_count ?? -1;
        const cb = rowsById.get(b)?.cited_by_count ?? -1;
        return cb - ca;
      }).slice(0, MAX_FRONTIER_PER_ROUND);
      capMeta = {
        applied: true,
        limit: MAX_FRONTIER_PER_ROUND,
        total: frontierTotal,
        expanded: expandedFrontier.length,
        skipped: frontierTotal - expandedFrontier.length,
      };
      expansionAudit.frontierCaps.push({ round, ...capMeta });
    }

    const nextFrontierSet = new Set();

    const roundAudit = {
      round,
      frontierTotal,
      frontierExpanded: expandedFrontier.length,
      frontierCap: capMeta.applied ? capMeta : null,
      parentsExpanded: expandedFrontier.length,
      backwardRefIdsQueued: 0,
      backwardWorksResolved: 0,
      backwardUniqueAdded: 0,
      forwardWorksFetched: 0,
      forwardUniqueAdded: 0,
    };

    let completedExpanded = 0;

    await mapWithConcurrency(
      expandedFrontier,
      PARENT_EXPAND_CONCURRENCY,
      async (parentId, fi) => {
        if (signal?.aborted) return;

        report("expand_work", {
          round,
          parentId,
          idx: fi + 1,
          total: expandedFrontier.length,
        });

        try {
        let parentWork;
        try {
          parentWork = await getWork(parentId, { mailto, signal });
        } catch (e) {
          expansionAudit.errors.push({
            scope: "getWork_parent",
            parentId,
            message: e.message || String(e),
          });
          return;
        }

        /* backward */
        let refIds = referencedWorkIdsFromWork(parentWork);
        refIds = refIds.slice(0, maxBackwardPerWork);
        roundAudit.backwardRefIdsQueued += refIds.length;
        expansionAudit.totals.backwardRefIdsQueued += refIds.length;

        const refWorks = await getWorksByIds(refIds, {
          mailto,
          signal,
          onProgress: ({ done, total }) =>
            report("backward_fetch", { parentId, done, total }),
        });

        roundAudit.backwardWorksResolved += refWorks.size;
        expansionAudit.totals.backwardWorksResolved += refWorks.size;

        for (const rid of refIds) {
          const w = refWorks.get(rid);
          if (!w) continue;
          const wid = workIdFromObject(w);
          if (!wid) continue;

          if (!rowsById.has(wid)) {
            rowsById.set(
              wid,
              summarizeWorkRow(w, {
                direction: "backward",
                parent_openalex_id: parentId,
                discovered_round: round,
              })
            );
            roundOf.set(wid, round);
            discoveredThisRound.push(wid);
            nextFrontierSet.add(wid);
            roundAudit.backwardUniqueAdded += 1;
            expansionAudit.totals.backwardUniqueAdded += 1;
          }
        }

        /* forward */
        let citing;
        try {
          citing = await fetchCitingWorks(parentId, {
            mailto,
            max: maxForwardPerWork,
            signal,
          });
        } catch (e) {
          citing = [];
          expansionAudit.errors.push({
            scope: "forward_cites",
            parentId,
            message: e.message || String(e),
          });
        }

        roundAudit.forwardWorksFetched += citing.length;
        expansionAudit.totals.forwardWorksFetched += citing.length;

        for (const w of citing) {
          const wid = workIdFromObject(w);
          if (!wid) continue;

          if (!rowsById.has(wid)) {
            rowsById.set(
              wid,
              summarizeWorkRow(w, {
                direction: "forward",
                parent_openalex_id: parentId,
                discovered_round: round,
              })
            );
            roundOf.set(wid, round);
            discoveredThisRound.push(wid);
            nextFrontierSet.add(wid);
            roundAudit.forwardUniqueAdded += 1;
            expansionAudit.totals.forwardUniqueAdded += 1;
          }
        }
        } catch (e) {
          expansionAudit.errors.push({
            scope: "expand_parent",
            parentId,
            message: e.message || String(e),
          });
        } finally {
          completedExpanded += 1;
          report("round_expand_progress", {
            round,
            completed: completedExpanded,
            total: expandedFrontier.length,
          });
        }
      }
    );

    expansionAudit.rounds.push(roundAudit);

    frontier = [...nextFrontierSet];
    report("round_done", {
      round,
      newUnique: discoveredThisRound.length,
      nextFrontier: frontier.length,
    });

    if (frontier.length === 0) break;
  }

  const rows = [...rowsById.values()].sort((a, b) => {
    const ra = a.discovered_round ?? 0;
    const rb = b.discovered_round ?? 0;
    if (ra !== rb) return ra - rb;
    return String(a.title).localeCompare(String(b.title));
  });

  let seedGraph = null;
  if (seeds.size === 1) {
    const only = [...seeds][0];
    try {
      const w = await getWork(only, { mailto, signal });
      seedGraph = {
        openalex_id: only,
        referenced_works_array_len: (w?.referenced_works || []).length,
        referenced_works_reported_count: w?.referenced_works_count ?? null,
        cited_by_count: w?.cited_by_count ?? null,
        ...(doiResolveMeta ? doiResolveMeta : {}),
      };
    } catch {
      seedGraph = { openalex_id: only };
    }
  }

  return {
    rows,
    audit: {
      seedsResolved: seeds.size,
      roundsExecuted,
      totalWorks: rows.length,
      expansion: expansionAudit,
      seedGraph,
    },
  };
}
