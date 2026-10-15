import { app, monaco } from '../app';
import { commands } from '../commands';
import { docs, editors } from '../editor';
import { agentsChanged, complete, pluginAgents, type PluginAgent } from '../ai/core';
import { icon } from '../icons';
import { errText, ipc, type ExecOut, type HttpReq } from '../ipc';
import { log, runInTerminal } from '../panels';
import { settings, cfg, contribute, type SettingDef } from '../settings';
import { shell } from '../shell';
import { addTheme, type Theme } from '../themes';
import { confirmDialog, dialog, inputBox, notify, quickPick, type PickItem } from '../ui';
import { h, join, parseJsonc, basename, type Disposable } from '../util';

export interface Manifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  main?: string;
  style?: string;
  permissions?: ('exec' | 'net' | 'fs')[];
  files?: string[];
  settings?: SettingDef[];
}

export interface PluginInfo {
  manifest: Manifest;
  dir: string | null;
  builtin: boolean;
  state: 'active' | 'disabled' | 'error' | 'inactive';
  error?: string;
}

interface Module { activate?: (api: unknown) => unknown; deactivate?: () => unknown }
interface Running { disposables: Disposable[]; mod: Module | null; styleEl?: HTMLStyleElement }

const plugins = new Map<string, PluginInfo>();
const running = new Map<string, Running>();
const builtins: { manifest: Manifest; activate: (api: LumenApi) => void | Promise<void> }[] = [];
const listeners = new Set<() => void>();
export const onPluginsChanged = (fn: () => void): void => { listeners.add(fn); };
const changed = (): void => listeners.forEach((f) => f());

export const listPlugins = (): PluginInfo[] => [...plugins.values()].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.manifest.name.localeCompare(b.manifest.name));

export function registerBuiltin(manifest: Manifest, activate: (api: LumenApi) => void | Promise<void>): void {
  builtins.push({ manifest: { ...manifest, permissions: manifest.permissions ?? [] }, activate });
}

const disabled = (): string[] => cfg<string[]>('plugins.disabled') ?? [];
const approvedKey = 'lumen.plugins.approved';
function approvedMap(): Record<string, string> { try { return JSON.parse(localStorage.getItem(approvedKey) ?? '{}') as Record<string, string>; } catch { return {}; } }
const permSig = (m: Manifest): string => `${m.version}:${(m.permissions ?? []).join(',')}`;

export type LumenApi = ReturnType<typeof makeApi>;

