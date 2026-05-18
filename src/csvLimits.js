/** Max data rows processed per upload (keeps extraction + snowball responsive). */
export const MAX_CSV_DATA_ROWS = 50;

/**
 * Max unique DOI/OpenAlex seeds passed to snowball. Each seed expands to many API calls;
 * uncapped CSVs could schedule 50+ seeds and run far longer than a small manual seed list.
 */
export const MAX_SNOWBALL_SEEDS = 12;

/**
 * @param {string[]} seedLines from extractSeedLinesFromImportedRows (stable order)
 */
export function applySnowballSeedCap(seedLines) {
  const totalUnique = seedLines.length;
  const limit = MAX_SNOWBALL_SEEDS;
  if (totalUnique <= limit) {
    return {
      seedLines,
      seedCap: {
        applied: false,
        limit,
        totalUnique,
        skipped: 0,
      },
    };
  }
  return {
    seedLines: seedLines.slice(0, limit),
    seedCap: {
      applied: true,
      limit,
      totalUnique,
      skipped: totalUnique - limit,
    },
  };
}

/**
 * @param {Record<string, string>[]} records Raw CSV record objects from parseCsv
 * @returns {{ records: typeof records; cap: object }}
 */
export function applyCsvRowCap(records, opts = {}) {
  const totalRowsInFile = records.length;
  const requestedStart = Math.max(1, Math.floor(Number(opts.rowStart) || 1));
  const requestedCount = Math.min(
    MAX_CSV_DATA_ROWS,
    Math.max(1, Math.floor(Number(opts.rowCount) || MAX_CSV_DATA_ROWS))
  );
  const limit = requestedCount;
  const startIndex = Math.min(totalRowsInFile, requestedStart - 1);
  const endExclusive = Math.min(totalRowsInFile, startIndex + requestedCount);
  const sliced = records.slice(startIndex, endExclusive);
  const processedCount = sliced.length;
  const startRow = processedCount > 0 ? startIndex + 1 : requestedStart;
  const endRow = processedCount > 0 ? startIndex + processedCount : requestedStart - 1;
  const skipped = Math.max(0, totalRowsInFile - processedCount);
  const applied =
    requestedStart !== 1 ||
    requestedCount !== MAX_CSV_DATA_ROWS ||
    totalRowsInFile > processedCount;

  return {
    records: sliced,
    cap: {
      applied,
      limit,
      requestedStart,
      requestedCount,
      startRow,
      endRow,
      processedCount,
      totalRowsInFile,
      skipped,
    },
  };
}
