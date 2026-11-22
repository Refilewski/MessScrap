function cell(value) {
  const text = String(value ?? '');
  // Spreadsheet applications may ignore leading whitespace before evaluating formulas.
  const guarded = /^[\s\uFEFF]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(text) ? "'" + text : text;
  return '"' + guarded.replaceAll('"', '""') + '"';
}

export function csvRow(values) {
  return values.map(cell).join(',') + '\r\n';
}
