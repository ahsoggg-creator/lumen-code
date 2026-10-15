import { app } from './app';
import { bindingFor, commands } from './commands';
import { editors } from './editor';
import { fileIconInfo } from './icons';
import { ipc } from './ipc';
import { settings, cfg } from './settings';
import { allThemes } from './themes';
import { quickPick, type PickItem } from './ui';
import { basename, dirname, fuzzyScore, key, relative } from './util';

let fileCache: { root: string; files: string[] } | null = null;
const mruFiles: string[] = [];
const mruCommands: string[] = (() => { try { return JSON.parse(localStorage.getItem('lumen.mruCommands') ?? '[]') as string[]; } catch { return []; } })();

export function touchFile(path: string): void {
  const i = mruFiles.findIndex((p) => key(p) === key(path));
  if (i >= 0) mruFiles.splice(i, 1);
  mruFiles.unshift(path);
  if (mruFiles.length > 40) mruFiles.pop();
}

async function files(): Promise<string[]> {
  if (!app.root) return [];
  if (!fileCache || fileCache.root !== app.root) fileCache = { root: app.root, files: await ipc.listFiles(app.root, 60000).catch(() => []) };
  return fileCache.files;
}

function commandItems(query: string): PickItem<string>[] {
  const all = commands.all().filter((c) => !c.hidden && (!c.when || c.when()));
  const items = all.map((c) => ({ label: c.category ? `${c.category}: ${c.title.replace(new RegExp(`^${c.category}:\\s*`), '')}` : c.title, value: c.id, keybinding: bindingFor(c.id), icon: undefined as string | undefined }));
  if (!query) {
    const rank = (id: string) => { const i = mruCommands.indexOf(id); return i < 0 ? 999 : i; };
    return items.sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label));
  }
  return items.map((i) => ({ i, s: fuzzyScore(query, i.label) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.i);
}

async function fileItems(query: string): Promise<PickItem<string>[]> {
  const all = await files();
  const open = editors.openDocs().map((d) => d.path).filter((p): p is string => !!p);
  const toItem = (p: string): PickItem<string> => ({ label: basename(p), description: relative(app.root, dirname(p)) === dirname(p) ? dirname(p) : relative(app.root, dirname(p)), value: p, icon: fileIconInfo(basename(p)).icon });
  if (!query) {
    const seen = new Set<string>();
    const ordered = [...mruFiles, ...open].filter((p) => { const k = key(p); if (seen.has(k)) return false; seen.add(k); return true; });
    return ordered.slice(0, 30).map(toItem);
  }
  const rel = (p: string) => relative(app.root, p);
  return all.map((p) => ({ p, s: fuzzyScore(query, rel(p)) * (open.some((o) => key(o) === key(p)) ? 1.3 : 1) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 100).map((x) => toItem(x.p));
}

export async function openPalette(initial = ''): Promise<void> {
  const pick = await quickPick<string>([], {
    value: initial,
    placeholder: 'Файл для открытия… (> команды, : строка, @ символы)',
    filter: false,
    provider: async (q) => {
      if (q.startsWith('>')) return commandItems(q.slice(1).trim());
      if (q.startsWith(':')) {
        const n = parseInt(q.slice(1), 10);
        return [{ label: Number.isFinite(n) ? `Перейти к строке ${n}` : 'Введите номер строки', value: `\0line:${n}` }];
      }
      if (q.startsWith('@')) return [{ label: 'Открыть список символов файла…', value: '\0symbols', icon: 'list' }];
      return fileItems(q.trim());
    },
  });
  if (!pick) return;
  const v = pick.value;
  if (v.startsWith('\0line:')) { const n = parseInt(v.slice(6), 10); if (n > 0) editors.reveal(n); return; }
  if (v === '\0symbols') { editors.activeEditor()?.trigger('palette', 'editor.action.quickOutline', null); return; }
  if (commands.get(v)) {
    const i = mruCommands.indexOf(v);
    if (i >= 0) mruCommands.splice(i, 1);
    mruCommands.unshift(v);
    try { localStorage.setItem('lumen.mruCommands', JSON.stringify(mruCommands.slice(0, 30))); } catch { /* ignore */ }
    await commands.execute(v);
    return;
  }
  await editors.openFile(v, { preview: false });
}

export function registerPalette(): void {
  app.fsChanged.on((paths) => { if (fileCache && paths.some((p) => !p.includes('\\.git\\'))) fileCache = null; });
  app.rootChanged.on(() => { fileCache = null; });
  editors.activeChanged.on(() => { const d = editors.activeDoc(); if (d?.path) touchFile(d.path); });

  commands.register({ id: 'palette.commands', title: 'Палитра команд', category: 'Вид', keybinding: 'ctrl+shift+p', inTerminal: true, run: () => openPalette('>') });
  commands.register({ id: 'palette.commands2', title: 'Палитра команд (F1)', hidden: true, keybinding: 'f1', inTerminal: true, run: () => openPalette('>') });
  commands.register({ id: 'palette.quickOpen', title: 'Перейти к файлу…', category: 'Переход', keybinding: 'ctrl+p', inTerminal: true, run: () => openPalette('') });
  commands.register({ id: 'palette.gotoLine', title: 'Перейти к строке…', category: 'Переход', keybinding: 'ctrl+g', run: () => openPalette(':') });
  commands.register({ id: 'palette.symbols', title: 'Перейти к символу в файле…', category: 'Переход', keybinding: 'ctrl+shift+o', run: () => editors.activeEditor()?.trigger('palette', 'editor.action.quickOutline', null) });

  commands.register({
    id: 'workbench.pickTheme', title: 'Выбрать цветовую тему', category: 'Вид', keybinding: 'ctrl+k ctrl+t',
    run: async () => {
      const original = cfg<string>('workbench.theme');
      const pick = await quickPick(allThemes().map((t) => ({ label: t.name, description: t.dark ? 'тёмная' : 'светлая', value: t.id, icon: t.dark ? 'moon' : 'sun' })), {
        placeholder: 'Тема (стрелками — предпросмотр)', filter: false,
        onPreview: (it) => { settings.set('workbench.theme', it ? it.value : original); },
      });
      settings.set('workbench.theme', pick ? pick.value : original);
    },
  });
}
