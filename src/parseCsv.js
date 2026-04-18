/**
 * Minimal RFC4180-style CSV parser (handles quoted fields, commas, doubled quotes).
 * Supports multiline fields inside quotes.
 */
export function parseCsv(text) {
  const raw = String(text).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  while (i < raw.length) {
    const c = raw[i];
    if (inQuotes) {
      if (c === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  row.push(field);
  if (rows.length === 0 || row.some((cell) => cell !== "") || row.length > 1) {
    rows.push(row);
  }

  if (rows.length === 0) {
    return { headers: [], records: [] };
  }

  const headers = rows[0].map((h) => String(h).trim());
  const records = [];
  for (let r = 1; r < rows.length; r += 1) {
    const line = rows[r];
    if (line.every((c) => String(c).trim() === "")) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c] || `column_${c}`;
      obj[key] = line[c] != null ? String(line[c]) : "";
    }
    records.push(obj);
  }

  return { headers, records };
}
