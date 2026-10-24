import { compareCells, parseCsv } from './csv';
import { editors, registerFileViewer } from './editor';
import { errText, ipc } from './ipc';
import { confirmDialog, notify } from './ui';
import { basename, debounce, h } from './util';

const PAGE = 500;
const CSV_ROWS = 200_000;

interface Grid {
  columns: string[];
  rows: unknown[][];
  sort: { col: string; desc: boolean } | null;
  onSort?: (col: string) => void;
  /** Present when cells may be edited; resolves when the value is stored. */
  onEdit?: (row: number, col: number, value: string | null) => Promise<void>;
}

const show = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Cut-off long text and BLOB placeholders are display-only: writing them back would destroy the real value. */
const editable = (v: unknown): boolean => !(typeof v === 'string' && ((v.length > 20000 && v.endsWith('…')) || /^<BLOB \d+ Б>$/.test(v)));

function grid(g: Grid): HTMLElement {
  const head = h('tr', null, ...g.columns.map((c) => h('th', { onclick: () => g.onSort?.(c), title: c, class: g.onSort ? 'sortable' : '' },
    c, g.sort?.col === c ? (g.sort.desc ? ' ▼' : ' ▲') : '')));
  const body = h('tbody');
  g.rows.forEach((row, ri) => {
    const tr = h('tr');
    row.forEach((v, ci) => {
      const td = h('td', { class: v === null ? 'null' : typeof v === 'number' ? 'num' : '', title: show(v) }, v === null ? 'NULL' : show(v));
      if (g.onEdit && editable(v)) td.addEventListener('dblclick', () => edit(td, v, ri, ci));
      tr.append(td);
    });
    body.append(tr);
  });

  function edit(td: HTMLElement, old: unknown, ri: number, ci: number): void {
    const input = h('input.dbv-edit', { value: show(old), spellcheck: false });
    let done = false;
    const finish = async (commit: boolean, nul = false): Promise<void> => {
      if (done) return;
      done = true;
      if (commit && (nul ? old !== null : input.value !== show(old))) {
        try { await g.onEdit!(ri, ci, nul ? null : input.value); td.textContent = nul ? 'NULL' : input.value; td.className = nul ? 'null' : ''; return; } catch (e) { notify(errText(e), { kind: 'error' }); }
      }
      td.textContent = old === null ? 'NULL' : show(old);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void finish(true); else if (e.key === 'Escape') void finish(false); else if (e.key === 'Delete' && e.ctrlKey) void finish(true, true); });
    input.addEventListener('blur', () => void finish(true));
    td.replaceChildren(input);
    input.focus();
    input.select();
  }

  return h('div.dbv-grid', null, h('table', null, h('thead', null, head), body));
}

// ------------------------------------------------------------------ SQLite

function openSqlite(path: string): void {
  editors.openView({
    key: `db:${path.toLowerCase()}`, title: basename(path), icon: 'database',
    render(host) {
      let table = '';
      let filter = '';
      let sort: { col: string; desc: boolean } | null = null;
      let offset = 0;
      let total = 0;
      const tableSel = h('select.field', { onchange: () => { table = tableSel.value; sort = null; offset = 0; void load(); } });
      const filterIn = h('input.field', { placeholder: 'Фильтр по всем столбцам…', spellcheck: false, oninput: debounce(() => { filter = filterIn.value; offset = 0; void load(); }, 250) });
      const info = h('span.dim.small');
      const view = h('div.dbv-view');
      const prev = h('button.btn', { onclick: () => { offset = Math.max(0, offset - PAGE); void load(); } }, '‹');
      const next = h('button.btn', { onclick: () => { offset += PAGE; void load(); } }, '›');
      const sqlBox = h('textarea.dbv-sql', { placeholder: 'SELECT * FROM таблица WHERE …   (Ctrl+Enter — выполнить)', spellcheck: false, rows: 3 });
      const sqlOut = h('div.dbv-view');
      const sqlPanel = h('div.dbv-sqlpanel', null, sqlBox, h('div.dbv-bar', null, h('button.btn.primary', { onclick: () => void runSql() }, 'Выполнить'), h('span.dim.small', null, 'SELECT идёт в режиме «только чтение»; изменяющие запросы спросят подтверждение')), sqlOut);
      sqlPanel.style.display = 'none';
      sqlBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) void runSql(); });

      async function load(): Promise<void> {
        try {
          const p = await ipc.dbPage(path, table, filter, sort?.col ?? null, sort?.desc ?? false, PAGE, offset);
          total = p.total;
          info.textContent = `${total ? offset + 1 : 0}–${Math.min(total, offset + p.rows.length)} из ${total}${p.editable ? '' : ' · только чтение'}`;
          prev.disabled = offset === 0;
          next.disabled = offset + PAGE >= total;
          view.replaceChildren(grid({
            columns: p.columns, rows: p.rows, sort,
            onSort: (c) => { sort = sort?.col === c ? { col: c, desc: !sort.desc } : { col: c, desc: false }; offset = 0; void load(); },
            onEdit: p.editable ? (r, c, v) => ipc.dbUpdateCell(path, table, p.rowids[r]!, p.columns[c]!, v) : undefined,
          }));
        } catch (e) { view.replaceChildren(h('div.pad.dim', null, errText(e))); }
      }

      async function runSql(): Promise<void> {
        const sql = sqlBox.value.trim();
        if (!sql) return;
        try {
          const r = await ipc.dbQuery(path, sql, 2000);
          sqlOut.replaceChildren(h('div.dim.small.pad', null, `${r.rows.length} строк${r.truncated ? ' (показаны первые 2000)' : ''}`), grid({ columns: r.columns, rows: r.rows, sort: null }));
        } catch (e) {
          const msg = errText(e);
          if (!msg.includes('LUMEN_WRITE_REQUIRED')) { sqlOut.replaceChildren(h('div.pad.dim', null, msg)); return; }
          if (!(await confirmDialog('Изменить базу данных?', `Запрос меняет «${basename(path)}»:\n\n${sql.slice(0, 400)}\n\nОтменить это нельзя. Сделайте копию файла, если данные важны.`, 'Выполнить', true))) return;
          try { sqlOut.replaceChildren(h('div.pad', null, `Готово, изменено строк: ${await ipc.dbExec(path, sql)}`)); await load(); } catch (er) { sqlOut.replaceChildren(h('div.pad.dim', null, errText(er))); }
        }
      }

      host.append(h('div.dbv', null,
        h('div.dbv-bar', null, tableSel, filterIn, prev, next, info,
          h('button.btn', { onclick: () => { sqlPanel.style.display = sqlPanel.style.display === 'none' ? '' : 'none'; } }, 'SQL'),
          h('button.btn', { title: 'Перечитать', onclick: () => void load() }, '↻')),
        view, sqlPanel));

      void (async () => {
        try {
          const ts = await ipc.dbTables(path);
          if (!ts.length) { view.replaceChildren(h('div.pad.dim', null, 'В базе нет таблиц')); return; }
          tableSel.replaceChildren(...ts.map((t) => h('option', { value: t.name }, t.kind === 'view' ? `${t.name} (вид)` : t.name)));
          table = ts[0]!.name;
          await load();
        } catch (e) {
          // Not a SQLite file after all (a Thumbs.db, for instance): fall back to the normal opening.
          notify(`Не SQLite: ${errText(e)}`, { kind: 'warn' });
          void editors.openFile(path, { asText: true, preview: false });
        }
      })();
    },
  });
}

