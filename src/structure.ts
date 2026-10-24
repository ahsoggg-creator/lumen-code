import { app } from './app';
import { commands } from './commands';
import { editors } from './editor';
import { errText, ipc } from './ipc';
import { confirmDialog, inputBox, notify, quickPick, type PickItem } from './ui';
import { extname, relative } from './util';

const BY_EXT: Record<string, string> = { py: 'python', pyw: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', rs: 'rust', go: 'go', lua: 'lua' };

/** tree-sitter language for a file path, or null when there is no grammar for it. */
export const astLangOf = (path: string): string | null => BY_EXT[extname(path)] ?? null;

/** Signatures of a file's classes, functions and types: a far cheaper context for the AI than the whole text. */
export async function outlineText(path: string, text: string): Promise<string | null> {
  const lang = astLangOf(path);
  if (!lang) return null;
  try {
    const sigs = await ipc.astOutline(text, lang);
    return sigs.map((s) => `${'  '.repeat(s.depth)}${s.line}: ${s.signature || `${s.kind} ${s.name}`}`).join('\n');
  } catch { return null; }
}

const EXAMPLES: Record<string, string> = {
  python: '(call function: (identifier) @f (#eq? @f "print")) @target',
  javascript: '(call_expression function: (member_expression object: (identifier) @o property: (property_identifier) @p (#eq? @o "console"))) @target',
  typescript: '(call_expression function: (member_expression object: (identifier) @o property: (property_identifier) @p (#eq? @o "console"))) @target',
  rust: '(macro_invocation macro: (identifier) @m (#eq? @m "println")) @target',
  go: '(call_expression function: (selector_expression) @f) @target',
  lua: '(function_call name: (identifier) @f (#eq? @f "print")) @target',
};

function pickLang(): string | null {
  const d = editors.activeDoc();
  const lang = d?.path ? astLangOf(d.path) : null;
  if (!lang) notify('Откройте файл на Python, JS/TS, Rust, Go или Lua — для него будет искать tree-sitter', { kind: 'warn' });
  return lang;
}

async function search(replace: boolean): Promise<void> {
  const lang = pickLang();
  if (!lang) return;
  if (!app.root) { notify('Сначала откройте папку', { kind: 'warn' }); return; }
  const query = await inputBox({ title: `Структурный поиск (${lang}): запрос tree-sitter`, value: EXAMPLES[lang], placeholder: '(call function: (identifier) @f) @target' });
  if (!query) return;
  try {
    const files = await ipc.astSearch(app.root, lang, query, 1000);
    const total = files.reduce((n, f) => n + f.matches.length, 0);
    if (!total) { notify('Совпадений нет'); return; }
    if (replace) {
      const tpl = await inputBox({ title: `Заменить ${total} вхожд. в ${files.length} файлах на…`, placeholder: 'Шаблон; $имя — текст захвата (@имя). Заменяется @target или первый захват' });
      if (tpl === undefined) return;
      if (!(await confirmDialog('Структурная замена', `Заменить ${total} вхождений в ${files.length} файлах?\nОтменить можно через git или «Машину времени».`, 'Заменить', true))) return;
      for (const f of files) { const d = editors.activeDoc(); if (d?.path === f.path) await editors.openFile(f.path, { preview: false }); }
      notify(`Заменено: ${await ipc.astReplace(files.map((f) => f.path), lang, query, tpl)}`);
      return;
    }
    const items: PickItem<{ path: string; line: number; col: number }>[] = files.flatMap((f) => f.matches.map((m) => ({
      label: m.text.split('\n')[0]!.trim().slice(0, 100), description: `${relative(app.root, f.path)}:${m.line}`, value: { path: f.path, line: m.line, col: m.col },
    })));
    const hit = await quickPick(items, { placeholder: `Найдено ${total} в ${files.length} файлах` });
    if (hit) await editors.openFile(hit.value.path, { line: hit.value.line, col: hit.value.col, preview: false });
  } catch (e) { notify(errText(e), { kind: 'error' }); }
}

export function registerStructure(): void {
  commands.register({ id: 'ast.search', title: 'Структурный поиск по синтаксическому дереву (tree-sitter)…', category: 'Поиск', run: () => search(false) });
  commands.register({ id: 'ast.replace', title: 'Структурная замена по синтаксическому дереву (tree-sitter)…', category: 'Поиск', run: () => search(true) });
}