function makeApi(m: Manifest, track: (d: Disposable) => void, granted: Set<string>) {
  const need = (p: string) => { if (!granted.has(p)) throw new Error(`Плагину «${m.name}» не выдано разрешение «${p}» (укажите его в plugin.json → permissions)`); };
  const mo = monaco();
  const reg = <T extends Disposable>(d: T): T => { track(d); return d; };
  const storePath = join(app.paths.config, 'plugin-data', `${m.id}.json`);
  let store: Record<string, unknown> | null = null;
  const loadStore = async () => { if (!store) { try { store = JSON.parse((await ipc.readFile(storePath)).content) as Record<string, unknown>; } catch { store = {}; } } return store; };

  return {
    version: app.version,
    monaco: mo,
    ui: { h, icon },
    log: (msg: unknown) => log(m.name, typeof msg === 'string' ? msg : JSON.stringify(msg)),
    commands: {
      register(id: string, title: string, run: (...a: unknown[]) => unknown, opts: { keybinding?: string; category?: string } = {}): Disposable {
        return reg(commands.register({ id: `${m.id}.${id}`, title: `${opts.category ?? m.name}: ${title}`, keybinding: opts.keybinding, run: run as never }));
      },
      execute: (id: string, ...a: unknown[]) => commands.execute(id, ...a),
    },
    window: {
      info: (msg: string, ...actions: { label: string; run: () => void }[]) => notify(msg, { actions }),
      warn: (msg: string) => notify(msg, { kind: 'warn' }),
      error: (msg: string) => notify(msg, { kind: 'error' }),
      input: (o: { title?: string; value?: string; placeholder?: string }) => inputBox(o),
      pick: async <T,>(items: PickItem<T>[], o: { placeholder?: string } = {}) => (await quickPick(items, o))?.value,
      confirm: (msg: string, ok = 'OK') => confirmDialog(m.name, msg, ok),
      dialog: (title: string, body: string, buttons: string[]) => dialog(title, body, buttons.map((label, i) => ({ label, primary: i === buttons.length - 1 }))),
      status(o: { text?: string; tooltip?: string; icon?: string; align?: 'left' | 'right'; priority?: number; command?: string; onClick?: () => void }) {
        const it = shell.statusItem({ id: `${m.id}.status`, ...o, command: o.command });
        reg({ dispose: () => it.dispose() });
        return it;
      },
      openView(key: string, title: string, render: (host: HTMLElement) => void | (() => void), ic = 'puzzle') {
        editors.openView({ key: `${m.id}:${key}`, title, icon: ic, render });
      },
      addSidebarView(o: { id: string; title: string; icon?: string; render: (host: HTMLElement) => void | (() => void) }) {
        return reg(shell.registerView({ id: `${m.id}.${o.id}`, title: o.title, icon: o.icon ?? 'plug', order: 70, create: (host) => o.render(host) }));
      },
      openUntitled: (text: string, language = 'plaintext') => editors.newUntitled(text, language),
    },
    editor: {
      active() {
        const { doc, editor } = editors.active();
        if (!doc || !editor) return null;
        const sel = editor.getSelection();
        return { path: doc.path, language: doc.model.getLanguageId(), text: doc.model.getValue(), selectionText: sel && !sel.isEmpty() ? doc.model.getValueInRange(sel) : '', line: editor.getPosition()?.lineNumber ?? 1, column: editor.getPosition()?.column ?? 1 };
      },
      getEditor: () => editors.activeEditor(),
      insert(text: string) { const e = editors.activeEditor(); if (e) e.executeEdits(m.id, [{ range: e.getSelection()!, text, forceMoveMarkers: true }]); },
      replaceSelection(text: string) { const e = editors.activeEditor(); const s = e?.getSelection(); if (e && s) e.executeEdits(m.id, [{ range: s, text, forceMoveMarkers: true }]); },
      replaceAll(text: string) { const d = editors.activeDoc(); if (d) d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text }], () => null); },
      openFile: (path: string, o: { line?: number; col?: number } = {}) => editors.openFile(path, { line: o.line, col: o.col, preview: false }),
      onDidChangeActive: (fn: () => void) => reg(editors.activeChanged.on(() => fn())),
      onDidSave: (fn: (p: string | null) => void) => reg(docs.onSave.on((d) => fn(d.path))),
    },
    workspace: {
      get root() { return app.root; },
      onDidChangeRoot: (fn: (r: string | null) => void) => reg(app.rootChanged.on(fn)),
      onDidChangeFiles: (fn: (paths: string[]) => void) => reg(app.fsChanged.on(fn)),
      readFile: async (p: string) => (await ipc.readFile(p)).content,
      writeFile: (p: string, text: string) => { need('fs'); return ipc.writeFile(p, text); },
      list: (dir: string) => ipc.readDir(dir),
      findFiles: (root = app.root ?? '') => ipc.listFiles(root),
      exists: (p: string) => ipc.exists(p),
    },
    settings: {
      get: (k: string) => settings.get(k),
      set: (k: string, v: unknown) => settings.set(k, v),
      onChange: (fn: (keys: string[]) => void) => reg(settings.changed.on(fn)),
      contribute: (defs: SettingDef[]) => contribute(defs.map((d) => ({ ...d, key: d.key.includes('.') ? d.key : `${m.id}.${d.key}` }))),
    },
    storage: {
      get: async (k: string) => (await loadStore())[k],
      set: async (k: string, v: unknown) => { const s = await loadStore(); s[k] = v; await ipc.writeFile(storePath, JSON.stringify(s, null, 2)); },
    },
    terminal: { run: (cmd: string, o: { name?: string; cwd?: string } = {}) => { need('exec'); return runInTerminal(cmd, { name: o.name ?? m.name, cwd: o.cwd }); } },
    exec: (program: string, args: string[] = [], o: { cwd?: string; timeout?: number } = {}): Promise<ExecOut> => { need('exec'); return ipc.exec(program, args, o.cwd ?? app.root ?? undefined, o.timeout); },
    http: (req: HttpReq) => { need('net'); return ipc.http(req); },
    ai: {
      chat: (prompt: string, system = '') => complete(prompt, system),
      registerAgent(a: PluginAgent): Disposable {
        const id = `${m.id}.${a.id}`;
        pluginAgents.set(id, { ...a, id, name: a.name });
        agentsChanged.fire();
        return reg({ dispose: () => { pluginAgents.delete(id); agentsChanged.fire(); } });
      },
    },
    themes: { register: (t: Theme) => addTheme(t) },
  };
}

async function approve(m: Manifest): Promise<boolean> {
  const perms = m.permissions ?? [];
  if (!perms.length) return true;
  const map = approvedMap();
  if (map[m.id] === permSig(m)) return true;
  const desc: Record<string, string> = { exec: 'запускать программы и команды', net: 'обращаться к интернету', fs: 'записывать файлы' };
  const ok = await confirmDialog('Разрешения плагина', `Плагин «${m.name}» ${m.version}${m.author ? ` (${m.author})` : ''} запрашивает права: ${perms.map((p) => desc[p] ?? p).join(', ')}.\n\nПлагины выполняются с правами редактора. Включайте только тем, кому доверяете.`, 'Разрешить');
  if (ok) { map[m.id] = permSig(m); try { localStorage.setItem(approvedKey, JSON.stringify(map)); } catch { /* ignore */ } }
  return ok;
}

