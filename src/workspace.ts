import { app } from './app';
import { editors } from './editor';
import { ipc, errText } from './ipc';
import { settings, cfg } from './settings';
import { shell } from './shell';
import { notify } from './ui';
import { debounce, hashStr, join, parseJsonc } from './util';

interface State { recent: string[]; lastRoot: string | null }
let state: State = { recent: [], lastRoot: null };
let statePath = '';

export const recentFolders = (): string[] => state.recent;

export async function initWorkspace(): Promise<void> {
  statePath = join(app.paths.config, 'state.json');
  try { state = { ...state, ...parseJsonc<Partial<State>>((await ipc.readFile(statePath)).content, {}) }; } catch { /* first run */ }
}

const saveState = debounce(() => { void ipc.writeFile(statePath, JSON.stringify(state, null, 2)).catch(() => undefined); }, 300);
export const lastRoot = (): string | null => state.lastRoot;

function sessionPath(root: string): string { return join(app.paths.config, 'sessions', `${hashStr(root.toLowerCase())}.json`); }

export const saveSession = debounce(() => {
  if (!app.root || !cfg('files.restoreSession')) return;
  void ipc.writeFile(sessionPath(app.root), JSON.stringify(editors.snapshot())).catch(() => undefined);
}, 800);

export async function openFolder(path: string | null, opts: { restore?: boolean } = {}): Promise<boolean> {
  if (app.root && path !== app.root) {
    saveSession();
    if (!(await editors.closeAll())) return false;
  }
  app.root = path;
  state.lastRoot = path;
  if (path) {
    state.recent = [path, ...state.recent.filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 12);
  }
  saveState();
  await settings.setWorkspace(path);
  try { await ipc.watch(path); } catch (e) { notify(`Слежение за файлами не запущено: ${errText(e)}`, { kind: 'warn' }); }
  shell.updateTitle();
  app.rootChanged.fire(path);
  if (path && opts.restore !== false && cfg('files.restoreSession')) {
    try {
      const s = JSON.parse((await ipc.readFile(sessionPath(path))).content) as ReturnType<typeof editors.snapshot>;
      await editors.restore(s);
    } catch { /* no saved session */ }
  }
  return true;
}

export async function pickAndOpenFolder(): Promise<void> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const dir = await open({ directory: true, multiple: false, title: 'Открыть папку' });
  if (typeof dir === 'string') await openFolder(dir);
}

export async function pickAndOpenFile(): Promise<void> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const f = await open({ multiple: true, directory: false, title: 'Открыть файл' });
  const list = Array.isArray(f) ? f : typeof f === 'string' ? [f] : [];
  for (const p of list) await editors.openFile(p, { preview: false });
}

export function removeRecent(path: string): void { state.recent = state.recent.filter((p) => p !== path); saveState(); }
