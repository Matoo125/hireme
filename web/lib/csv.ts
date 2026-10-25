// Minimal RFC 4180 CSV parsing for jobs.csv (quoted fields, "" escapes,
// newlines inside quotes).

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // ignore, \n handles the line break
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** CSV text → one object per row, keyed by the header, all values strings. */
export function parseRows(text: string): Record<string, string>[] {
  const [header, ...body] = parseCSV(text);
  if (!header) return [];
  return body.map((row) =>
    Object.fromEntries(header.map((key, i) => [key, row[i] ?? ""]))
  );
}
