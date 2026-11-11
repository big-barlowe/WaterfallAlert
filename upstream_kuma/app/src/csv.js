// RFC 4180 CSV: quoted fields may contain commas, quotes ("") and newlines.

// -> [{ line, cells }], `line` being the 1-based line the record starts on.
export function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, ''); // Excel's UTF-8 BOM
  const records = [];
  let cells = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let i = 0;
  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    records.push({ line: start, cells });
    cells = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') endCell();
    else if (ch === '\n' || ch === '\r') {
      endRecord();
      if (ch === '\r' && src[i + 1] === '\n') i++;
      line++;
      start = line;
    } else cell += ch;
    i++;
  }
  if (quoted) throw new Error(`Line ${start}: a quoted value is never closed`);
  if (cell !== '' || cells.length) endRecord();
  return records;
}

const needsQuotes = /[",\r\n]|^\s|\s$/;

export function toCsv(rows) {
  const field = (v) => {
    const s = v == null ? '' : String(v);
    return needsQuotes.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // CRLF and a BOM so Excel opens it as UTF-8 (names with emoji, accents…)
  return `\uFEFF${rows.map((r) => r.map(field).join(',')).join('\r\n')}\r\n`;
}
