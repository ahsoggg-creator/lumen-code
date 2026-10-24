import { app } from './app';
import { editors } from './editor';
import { ipc, errText } from './ipc';
import { settings, cfg } from './settings';
import { shell } from './shell';
import { dialog, notify } from './ui';
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

const asked = new Set<string>();

/** Workspace Trust: a project's own settings may start programs only after the user agrees (otherwise those keys are ignored). */
export async function ensureTrust(): Promise<void> {
  const root = app.root;
  const keys = settings.pendingRestricted();
  if (!root || settings.isTrusted(root)) return;
  const rules: string[] = [];
  for (const rel of ['AGENTS.md', '.lumen\\rules.md']) if (await ipc.exists(join(root, rel)).catch(() => false)) rules.push(rel);
  if (!keys.length && !rules.length) return;
  const sig = `${root.toLowerCase()}|${keys.sort().join(',')}|${rules.join(',')}`;
  if (asked.has(sig)) return;
  asked.add(sig);
  const pick = await dialog('Доверять авторам этой папки?',
    `В «${root}» есть файлы, влияющие на запуск программ и поведение ИИ: ${[keys.length ? `.lumen/settings.json (${keys.join(', ')})` : '', ...rules].filter(Boolean).join('; ')}.

Если доверять, они смогут запускать программы на вашем ПК (языковые серверы, MCP, команды запуска) и менять подтверждения ИИ; правила проекта попадут в промпт агента. Для чужих репозиториев выбирайте «Ограниченный режим»: эти параметры и правила будут игнорироваться.`,
    [{ label: 'Ограниченный режим', primary: true }, { label: 'Доверять на этот сеанс' }, { label: 'Доверять всегда', danger: true }]);
  if (pick === 1 || pick === 2) settings.trust(root, pick === 2);
  else notify('Ограниченный режим: опасные параметры проекта игнорируются. Команда «Доверять этой папке» снимает ограничение.', { kind: 'warn' });
}

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
  await ensureTrust();
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