async function activate(info: PluginInfo, activateFn?: (api: LumenApi) => void | Promise<void>): Promise<void> {
  const m = info.manifest;
  if (running.has(m.id)) return;
  if (!(await approve(m))) { info.state = 'disabled'; changed(); return; }
  const run: Running = { disposables: [], mod: null };
  running.set(m.id, run);
  try {
    if (m.settings?.length) contribute(m.settings.map((d) => ({ ...d, key: d.key.includes('.') ? d.key : `${m.id}.${d.key}` })));
    const api = makeApi(m, (d) => run.disposables.push(d), new Set(m.permissions ?? []));
    if (activateFn) await activateFn(api);
    else if (info.dir) {
      if (m.style) {
        const css = (await ipc.readFile(join(info.dir, m.style))).content;
        run.styleEl = document.head.appendChild(h('style', { 'data-plugin': m.id }, css));
      }
      const src = (await ipc.readFile(join(info.dir, m.main ?? 'main.js'))).content;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      try {
        run.mod = (await import(/* @vite-ignore */ url)) as Module;
      } finally { URL.revokeObjectURL(url); }
      const ret = await run.mod.activate?.(api);
      if (typeof ret === 'function') run.disposables.push({ dispose: ret as () => void });
    }
    info.state = 'active';
    info.error = undefined;
    log('Lumen Code', `Плагин «${m.name}» ${m.version} запущен`);
  } catch (e) {
    info.state = 'error';
    info.error = errText(e);
    log('Lumen Code', `Плагин «${m.name}» не запустился: ${info.error}`);
    notify(`Плагин «${m.name}»: ${info.error}`, { kind: 'error' });
    await deactivate(m.id, false);
  }
  changed();
}

async function deactivate(id: string, notifyChange = true): Promise<void> {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  try { await r.mod?.deactivate?.(); } catch (e) { console.error(e); }
  for (const d of r.disposables.splice(0).reverse()) { try { d.dispose(); } catch { /* ignore */ } }
  r.styleEl?.remove();
  const info = plugins.get(id);
  if (info && info.state === 'active') info.state = 'inactive';
  if (notifyChange) changed();
}

export async function scanPlugins(): Promise<void> {
  for (const id of [...running.keys()]) await deactivate(id, false);
  plugins.clear();
  const off = new Set(disabled());
  for (const b of builtins) plugins.set(b.manifest.id, { manifest: b.manifest, dir: null, builtin: true, state: off.has(b.manifest.id) ? 'disabled' : 'inactive' });
  try {
    for (const e of await ipc.readDir(app.paths.plugins)) {
      if (!e.is_dir) continue;
      try {
        const m = parseJsonc<Manifest | null>((await ipc.readFile(join(e.path, 'plugin.json'))).content, null);
        if (!m?.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(m.id)) throw new Error('в plugin.json нет корректного id');
        if (plugins.has(m.id)) throw new Error(`id «${m.id}» уже занят`);
        plugins.set(m.id, { manifest: { ...m, name: m.name ?? m.id, version: m.version ?? '0.0.0' }, dir: e.path, builtin: false, state: off.has(m.id) ? 'disabled' : 'inactive' });
      } catch (err) {
        const id = `broken:${basename(e.path)}`;
        plugins.set(id, { manifest: { id, name: basename(e.path), version: '?' }, dir: e.path, builtin: false, state: 'error', error: errText(err) });
      }
    }
  } catch { /* plugins dir missing */ }
  for (const info of plugins.values()) {
    if (info.state !== 'inactive') continue;
    const b = builtins.find((x) => x.manifest.id === info.manifest.id);
    await activate(info, b?.activate);
  }
  changed();
}

export async function setEnabled(id: string, on: boolean): Promise<void> {
  const list = new Set(disabled());
  if (on) list.delete(id); else list.add(id);
  settings.set('plugins.disabled', [...list]);
  const info = plugins.get(id);
  if (!info) return;
  if (on) { info.state = 'inactive'; await activate(info, builtins.find((x) => x.manifest.id === id)?.activate); }
  else { await deactivate(id); info.state = 'disabled'; changed(); }
}

