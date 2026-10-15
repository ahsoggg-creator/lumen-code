import { app } from '../app';
import { commands } from '../commands';
import { docs, editors } from '../editor';
import { gitState } from '../gitstate';
import { fileIconInfo, icon } from '../icons';
import { errText, ipc, type Entry } from '../ipc';
import { settings, cfg } from '../settings';
import { shell } from '../shell';
import { confirmDialog, notify, showMenu, type MenuItem } from '../ui';
import { basename, debounce, dirname, h, isUnder, join, key, norm } from '../util';

const ROW = 24;
type Row = { kind: 'entry'; e: Entry; depth: number } | { kind: 'new'; dir: string; isDir: boolean; depth: number } | { kind: 'rename'; e: Entry; depth: number };

export function registerExplorer(openFolder: () => void, recent: () => string[], openRecent: (p: string) => void): void {
  shell.registerView({
    id: 'explorer', title: 'Проводник', icon: 'files', order: 10,
    create(host, api) {
      const cache = new Map<string, Entry[]>();
      const expanded = new Set<string>();
      let selected = new Set<string>();
      let focus: string | null = null;
      let anchor: string | null = null;
      let rows: Row[] = [];
      let pending: Row | null = null;
      let clip: { paths: string[]; cut: boolean } | null = null;

      const empty = h('div.explorer-empty');
      const scroller = h('div.tree-scroll', { tabIndex: 0 });
      const spacer = h('div.tree-spacer');
      const layer = h('div.tree-layer');
      spacer.append(layer);
      scroller.append(spacer);
      host.append(scroller, empty);

      const excludes = () => new Set(cfg<string[]>('files.exclude').map((s) => s.toLowerCase()));

      async function load(dir: string): Promise<Entry[]> {
        try {
          const list = await ipc.readDir(dir);
          cache.set(key(dir), list);
          return list;
        } catch (e) {
          notify(errText(e), { kind: 'error' });
          return [];
        }
      }

      function buildRows(): void {
        rows = [];
        if (!app.root) return;
        const ex = excludes();
        const walk = (dir: string, depth: number) => {
          if (pending?.kind === 'new' && key(pending.dir) === key(dir)) rows.push({ ...pending, depth });
          for (const e of cache.get(key(dir)) ?? []) {
            if (ex.has(e.name.toLowerCase())) continue;
            if (pending?.kind === 'rename' && pending.e.path === e.path) rows.push({ kind: 'rename', e, depth });
            else rows.push({ kind: 'entry', e, depth });
            if (e.is_dir && expanded.has(key(e.path))) walk(e.path, depth + 1);
          }
        };
        walk(app.root, 0);
      }

      function render(): void {
        buildRows();
        spacer.style.height = `${rows.length * ROW}px`;
        paint();
      }

      function paint(): void {
        const top = scroller.scrollTop;
        const first = Math.max(0, Math.floor(top / ROW) - 8);
        const last = Math.min(rows.length, Math.ceil((top + scroller.clientHeight) / ROW) + 8);
        const frag = document.createDocumentFragment();
        for (let i = first; i < last; i++) frag.append(rowEl(rows[i]!, i));
        layer.replaceChildren(frag);
      }

      function rowEl(r: Row, i: number): HTMLElement {
        const base = h('div', { class: 'tree-row', style: `top:${i * ROW}px;padding-left:${8 + r.depth * 14}px` });
        if (r.kind === 'new' || r.kind === 'rename') {
          const isDir = r.kind === 'new' ? r.isDir : r.e.is_dir;
          const ic = isDir ? { icon: 'folder', color: 'blue' } : fileIconInfo(r.kind === 'rename' ? r.e.name : '');
          const input = h('input.tree-input', { value: r.kind === 'rename' ? r.e.name : '', spellcheck: false });
          base.append(h('span.tree-chev'), h('span', { class: `tree-ic c-${ic.color}`, innerHTML: icon(ic.icon, 15) }), input);
          queueMicrotask(() => {
            input.focus();
            if (r.kind === 'rename') { const dot = r.e.name.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 && !r.e.is_dir ? dot : r.e.name.length); }
          });
          let done = false;
          const finish = async (ok: boolean) => {
            if (done) return;
            done = true;
            const name = input.value.trim();
            const p = pending;
            pending = null;
            if (ok && name && p) {
              if (/[<>:"|?*]/.test(name) || name.includes('\\') && p.kind === 'rename') { notify('Недопустимое имя', { kind: 'error' }); }
              else if (p.kind === 'new') await createEntry(p.dir, name, p.isDir);
              else if (name !== p.e.name) await renameEntry(p.e, name);
            }
            render();
          };
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void finish(true); else if (e.key === 'Escape') void finish(false); e.stopPropagation(); });
          input.addEventListener('blur', () => void finish(!!input.value.trim()));
          return base;
        }
        const e = r.e;
        const isOpen = expanded.has(key(e.path));
        const ic = e.is_dir ? { icon: isOpen ? 'folderOpen' : 'folder', color: 'blue' } : fileIconInfo(e.name);
        const deco = gitState.deco(e.path, e.is_dir);
        base.dataset.path = e.path;
        base.classList.toggle('sel', selected.has(e.path));
        base.classList.toggle('focus', focus === e.path);
        if (deco) base.classList.add(deco.cls);
        base.draggable = true;
        base.append(
          h('span.tree-chev', { innerHTML: e.is_dir ? icon(isOpen ? 'chevronDown' : 'chevronRight', 13) : '' }),
          h('span', { class: `tree-ic c-${ic.color}`, innerHTML: icon(ic.icon, 15) }),
          h('span.tree-label', null, e.name),
          deco?.letter ? h('span.git-badge', { title: deco.title }, deco.letter) : deco ? h('span.git-dot', { title: deco.title }) : '');
        return base;
      }

      const rowAt = (target: EventTarget | null): Row | null => {
        const el = (target as HTMLElement | null)?.closest<HTMLElement>('.tree-row');
        if (!el?.dataset.path) return null;
        return rows.find((r) => r.kind === 'entry' && r.e.path === el.dataset.path) ?? null;
      };

      async function toggleDir(e: Entry): Promise<void> {
        const k = key(e.path);
        if (expanded.has(k)) expanded.delete(k);
        else { expanded.add(k); if (!cache.has(k)) await load(e.path); }
        render();
        saveExpanded();
      }

      function select(path: string, additive: boolean, range: boolean): void {
        if (range && anchor) {
          const paths = rows.filter((r): r is Extract<Row, { kind: 'entry' }> => r.kind === 'entry').map((r) => r.e.path);
          const a = paths.indexOf(anchor), b = paths.indexOf(path);
          if (a >= 0 && b >= 0) selected = new Set(paths.slice(Math.min(a, b), Math.max(a, b) + 1));
        } else if (additive) {
          if (selected.has(path)) selected.delete(path); else selected.add(path);
          anchor = path;
        } else { selected = new Set([path]); anchor = path; }
        focus = path;
        paint();
      }

      scroller.addEventListener('scroll', () => paint(), { passive: true });
      scroller.addEventListener('click', (ev) => {
        const r = rowAt(ev.target);
        if (!r || r.kind !== 'entry') return;
        select(r.e.path, ev.ctrlKey, ev.shiftKey);
        if (ev.ctrlKey || ev.shiftKey) return;
        if (r.e.is_dir) void toggleDir(r.e);
        else void editors.openFile(r.e.path, { preview: true });
      });
      scroller.addEventListener('dblclick', (ev) => {
        const r = rowAt(ev.target);
        if (r?.kind === 'entry' && !r.e.is_dir) void editors.openFile(r.e.path, { preview: false });
      });
      scroller.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const r = rowAt(ev.target);
        if (r?.kind === 'entry' && !selected.has(r.e.path)) select(r.e.path, false, false);
        showMenu(ev.clientX, ev.clientY, menuFor(r?.kind === 'entry' ? r.e : null));
      });
      scroller.addEventListener('keydown', (ev) => {
        if (ev.target instanceof HTMLInputElement) return;
        const entries = rows.filter((r): r is Extract<Row, { kind: 'entry' }> => r.kind === 'entry');
        const idx = entries.findIndex((r) => r.e.path === focus);
        const cur = entries[idx]?.e;
        const move = (d: number) => { const n = entries[Math.max(0, Math.min(entries.length - 1, (idx < 0 ? 0 : idx + d)))]; if (n) { select(n.e.path, false, ev.shiftKey); ensureVisible(n.e.path); } };
        if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
        else if (ev.key === 'ArrowRight' && cur?.is_dir) { ev.preventDefault(); if (!expanded.has(key(cur.path))) void toggleDir(cur); else move(1); }
        else if (ev.key === 'ArrowLeft' && cur) { ev.preventDefault(); if (cur.is_dir && expanded.has(key(cur.path))) void toggleDir(cur); else { const p = dirname(cur.path); if (entries.some((r) => r.e.path === p)) { select(p, false, false); ensureVisible(p); } } }
        else if (ev.key === 'Enter' && cur) { ev.preventDefault(); if (cur.is_dir) void toggleDir(cur); else void editors.openFile(cur.path, { preview: false }); }
        else if (ev.key === 'F2' && cur) { ev.preventDefault(); startRename(cur); }
        else if (ev.key === 'Delete' && selected.size) { ev.preventDefault(); void deleteSelected(ev.shiftKey); }
        else if (ev.ctrlKey && ev.key.toLowerCase() === 'c') { clip = { paths: [...selected], cut: false }; }
        else if (ev.ctrlKey && ev.key.toLowerCase() === 'x') { clip = { paths: [...selected], cut: true }; }
        else if (ev.ctrlKey && ev.key.toLowerCase() === 'v') { void paste(cur?.is_dir ? cur.path : cur ? dirname(cur.path) : app.root!); }
      });

      // drag & drop (moves inside the tree)
      let dragPaths: string[] = [];
      scroller.addEventListener('dragstart', (ev) => {
        const r = rowAt(ev.target);
        if (r?.kind !== 'entry') return;
        dragPaths = selected.has(r.e.path) ? [...selected] : [r.e.path];
        ev.dataTransfer?.setData('text/plain', dragPaths.join('\n'));
        ev.dataTransfer!.effectAllowed = 'move';
      });
      scroller.addEventListener('dragover', (ev) => {
        if (!dragPaths.length) return;
        const r = rowAt(ev.target);
        ev.preventDefault();
        layer.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop'));
        (ev.target as HTMLElement).closest('.tree-row')?.classList.toggle('drop', r?.kind === 'entry' && r.e.is_dir);
      });
      scroller.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        const r = rowAt(ev.target);
        const dest = r?.kind === 'entry' ? (r.e.is_dir ? r.e.path : dirname(r.e.path)) : app.root;
        const paths = dragPaths;
        dragPaths = [];
        if (!dest) return;
        for (const p of paths) {
          if (isUnder(p, dest) || key(dirname(p)) === key(dest)) continue;
          await moveEntry(p, join(dest, basename(p)));
        }
        await refreshAll();
      });
      scroller.addEventListener('dragend', () => { dragPaths = []; layer.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); });

      function ensureVisible(path: string): void {
        const i = rows.findIndex((r) => r.kind === 'entry' && r.e.path === path);
        if (i < 0) return;
        if (i * ROW < scroller.scrollTop) scroller.scrollTop = i * ROW;
        else if ((i + 1) * ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = (i + 1) * ROW - scroller.clientHeight;
        paint();
      }

      function targetDir(e: Entry | null): string {
        if (e) return e.is_dir ? e.path : dirname(e.path);
        const f = focus && rows.find((r) => r.kind === 'entry' && r.e.path === focus);
        if (f && f.kind === 'entry') return f.e.is_dir ? f.e.path : dirname(f.e.path);
        return app.root!;
      }

      async function startNew(isDir: boolean, e: Entry | null = null): Promise<void> {
        if (!app.root) return;
        const dir = targetDir(e);
        expanded.add(key(dir));
        if (!cache.has(key(dir))) await load(dir);
        pending = { kind: 'new', dir, isDir, depth: 0 };
        shell.showView('explorer');
        render();
      }

      function startRename(e: Entry): void { pending = { kind: 'rename', e, depth: 0 }; render(); }

      async function createEntry(dir: string, name: string, isDir: boolean): Promise<void> {
        const full = join(dir, name);
        try {
          if (await ipc.exists(full)) { notify(`«${name}» уже существует`, { kind: 'warn' }); return; }
          if (isDir) await ipc.mkdir(full); else await ipc.writeFile(full, '');
          await load(dir);
          if (!isDir) void editors.openFile(full, { preview: false });
        } catch (e) { notify(errText(e), { kind: 'error' }); }
      }

      async function moveEntry(from: string, to: string): Promise<void> {
        try {
          await ipc.rename(from, to);
          editors.rename(from, to);
        } catch (e) { notify(errText(e), { kind: 'error' }); }
      }

      async function renameEntry(e: Entry, name: string): Promise<void> {
        await moveEntry(e.path, join(dirname(e.path), name));
        await load(dirname(e.path));
        if (e.is_dir) { cache.delete(key(e.path)); }
      }

      async function deleteSelected(permanent: boolean): Promise<void> {
        const list = [...selected];
        if (!list.length) return;
        if (cfg('files.confirmDelete')) {
          const msg = list.length === 1 ? `Удалить «${basename(list[0]!)}»? ${permanent ? 'Это необратимо.' : 'Файл попадёт в корзину.'}` : `Удалить выбранные элементы (${list.length})?`;
          if (!(await confirmDialog('Удаление', msg, 'Удалить', true))) return;
        }
        for (const p of list) {
          try { await ipc.remove(p, permanent); editors.removed(p); } catch (e) { notify(errText(e), { kind: 'error' }); }
        }
        selected.clear();
        await refreshAll();
      }

      async function paste(dir: string): Promise<void> {
        if (!clip) return;
        for (const src of clip.paths) {
          let dest = join(dir, basename(src));
          if (key(dest) === key(src) && clip.cut) continue;
          for (let n = 1; await ipc.exists(dest); n++) {
            const b = basename(src);
            const dot = b.lastIndexOf('.');
            dest = join(dir, dot > 0 ? `${b.slice(0, dot)} (копия${n > 1 ? ` ${n}` : ''})${b.slice(dot)}` : `${b} (копия${n > 1 ? ` ${n}` : ''})`);
          }
          try {
            if (clip.cut) await moveEntry(src, dest); else await ipc.copy(src, dest);
          } catch (e) { notify(errText(e), { kind: 'error' }); }
        }
        if (clip.cut) clip = null;
        await refreshAll();
      }

      function menuFor(e: Entry | null): MenuItem[] {
        const dirTarget = targetDir(e);
        const items: MenuItem[] = [
          { label: 'Новый файл…', icon: 'filePlus', run: () => void startNew(false, e) },
          { label: 'Новая папка…', icon: 'folderPlus', run: () => void startNew(true, e) },
          { separator: true },
        ];
        if (e) {
          items.push(
            { label: 'Открыть', disabled: e.is_dir, run: () => void editors.openFile(e.path, { preview: false }) },
            { label: 'Показать в проводнике Windows', run: () => void ipc.reveal(e.path) },
            { label: 'Открыть в терминале', run: () => void commands.execute('terminal.newAt', e.is_dir ? e.path : dirname(e.path)) },
            { label: 'Найти в папке…', run: () => void commands.execute('search.inFolder', e.is_dir ? e.path : dirname(e.path)) },
            { separator: true },
            { label: 'Вырезать', keybinding: 'ctrl+x', run: () => { clip = { paths: [...selected], cut: true }; } },
            { label: 'Копировать', keybinding: 'ctrl+c', run: () => { clip = { paths: [...selected], cut: false }; } },
          );
        }
        items.push({ label: 'Вставить', keybinding: 'ctrl+v', disabled: !clip, run: () => void paste(dirTarget) });
        if (e) {
          items.push(
            { separator: true },
            { label: 'Копировать путь', run: () => void navigator.clipboard.writeText(e.path) },
            { label: 'Копировать относительный путь', run: () => void navigator.clipboard.writeText(app.root ? e.path.slice(norm(app.root).length + 1) : e.path) },
            { separator: true },
            { label: 'Переименовать…', keybinding: 'f2', run: () => startRename(e) },
            { label: 'Удалить', keybinding: 'delete', run: () => void deleteSelected(false) },
          );
        }
        return items;
      }

      async function refreshAll(): Promise<void> {
        if (!app.root) return;
        const dirs = [app.root, ...[...expanded].map((k) => [...cache.keys()].includes(k) ? k : null).filter((x): x is string => !!x)];
        await Promise.all(dirs.map((d) => load(d)));
        render();
      }

      const reloadChanged = debounce(async (paths: string[]) => {
        if (!app.root) return;
        const ex = new Set<string>();
        for (const p of paths) {
          const parent = key(dirname(p));
          if (cache.has(parent)) ex.add(parent);
          const self = key(p);
          if (cache.has(self) && !paths.some((q) => key(q) === self)) ex.add(self);
        }
        if (!ex.size) return;
        const real = new Map<string, string>();
        for (const p of paths) real.set(key(dirname(p)), dirname(p));
        await Promise.all([...ex].map((k) => load(real.get(k) ?? k)));
        render();
      }, 200);

      app.fsChanged.on((p) => reloadChanged(p));
      gitState.changed.on(() => paint());
      settings.changed.on((k) => { if (k.includes('files.exclude')) render(); });

      function saveExpanded(): void {
        if (app.root) try { localStorage.setItem(`lumen.expanded.${key(app.root)}`, JSON.stringify([...expanded])); } catch { /* ignore */ }
      }

      async function setRoot(root: string | null): Promise<void> {
        cache.clear();
        expanded.clear();
        selected.clear();
        pending = null;
        focus = null;
        if (!root) {
          scroller.style.display = 'none';
          empty.style.display = '';
          empty.replaceChildren(
            h('div.dim', null, 'Папка не открыта'),
            h('button.btn.primary', { onclick: openFolder }, 'Открыть папку'),
            recent().length ? h('div.recent', null, h('div.dim.small', null, 'Недавние'), ...recent().slice(0, 6).map((p) => h('button.link', { title: p, onclick: () => openRecent(p) }, basename(p)))) : '');
          api.setActions([]);
          rows = [];
          return;
        }
        scroller.style.display = '';
        empty.style.display = 'none';
        try { for (const k of JSON.parse(localStorage.getItem(`lumen.expanded.${key(root)}`) ?? '[]') as string[]) expanded.add(k); } catch { /* ignore */ }
        await load(root);
        await Promise.all([...expanded].map(async (k) => { const real = k; if (!cache.has(real)) await load(real); }));
        render();
        api.setActions([
          h('button.icon-btn', { title: 'Новый файл', innerHTML: icon('filePlus', 15), onclick: () => void startNew(false) }),
          h('button.icon-btn', { title: 'Новая папка', innerHTML: icon('folderPlus', 15), onclick: () => void startNew(true) }),
          h('button.icon-btn', { title: 'Обновить', innerHTML: icon('refresh', 15), onclick: () => void refreshAll() }),
          h('button.icon-btn', { title: 'Свернуть всё', innerHTML: icon('collapse', 15), onclick: () => { expanded.clear(); saveExpanded(); render(); } }),
        ]);
      }

      async function reveal(path: string): Promise<void> {
        if (!app.root || !isUnder(app.root, path)) return;
        let dir = dirname(path);
        const chain: string[] = [];
        while (isUnder(app.root, dir) && key(dir) !== key(app.root)) { chain.unshift(dir); dir = dirname(dir); }
        for (const d of chain) { expanded.add(key(d)); if (!cache.has(key(d))) await load(d); }
        render();
        focus = path;
        selected = new Set([path]);
        ensureVisible(path);
        paint();
      }

      app.rootChanged.on((r) => void setRoot(r));
      app.revealRequest.on((p) => { shell.showView('explorer'); void reveal(p); });
      commands.register({ id: 'explorer.newFile', title: 'Проводник: новый файл', run: () => startNew(false) });
      commands.register({ id: 'explorer.newFolder', title: 'Проводник: новая папка', run: () => startNew(true) });
      commands.register({ id: 'explorer.refresh', title: 'Проводник: обновить', run: () => refreshAll() });
      commands.register({ id: 'explorer.revealActive', title: 'Проводник: показать открытый файл', run: () => { const d = editors.activeDoc(); if (d?.path) app.revealRequest.fire(d.path); } });
      commands.register({ id: 'explorer.rename', title: 'Проводник: переименовать', keybinding: 'f2', when: () => document.activeElement === scroller, run: () => { const r = rows.find((x) => x.kind === 'entry' && x.e.path === focus); if (r?.kind === 'entry') startRename(r.e); } });
      docs.onSave.on((d) => { if (d.path) reloadChanged([d.path]); });
      void setRoot(app.root);
    },
  });
}
