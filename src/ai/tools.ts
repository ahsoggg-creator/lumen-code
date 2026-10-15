import { app, monaco } from '../app';
import { docs } from '../editor';
import { errText, ipc } from '../ipc';
import { cfg } from '../settings';
import { dirname, isUnder, join, norm, relative, key } from '../util';
import type { ToolDef } from './core';

export const TOOLS: ToolDef[] = [
  { name: 'read_file', description: 'Read a text file from the workspace. Optionally a line range (1-based, inclusive).', schema: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } },
  { name: 'list_dir', description: 'List files and folders in a workspace directory (use "." for the root).', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'search_text', description: 'Search the workspace for text or a regex. Returns file:line: text.', schema: { type: 'object', properties: { query: { type: 'string' }, regex: { type: 'boolean' }, include: { type: 'string', description: 'glob such as *.ts' } }, required: ['query'] } },
  { name: 'get_diagnostics', description: 'Get editor errors and warnings for a file (or all open files).', schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'edit_file', description: 'Replace one exact occurrence of old_text with new_text in a file. old_text must match exactly and be unique.', schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'write_file', description: 'Create a file or overwrite it with the given full content.', schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'run_command', description: 'Run a PowerShell command in the workspace and return its output (2 minute limit).', schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } },
];

export type Danger = 'read' | 'edit' | 'run';
export const dangerOf = (name: string): Danger => (name === 'edit_file' || name === 'write_file' ? 'edit' : name === 'run_command' ? 'run' : 'read');

export function needsApproval(name: string): boolean {
  const d = dangerOf(name);
  if (d === 'read') return !cfg('ai.autoApproveReads');
  if (d === 'edit') return !cfg('ai.autoApproveEdits');
  return !cfg('ai.autoApproveCommands');
}

function resolve(p: string): string {
  if (!app.root) throw new Error('Папка проекта не открыта');
  const abs = /^[a-z]:[\\/]/i.test(p) ? norm(p) : join(app.root, p === '.' ? '' : p);
  if (!isUnder(app.root, abs)) throw new Error('Путь вне рабочей папки запрещён');
  return norm(abs);
}

const clip = (s: string, n = 12000): string => (s.length > n ? `${s.slice(0, n)}\n… [обрезано, всего ${s.length} симв.]` : s);

export interface Preview { title: string; lines: { kind: '+' | '-' | ' '; text: string }[]; note?: string }

export async function previewTool(name: string, a: Record<string, unknown>): Promise<Preview> {
  if (name === 'run_command') return { title: 'Выполнить команду', lines: [{ kind: ' ', text: String(a.command ?? '') }], note: a.cwd ? `в папке ${a.cwd}` : undefined };
  const path = String(a.path ?? '');
  if (name === 'write_file') {
    const content = String(a.content ?? '');
    const exists = await ipc.exists(resolve(path)).catch(() => false);
    return { title: `${exists ? 'Перезаписать' : 'Создать'} ${path}`, lines: content.split('\n').slice(0, 40).map((t) => ({ kind: '+' as const, text: t })), note: `${content.split('\n').length} строк` };
  }
  const old = String(a.old_text ?? '').split('\n');
  const neu = String(a.new_text ?? '').split('\n');
  return { title: `Изменить ${path}`, lines: [...old.slice(0, 30).map((t) => ({ kind: '-' as const, text: t })), ...neu.slice(0, 30).map((t) => ({ kind: '+' as const, text: t }))] };
}

export async function runTool(name: string, a: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'read_file': {
        const p = resolve(String(a.path));
        const open = docs.find(p);
        const text = open ? open.model.getValue() : (await ipc.readFile(p)).content;
        const lines = text.split('\n');
        const s = Math.max(1, Number(a.start_line ?? 1));
        const e = Math.min(lines.length, Number(a.end_line ?? lines.length));
        return clip(lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join('\n'));
      }
      case 'list_dir': {
        const p = resolve(String(a.path || '.'));
        return (await ipc.readDir(p)).filter((e) => e.name !== '.git' && e.name !== 'node_modules').map((e) => (e.is_dir ? `${e.name}/` : e.name)).join('\n') || '(пусто)';
      }
      case 'search_text': {
        const r = await ipc.search({ root: app.root!, query: String(a.query), regex: !!a.regex, case: false, word: false, include: a.include ? [String(a.include).includes('*') ? String(a.include) : `**/${a.include}`] : [], exclude: [], max_results: 60 });
        const out: string[] = [];
        for (const f of r.files) for (const m of f.matches) out.push(`${relative(app.root, f.path)}:${m.line}: ${m.text.trim().slice(0, 200)}`);
        return out.slice(0, 60).join('\n') || 'Совпадений нет';
      }
      case 'get_diagnostics': {
        const mo = monaco();
        const only = a.path ? key(resolve(String(a.path))) : null;
        const ms = mo.editor.getModelMarkers({}).filter((m) => m.resource.scheme === 'file' && (!only || key(m.resource.fsPath) === only));
        return ms.slice(0, 80).map((m) => `${relative(app.root, m.resource.fsPath)}:${m.startLineNumber}:${m.startColumn} [${m.severity >= 8 ? 'error' : 'warning'}] ${m.message}`).join('\n') || 'Проблем нет';
      }
      case 'edit_file': {
        const p = resolve(String(a.path));
        const oldT = String(a.old_text);
        const newT = String(a.new_text);
        const open = docs.find(p);
        const text = open ? open.model.getValue() : (await ipc.readFile(p)).content;
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const norm2 = (s: string) => s.replace(/\r\n/g, '\n');
        const hay = norm2(text);
        const needle = norm2(oldT);
        const first = hay.indexOf(needle);
        if (!needle || first < 0) return 'Ошибка: old_text не найден в файле. Прочитайте файл заново и укажите точный фрагмент.';
        if (hay.indexOf(needle, first + 1) >= 0) return 'Ошибка: old_text встречается несколько раз. Добавьте больше контекста.';
        if (open) {
          const rawNeedle = needle.replace(/\n/g, eol);
          const rawFirst = text.indexOf(rawNeedle);
          if (rawFirst < 0) return 'Ошибка: фрагмент не найден (разные переводы строк).';
          const start = open.model.getPositionAt(rawFirst);
          const end = open.model.getPositionAt(rawFirst + rawNeedle.length);
          const mo = monaco();
          open.model.pushEditOperations([], [{ range: new mo.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: newT }], () => null);
          await docs.save(open);
        } else {
          const result = hay.slice(0, first) + norm2(newT) + hay.slice(first + needle.length);
          await ipc.writeFile(p, eol === '\r\n' ? result.replace(/\n/g, '\r\n') : result);
        }
        return `OK: изменён ${relative(app.root, p)}`;
      }
      case 'write_file': {
        const p = resolve(String(a.path));
        const open = docs.find(p);
        const content = String(a.content);
        if (open) { open.model.pushEditOperations([], [{ range: open.model.getFullModelRange(), text: content }], () => null); await docs.save(open); }
        else { await ipc.mkdir(dirname(p)); await ipc.writeFile(p, content); }
        return `OK: записан ${relative(app.root, p)} (${content.length} симв.)`;
      }
      case 'run_command': {
        const cwd = a.cwd ? resolve(String(a.cwd)) : app.root ?? undefined;
        const r = await ipc.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String(a.command)], cwd, 120000);
        return clip(`exit code: ${r.code}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`, 10000);
      }
      default:
        return `Неизвестный инструмент: ${name}`;
    }
  } catch (e) {
    return `Ошибка: ${errText(e)}`;
  }
}
