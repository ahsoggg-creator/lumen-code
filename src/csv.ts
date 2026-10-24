/** Picks the delimiter of a CSV-like text from its first lines: comma, semicolon, tab or pipe. */
export function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/).filter(Boolean).slice(0, 5);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = head.map((l) => l.split(d).length - 1);
    const score = counts.length && counts.every((c) => c === counts[0]) ? counts[0]! : Math.min(...counts, 0);
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/** RFC 4180 parser: quoted fields, doubled quotes, line breaks inside quotes. `limit` caps the number of rows read. */
export function parseCsv(text: string, delim = detectDelimiter(text), limit = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < t.length && rows.length < limit; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if ((field !== '' || row.length) && rows.length < limit) { row.push(field); rows.push(row); }
  return rows;
}

/** Numbers compare as numbers, everything else as text; empty cells go last. */
export function compareCells(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  const x = Number(a), y = Number(b);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
}