// ------------------------------------------------------------------ CSV / TSV

function openCsv(path: string): void {
  editors.openView({
    key: `csv:${path.toLowerCase()}`, title: basename(path), icon: 'table',
    render(host) {
      let all: string[][] = [];
      let header: string[] = [];
      let filter = '';
      let sort: { col: string; desc: boolean } | null = null;
      let offset = 0;
      const filterIn = h('input.field', { placeholder: 'Фильтр по всем столбцам…', spellcheck: false, oninput: debounce(() => { filter = filterIn.value.toLowerCase(); offset = 0; paint(); }, 200) });
      const info = h('span.dim.small');
      const view = h('div.dbv-view');
      const prev = h('button.btn', { onclick: () => { offset = Math.max(0, offset - PAGE); paint(); } }, '‹');
      const next = h('button.btn', { onclick: () => { offset += PAGE; paint(); } }, '›');
      const firstRowHeader = h('input', { type: 'checkbox', checked: true, onchange: () => { split(); paint(); } });
      let raw: string[][] = [];

      function split(): void {
        const hasHeader = (firstRowHeader as HTMLInputElement).checked;
        header = hasHeader ? raw[0] ?? [] : (raw[0] ?? []).map((_, i) => `Столбец ${i + 1}`);
        all = hasHeader ? raw.slice(1) : raw;
        const width = Math.max(header.length, ...all.slice(0, 200).map((r) => r.length));
        while (header.length < width) header.push(`Столбец ${header.length + 1}`);
      }

      function paint(): void {
        let rows = filter ? all.filter((r) => r.some((c) => c.toLowerCase().includes(filter))) : all;
        if (sort) {
          const i = header.indexOf(sort.col);
          const dir = sort.desc ? -1 : 1;
          rows = [...rows].sort((a, b) => dir * compareCells(a[i] ?? '', b[i] ?? ''));
        }
        info.textContent = `${rows.length ? offset + 1 : 0}–${Math.min(rows.length, offset + PAGE)} из ${rows.length}${raw.length >= CSV_ROWS ? ` · прочитаны первые ${CSV_ROWS}` : ''}`;
        prev.disabled = offset === 0;
        next.disabled = offset + PAGE >= rows.length;
        const page = rows.slice(offset, offset + PAGE).map((r) => header.map((_, i) => r[i] ?? ''));
        view.replaceChildren(grid({ columns: header, rows: page, sort, onSort: (c) => { sort = sort?.col === c ? { col: c, desc: !sort.desc } : { col: c, desc: false }; offset = 0; paint(); } }));
      }

      host.append(h('div.dbv', null,
        h('div.dbv-bar', null, filterIn, prev, next, info, h('label.check', null, firstRowHeader, 'Первая строка — заголовок'),
          h('button.btn', { onclick: () => void editors.openFile(path, { asText: true, preview: false }) }, 'Открыть как текст')),
        view));

      void (async () => {
        try {
          const data = await ipc.readFile(path);
          raw = parseCsv(data.content, undefined, CSV_ROWS);
          split();
          paint();
        } catch (e) { view.replaceChildren(h('div.pad.dim', null, errText(e))); }
      })();
    },
  });
}

export function registerDbView(): void {
  registerFileViewer({ match: (p) => /\.(sqlite3?|db3?|s3db)$/i.test(p), open: openSqlite });
  registerFileViewer({ match: (p) => /\.(csv|tsv)$/i.test(p), open: openCsv });
}
