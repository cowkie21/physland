/* CSV: разбор (автоопределение ; или ,) и выгрузка (; + BOM — корректно открывается в Excel с кириллицей). */
(function (PL) {
  'use strict';
  // Защита от CSV-инъекций: ячейки, начинающиеся с = + - @, экранируются апострофом.
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s) && isNaN(s)) s = "'" + s;
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  PL.csv = {
    stringify: (cols, rows) => '\uFEFF' + [cols, ...rows].map(r => r.map(cell).join(';')).join('\r\n'),
    parse(text) {
      text = text.replace(/^\uFEFF/, '').trim();
      if (!text) return [];
      const head = text.split(/\r?\n/)[0];
      const d = (head.match(/;/g) || []).length ? ';' : ',';
      const rows = []; let row = [], f = '', q = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
        else if (c === '"') q = true;
        else if (c === d) { row.push(f); f = ''; }
        else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
        else f += c;
      }
      row.push(f); rows.push(row);
      const keys = rows.shift().map(s => s.trim());
      return rows.filter(r => r.some(x => x.trim())).map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()])));
    }
  };
})(window.PL = window.PL || {});
