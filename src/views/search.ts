import { app } from '../app';
import { commands } from '../commands';
import { docs, editors } from '../editor';
import { fileIconInfo, icon } from '../icons';
import { errText, ipc, type FileMatches, type SearchOpts } from '../ipc';
import { cfg } from '../settings';
import { shell } from '../shell';
import { notify, toggleBtn, confirmDialog } from '../ui';
import { basename, debounce, dirname, esc, h, relative } from '../util';

export function registerSearch(): void {
  let setQuery: (q: string, folder?: string) => void = () => undefined;
  shell.registerView({
    id: 'search', title: 'Поиск', icon: 'search', order: 20,
    create(host, api) {
      let caseS = false, word = false, regex = false, showReplace = false;
      let results: FileMatches[] = [];
      const collapsed = new Set<string>();
      const q = h('input.field', { placeholder: 'Найти', spellcheck: false });
      const rep = h('input.field', { placeholder: 'Заменить на', spellcheck: false });
      const inc = h('input.field', { placeholder: 'Включить: *.ts, src/**', spellcheck: false });
      const exc = h('input.field', { placeholder: 'Исключить: node_modules, dist', spellcheck: false });
      const status = h('div.search-status.dim.small');
      const tree = h('div.search-results');
      const replaceRow = h('div.replace-row', null, rep, h('button.icon-btn', { title: 'Заменить всё (Ctrl+Alt+Enter)', innerHTML: icon('check', 15), onclick: () => void replaceAll() }));
      replaceRow.style.display = 'none';
      const advanced = h('div.advanced', null, inc, exc);
      advanced.style.display = 'none';
      const toggles = h('span.field-toggles', null,
        toggleBtn('Aa', 'Учитывать регистр (Alt+C)', false, (v) => { caseS = v; run(); }),
        toggleBtn('ab', 'Слово целиком (Alt+W)', false, (v) => { word = v; run(); }),
        toggleBtn('.*', 'Регулярное выражение (Alt+R)', false, (v) => { regex = v; run(); }));
      const top = h('div.search-top', null,
        h('div.search-main', null,
          h('button.icon-btn.chev', { title: 'Режим замены', innerHTML: icon('chevronRight', 14), onclick: (e: Event) => { showReplace = !showReplace; replaceRow.style.display = showReplace ? '' : 'none'; (e.currentTarget as HTMLElement).style.transform = showReplace ? 'rotate(90deg)' : ''; } }),
          h('div.field-wrap', null, q, toggles)),
        replaceRow,
        h('button.link.small', { onclick: () => { advanced.style.display = advanced.style.display === 'none' ? '' : 'none'; } }, 'Фильтры файлов'),
        advanced, status);
      host.append(top, tree);

      const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x.includes('*') || x.includes('/') ? x : `**/${x}`));
      const opts = (): SearchOpts => ({ root: scopeRoot ?? app.root!, query: q.value, regex, case: caseS, word, include: split(inc.value), exclude: split(exc.value), max_results: cfg<number>('search.maxResults') });
      let scopeRoot: string | null = null;
      let seq = 0;

      async function search(): Promise<void> {
        if (!app.root || !q.value) { results = []; status.textContent = ''; tree.replaceChildren(); api.setBadge(null); return; }
        const mine = ++seq;
        status.textContent = 'Поиск…';
        try {
          const r = await ipc.search(opts());
          if (mine !== seq) return;
          results = r.files;
          const total = r.files.reduce((n, f) => n + f.matches.length, 0);
          status.textContent = total ? `${total} совпадений в ${r.files.length} файлах${r.truncated ? ' (показана часть)' : ''}${scopeRoot ? ` · в ${basename(scopeRoot)}` : ''}` : 'Ничего не найдено';
          api.setBadge(total || null);
          renderResults();
        } catch (e) {
          if (mine === seq) { status.textContent = errText(e); results = []; tree.replaceChildren(); }
        }
      }
      const run = debounce(() => void search(), 300);

      function renderResults(): void {
        const frag = document.createDocumentFragment();
        let shown = 0;
        for (const f of results) {
          const open = !collapsed.has(f.path);
          const ic = fileIconInfo(basename(f.path));
          frag.append(h('div.sr-file', { onclick: () => { if (collapsed.has(f.path)) collapsed.delete(f.path); else collapsed.add(f.path); renderResults(); } },
            h('span.tree-chev', { innerHTML: icon(open ? 'chevronDown' : 'chevronRight', 12) }),
            h('span', { class: `tree-ic c-${ic.color}`, innerHTML: icon(ic.icon, 14) }),
            h('span.sr-name', null, basename(f.path)),
            h('span.sr-dir', null, relative(app.root, dirname(f.path))),
            h('span.sr-count', null, String(f.matches.length)),
            showReplace ? h('button.icon-btn', { title: 'Заменить в файле', innerHTML: icon('check', 13), onclick: (e: Event) => { e.stopPropagation(); void replaceIn([f.path]); } }) : null));
          if (!open) continue;
          for (const m of f.matches) {
            if (++shown > 3000) break;
            const line = m.text;
            const lead = line.length - line.trimStart().length;
            const s = Math.max(0, m.col - 1 - lead);
            const text = line.trimStart();
            const before = esc(text.slice(Math.max(0, s - 24), s));
            const hit = esc(text.slice(s, s + m.len));
            const after = esc(text.slice(s + m.len, s + m.len + 80));
            const el = h('div.sr-match', { onclick: () => void editors.openFile(f.path, { line: m.line, col: m.col, endLine: m.line, endCol: m.col + m.len, preview: true }) });
            el.innerHTML = `<span class="sr-line">${m.line}</span><span class="sr-text">${before ? '…' : ''}${before}<mark>${hit}</mark>${after}</span>`;
            frag.append(el);
          }
        }
        tree.replaceChildren(frag);
      }

      async function replaceIn(files: string[]): Promise<void> {
        const o = opts();
        const dirty = files.filter((p) => docs.find(p)?.dirty);
        if (dirty.length) { notify('В выбранных файлах есть несохранённые правки — сохраните их и повторите.', { kind: 'warn' }); return; }
        try {
          const n = await ipc.replaceIn(o, rep.value, files);
          for (const p of files) { const d = docs.find(p); if (d) await docs.reload(d); }
          notify(`Заменено в файлах: ${n}`);
          await search();
        } catch (e) { notify(errText(e), { kind: 'error' }); }
      }

      async function replaceAll(): Promise<void> {
        if (!results.length) return;
        const total = results.reduce((n, f) => n + f.matches.length, 0);
        if (!(await confirmDialog('Заменить всё', `Заменить ${total} совпадений в ${results.length} файлах?`, 'Заменить', true))) return;
        await replaceIn(results.map((f) => f.path));
      }

      q.addEventListener('input', run);
      for (const el of [rep, inc, exc]) el.addEventListener('input', () => { if (el !== rep) run(); });
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { run.cancel(); void search(); } });
      rep.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey && e.altKey) void replaceAll(); });

      api.setActions([
        h('button.icon-btn', { title: 'Очистить', innerHTML: icon('x', 15), onclick: () => { q.value = ''; scopeRoot = null; void search(); } }),
        h('button.icon-btn', { title: 'Обновить', innerHTML: icon('refresh', 15), onclick: () => void search() }),
      ]);
      app.rootChanged.on(() => { scopeRoot = null; results = []; renderResults(); status.textContent = ''; });
      setQuery = (text, folder) => {
        scopeRoot = folder ?? null;
        if (text) q.value = text;
        q.focus();
        q.select();
        if (q.value) void search();
      };
    },
  });

  commands.register({
    id: 'search.focus', title: 'Поиск: найти в файлах', category: 'Поиск', keybinding: 'ctrl+shift+f',
    run: () => {
      shell.showView('search');
      const sel = editors.activeEditor();
      const text = sel && !sel.getSelection()?.isEmpty() ? sel.getModel()?.getValueInRange(sel.getSelection()!) ?? '' : '';
      setQuery(text.includes('\n') ? '' : text);
    },
  });
  commands.register({ id: 'search.inFolder', title: 'Поиск: найти в папке', run: (...a: never[]) => { shell.showView('search'); setQuery('', (a as unknown as string[])[0]); } });
}
