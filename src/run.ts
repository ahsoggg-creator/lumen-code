import { app } from './app';
import { commands } from './commands';
import { docs, editors } from './editor';
import { ipc } from './ipc';
import { runInTerminal } from './panels';
import { cfg } from './settings';
import { ensureToolchain, langForPath, type LangDef } from './toolchains';
import { notify } from './ui';
import { basename, dirname, extname, join } from './util';
import { effectivePython } from './views/python';

async function hasFile(dir: string, name: string): Promise<boolean> { return ipc.exists(join(dir, name)); }

async function projectOverride(l: LangDef, dir: string): Promise<{ cmds: string[]; cwd: string } | null> {
  const roots = [dir, ...(app.root && app.root.toLowerCase() !== dir.toLowerCase() ? [app.root] : [])];
  for (const r of roots) {
    if (l.id === 'rust' && await hasFile(r, 'Cargo.toml')) return { cmds: ['cargo run'], cwd: r };
    if (l.id === 'go' && await hasFile(r, 'go.mod')) return { cmds: ['go run .'], cwd: r };
    if (l.id === 'csharp') {
      const entries = await ipc.readDir(r).catch(() => []);
      if (entries.some((e) => e.name.toLowerCase().endsWith('.csproj'))) return { cmds: ['dotnet run'], cwd: r };
    }
  }
  return null;
}

export function fill(t: string, vars: Record<string, string>): string {
  return t.replace(/\$\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/** Builds the command chain that runs a file; null when nothing is known for its type. */
export async function planRun(path: string): Promise<{ cmds: string[]; cwd: string; lang: LangDef | undefined } | null> {
  const ext = extname(path);
  const lang = langForPath(path);
  const user = cfg<Record<string, string | string[]>>('run.commands') ?? {};
  const dir = dirname(path);
  const name = basename(path).replace(/\.[^.]+$/, '');
  const vars: Record<string, string> = {
    file: path, dir, name, out: `${dir}\\${name}.exe`, class: name.replace(/[^A-Za-z0-9_]/g, '_'),
    python: lang?.id === 'python' ? await effectivePython() : 'python', workspace: app.root ?? dir,
  };
  const custom = user[ext] ?? (lang ? user[lang.id] : undefined);
  if (custom) return { cmds: (Array.isArray(custom) ? custom : [custom]).map((c) => fill(c, vars)), cwd: dir, lang };
  if (!lang?.run) return null;
  const proj = await projectOverride(lang, dir);
  if (proj) return { ...proj, lang };
  return { cmds: lang.run.map((c) => fill(c, vars)), cwd: dir, lang };
}

export const canRun = (path: string | null): boolean => !!path && !!(langForPath(path)?.run || langForPath(path)?.runKind);

export async function runCurrent(): Promise<void> {
  const d = editors.activeDoc();
  if (!d) { notify('Нет открытого файла', { kind: 'warn' }); return; }
  if (d.dirty || !d.path) { if (!(await docs.save(d))) return; }
  const path = d.path!;
  const lang = langForPath(path);
  if (lang?.runKind === 'browser') { await ipc.openPath(path); return; }
  if (lang?.id === 'markdown') { await commands.execute('markdown.preview'); return; }
  const plan = await planRun(path);
  if (!plan) { notify(`Для «${basename(path)}» нет способа запуска. Добавьте команду в настройку run.commands, например {"${extname(path) || 'ext'}": "программа \\"\${file}\\""}.`, { kind: 'warn', timeout: 9000 }); return; }
  if (plan.lang && !(await ensureToolchain(plan.lang, `Чтобы запустить «${basename(path)}», нужен ${plan.lang.name}.`))) return;
  await runInTerminal(plan.cmds, { name: 'Запуск', cwd: plan.cwd });
}

export function registerRun(): void {
  commands.register({ id: 'run.file', title: 'Запустить без отладки', category: 'Запуск', keybinding: 'ctrl+f5', run: () => runCurrent() });
  commands.register({ id: 'run.openInBrowser', title: 'Открыть файл в браузере', category: 'Запуск', run: () => { const d = editors.activeDoc(); if (d?.path) void ipc.openPath(d.path); } });
}
