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
export function applyCsvRowCap(records) {
  const totalRowsInFile = records.length;
  const limit = MAX_CSV_DATA_ROWS;

  if (totalRowsInFile <= limit) {
    return {
      records,
      cap: {
        applied: false,
        limit,
        totalRowsInFile,
        skipped: 0,
      },
    };
  }

  return {
    records: records.slice(0, limit),
    cap: {
      applied: true,
      limit,
      totalRowsInFile,
      skipped: totalRowsInFile - limit,
    },
  };
}