export async function removePlugin(id: string): Promise<void> {
  const info = plugins.get(id);
  if (!info?.dir) return;
  if (!(await confirmDialog('Удаление плагина', `Удалить «${info.manifest.name}»? Папка попадёт в корзину.`, 'Удалить', true))) return;
  await deactivate(id, false);
  await ipc.remove(info.dir, false);
  await scanPlugins();
}

export function rawBase(input: string): string {
  const s = input.trim().replace(/\/+$/, '');
  const gh = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/(?:tree\/[\w.-]+\/)?(.+))?$/.exec(s);
  if (gh && !s.startsWith('https://raw.') && !/^https?:\/\/(?!github\.com)/.test(s)) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/HEAD${gh[3] ? `/${gh[3]}` : ''}`;
  return s;
}

export async function installFromUrl(input: string): Promise<boolean> {
  const base = rawBase(input);
  const get = async (f: string): Promise<string> => {
    const r = await ipc.http({ url: `${base}/${f}` });
    if (r.status >= 400) throw new Error(`${f}: HTTP ${r.status}`);
    return r.body;
  };
  try {
    const m = parseJsonc<Manifest | null>(await get('plugin.json'), null);
    if (!m?.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(m.id)) throw new Error('некорректный plugin.json');
    if (!(await confirmDialog('Установка плагина', `Установить «${m.name}» ${m.version}${m.author ? ` от ${m.author}` : ''}?\nИсточник: ${base}\nПрава: ${(m.permissions ?? []).join(', ') || 'нет'}\n\nПлагин выполняется с правами редактора — ставьте только то, чему доверяете.`, 'Установить'))) return false;
    const dir = join(app.paths.plugins, m.id);
    await ipc.mkdir(dir);
    const files = [...new Set(['plugin.json', m.main ?? 'main.js', ...(m.style ? [m.style] : []), ...(m.files ?? [])])];
    for (const f of files) {
      if (f.includes('..') || f.startsWith('/') || f.includes(':')) throw new Error(`недопустимый путь ${f}`);
      await ipc.writeFile(join(dir, f), await get(f));
    }
    await scanPlugins();
    notify(`Плагин «${m.name}» установлен`);
    return true;
  } catch (e) {
    notify(`Не удалось установить: ${errText(e)}`, { kind: 'error' });
    return false;
  }
}

export async function installFromFolder(src: string): Promise<void> {
  try {
    const m = parseJsonc<Manifest | null>((await ipc.readFile(join(src, 'plugin.json'))).content, null);
    if (!m?.id) throw new Error('в папке нет корректного plugin.json');
    const dest = join(app.paths.plugins, m.id);
    if (await ipc.exists(dest)) { if (!(await confirmDialog('Плагин уже есть', `Заменить «${m.id}»?`, 'Заменить', true))) return; await ipc.remove(dest, false); }
    await ipc.copy(src, dest);
    await scanPlugins();
    notify(`Плагин «${m.name}» установлен`);
  } catch (e) { notify(errText(e), { kind: 'error' }); }
}

export async function createPlugin(): Promise<void> {
  const id = (await inputBox({ title: 'Идентификатор нового плагина', placeholder: 'my-plugin', validate: (v) => (/^[a-z0-9][a-z0-9-]*$/i.test(v) ? null : 'Только латиница, цифры и дефис') }))?.trim();
  if (!id) return;
  const dir = join(app.paths.plugins, id);
  if (await ipc.exists(dir)) { notify('Такой плагин уже есть', { kind: 'warn' }); return; }
  const manifest = { id, name: id, version: '0.1.0', description: 'Мой плагин', author: '', main: 'main.js', permissions: [] };
  const main = `// Плагин Lumen Code. Документация: https://github.com/ahsoggg-creator/lumen-code/blob/main/docs/PLUGINS.md
export function activate(lumen) {
  lumen.commands.register('hello', 'Сказать привет', () => {
    const ed = lumen.editor.active();
    lumen.window.info(ed ? \`Открыт файл: \${ed.path ?? 'без имени'}\` : 'Привет из плагина!');
  }, { keybinding: 'ctrl+alt+h' });

  const status = lumen.window.status({ text: '${id}', align: 'right' });
  status.update({ text: '${id} ✓' });
}

export function deactivate() {}
`;
  await ipc.mkdir(dir);
  await ipc.writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  await ipc.writeFile(join(dir, 'main.js'), main);
  await scanPlugins();
  await editors.openFile(join(dir, 'main.js'), { preview: false });
  notify('Плагин создан. Сохраните main.js и выполните «Плагины: перезагрузить».');
}

export interface RegistryEntry { id: string; name: string; description?: string; author?: string; repo: string; path?: string; version?: string }
export async function fetchRegistry(): Promise<RegistryEntry[]> {
  const r = await ipc.http({ url: cfg<string>('plugins.registry') });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(r.body) as RegistryEntry[];
}
