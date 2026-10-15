import { ipc } from '../ipc';
import { renderMarkdown } from '../md';
import { registerBuiltin } from './host';
import { h } from '../util';

/** Built-in plugins use exactly the same API as third-party ones. */
export function registerBuiltinPlugins(): void {
  registerBuiltin({ id: 'word-count', name: 'Счётчик слов', version: '1.0.0', description: 'Показывает число слов и символов в строке состояния.' }, (lumen) => {
    const item = lumen.window.status({ text: '', align: 'right', priority: 20, tooltip: 'Слова / символы (выделение или весь файл)' });
    const update = () => {
      const a = lumen.editor.active();
      if (!a || !['markdown', 'plaintext'].includes(a.language)) { item.update({ text: '', hidden: true }); return; }
      const t = a.selectionText || a.text;
      const words = (t.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
      item.update({ text: `${words} сл. · ${t.length} симв.`, hidden: false });
    };
    lumen.editor.onDidChangeActive(update);
    const ed = lumen.editor.getEditor();
    ed?.onDidChangeModelContent(update);
    lumen.monaco.editor.onDidCreateEditor((e) => { e.onDidChangeModelContent(update); e.onDidChangeCursorSelection(update); });
    update();
  });

  registerBuiltin({ id: 'text-tools', name: 'Текстовые инструменты', version: '1.0.0', description: 'Сортировка и очистка строк, регистр, Base64, URL-кодирование, UUID.' }, (lumen) => {
    const apply = (fn: (s: string) => string) => () => {
      const a = lumen.editor.active();
      if (!a) return;
      if (a.selectionText) lumen.editor.replaceSelection(fn(a.selectionText)); else lumen.editor.replaceAll(fn(a.text));
    };
    const lines = (f: (l: string[]) => string[]) => apply((s) => f(s.split(/\r?\n/)).join('\n'));
    const c = lumen.commands;
    c.register('sort', 'Сортировать строки (А→Я)', lines((l) => [...l].sort((a, b) => a.localeCompare(b))));
    c.register('sortDesc', 'Сортировать строки (Я→А)', lines((l) => [...l].sort((a, b) => b.localeCompare(a))));
    c.register('unique', 'Убрать повторяющиеся строки', lines((l) => [...new Set(l)]));
    c.register('reverse', 'Перевернуть порядок строк', lines((l) => [...l].reverse()));
    c.register('trim', 'Убрать пробелы в концах строк', lines((l) => l.map((x) => x.replace(/\s+$/, ''))));
    c.register('blank', 'Убрать пустые строки', lines((l) => l.filter((x) => x.trim())));
    c.register('upper', 'ВЕРХНИЙ РЕГИСТР', apply((s) => s.toUpperCase()));
    c.register('lower', 'нижний регистр', apply((s) => s.toLowerCase()));
    c.register('camel', 'camelCase', apply((s) => s.replace(/[-_\s]+(.)?/g, (_m, ch: string) => (ch ? ch.toUpperCase() : '')).replace(/^(.)/, (m) => m.toLowerCase())));
    c.register('snake', 'snake_case', apply((s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase()));
    c.register('b64enc', 'Base64: кодировать', apply((s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))));
    c.register('b64dec', 'Base64: декодировать', apply((s) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s.trim()), (ch) => ch.charCodeAt(0))); } catch { lumen.window.error('Не похоже на Base64'); return s; } }));
    c.register('urlenc', 'URL: кодировать', apply(encodeURIComponent));
    c.register('urldec', 'URL: декодировать', apply((s) => { try { return decodeURIComponent(s); } catch { return s; } }));
    c.register('uuid', 'Вставить UUID', () => lumen.editor.insert(crypto.randomUUID()));
    c.register('date', 'Вставить текущую дату и время', () => lumen.editor.insert(new Date().toLocaleString('ru-RU')));
  });

  registerBuiltin({ id: 'json-tools', name: 'JSON-инструменты', version: '1.0.0', description: 'Форматирование, сжатие и сортировка ключей JSON.' }, (lumen) => {
    const transform = (fn: (v: unknown) => string) => () => {
      const a = lumen.editor.active();
      if (!a) return;
      const src = a.selectionText || a.text;
      try {
        const out = fn(JSON.parse(src));
        if (a.selectionText) lumen.editor.replaceSelection(out); else lumen.editor.replaceAll(out);
      } catch (e) { lumen.window.error(`Некорректный JSON: ${(e as Error).message}`); }
    };
    const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, sortKeys(x)])) : v);
    lumen.commands.register('pretty', 'Форматировать', transform((v) => JSON.stringify(v, null, 2)));
    lumen.commands.register('minify', 'Сжать в одну строку', transform((v) => JSON.stringify(v)));
    lumen.commands.register('sort', 'Отсортировать ключи', transform((v) => JSON.stringify(sortKeys(v), null, 2)));
  });

  registerBuiltin({ id: 'markdown-preview', name: 'Предпросмотр Markdown', version: '1.0.0', description: 'Живой предпросмотр .md рядом с редактором (Ctrl+Shift+V).' }, (lumen) => {
    lumen.commands.register('open', 'Открыть предпросмотр', () => {
      const a = lumen.editor.active();
      if (!a || a.language !== 'markdown') { lumen.window.warn('Откройте файл Markdown'); return; }
      const model = lumen.editor.getEditor()?.getModel();
      lumen.window.openView(`preview:${a.path ?? 'untitled'}`, `Просмотр: ${a.path?.split('\\').pop() ?? 'Markdown'}`, (host) => {
        const el = h('div.md-preview');
        host.append(el);
        const render = () => {
          el.innerHTML = renderMarkdown(model?.getValue() ?? a.text);
          el.querySelectorAll<HTMLElement>('pre[data-lang]').forEach((pre) => {
            const code = pre.textContent ?? '';
            void lumen.monaco.editor.colorize(code, pre.dataset.lang || 'plaintext', {}).then((html) => { pre.querySelector('code')!.innerHTML = html; });
          });
          el.querySelectorAll<HTMLAnchorElement>('a[data-ext]').forEach((link) => link.addEventListener('click', (ev) => { ev.preventDefault(); void ipc.openUrl(link.href); }));
        };
        render();
        const sub = model?.onDidChangeContent(() => { clearTimeout(t); t = window.setTimeout(render, 200); });
        let t = 0;
        return () => sub?.dispose();
      }, 'eye');
    }, { keybinding: 'ctrl+shift+v' });
  });
}
