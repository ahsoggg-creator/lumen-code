import { commands } from '../commands';
import { docs, editors } from '../editor';
import { icon } from '../icons';
import { shell } from '../shell';
import { debounce, h } from '../util';

interface Sym { name: string; line: number; kind: 'class' | 'fn' | 'var' | 'head'; depth: number }

const RULES: Record<string, { re: RegExp; kind: Sym['kind']; name: number }[]> = {
  python: [{ re: /^(\s*)class\s+(\w+)/, kind: 'class', name: 2 }, { re: /^(\s*)(?:async\s+)?def\s+(\w+)/, kind: 'fn', name: 2 }],
  javascript: [{ re: /^(\s*)(?:export\s+)?(?:default\s+)?class\s+(\w+)/, kind: 'class', name: 2 }, { re: /^(\s*)(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)/, kind: 'fn', name: 2 }, { re: /^(\s*)(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/, kind: 'fn', name: 2 }],
  java: [{ re: /^(\s*)(?:public|private|protected|abstract|final|static|\s)*(?:class|interface|enum|record)\s+(\w+)/, kind: 'class', name: 2 }, { re: /^(\s*)(?:public|private|protected|static|final|abstract|synchronized|\s)+[\w<>\[\],.? ]+\s+(\w+)\s*\([^;]*$/, kind: 'fn', name: 2 }],
  csharp: [{ re: /^(\s*)(?:public|private|protected|internal|static|abstract|sealed|partial|\s)*(?:class|interface|struct|enum|record)\s+(\w+)/, kind: 'class', name: 2 }, { re: /^(\s*)(?:public|private|protected|internal|static|async|override|virtual|\s)+[\w<>\[\],.? ]+\s+(\w+)\s*\([^;]*$/, kind: 'fn', name: 2 }],
  c: [{ re: /^()(?:struct|enum|union)\s+(\w+)\s*\{/, kind: 'class', name: 2 }, { re: /^()[A-Za-z_][\w\s*]*?\s+\**(\w+)\s*\([^;]*$/, kind: 'fn', name: 2 }],
  go: [{ re: /^()type\s+(\w+)\s+(?:struct|interface)/, kind: 'class', name: 2 }, { re: /^()func\s+(?:\([^)]*\)\s*)?(\w+)/, kind: 'fn', name: 2 }],
  rust: [{ re: /^(\s*)(?:pub\s+)?(?:struct|enum|trait|impl)\s+(?:<[^>]*>\s*)?(\w+)/, kind: 'class', name: 2 }, { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, kind: 'fn', name: 2 }],
  markdown: [{ re: /^()(#{1,6})\s+(.*)$/, kind: 'head', name: 3 }],
  php: [{ re: /^(\s*)(?:abstract\s+|final\s+)?class\s+(\w+)/, kind: 'class', name: 2 }, { re: /^(\s*)(?:public|private|protected|static|\s)*function\s+(\w+)/, kind: 'fn', name: 2 }],
  ruby: [{ re: /^(\s*)(?:class|module)\s+(\w+)/, kind: 'class', name: 2 }, { re: /^(\s*)def\s+(?:self\.)?(\w+[?!]?)/, kind: 'fn', name: 2 }],
  lua: [{ re: /^()(?:local\s+)?function\s+([\w.:]+)/, kind: 'fn', name: 2 }],
  kotlin: [{ re: /^(\s*)(?:data\s+|sealed\s+|open\s+|abstract\s+)*(?:class|object|interface)\s+(\w+)/, kind: 'class', name: 2 }, { re: /^(\s*)(?:override\s+|private\s+|suspend\s+)*fun\s+(?:<[^>]*>\s*)?(?:\w+\.)?(\w+)/, kind: 'fn', name: 2 }],
  gdscript: [{ re: /^()class\s+(\w+)/, kind: 'class', name: 2 }, { re: /^()(?:static\s+)?func\s+(\w+)/, kind: 'fn', name: 2 }],
  shell: [{ re: /^()(?:function\s+)?(\w+)\s*\(\)\s*\{?/, kind: 'fn', name: 2 }],
  powershell: [{ re: /^(\s*)function\s+([\w-]+)/i, kind: 'fn', name: 2 }],
};
RULES.typescript = RULES.javascript!;
RULES.cpp = RULES.c!.concat([{ re: /^(\s*)(?:class|struct|namespace)\s+(\w+)/, kind: 'class', name: 2 }]);

export function symbolsOf(text: string, lang: string): Sym[] {
  const rules = RULES[lang];
  if (!rules) return [];
  const out: Sym[] = [];
  const lines = text.split('\n');
  const KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'foreach', 'using', 'lock']);
  for (let i = 0; i < lines.length && out.length < 800; i++) {
    const line = lines[i]!;
    for (const r of rules) {
      const m = r.re.exec(line);
      if (!m) continue;
      const name = m[r.name]!;
      if (KW.has(name)) break;
      const depth = r.kind === 'head' ? m[2]!.length - 1 : Math.min(4, Math.floor((m[1] ?? '').replace(/\t/g, '    ').length / 4));
      out.push({ name, line: i + 1, kind: r.kind, depth });
      break;
    }
  }
  return out;
}

export function registerOutline(): void {
  shell.registerView({
    id: 'outline', title: 'Структура файла', icon: 'list', order: 15,
    create(host, api) {
      const root = h('div.outline');
      host.append(root);
      let filter = '';
      const input = h('input.field', { placeholder: 'Фильтр…', spellcheck: false, oninput: () => { filter = input.value.toLowerCase(); paint(); } });
      host.prepend(h('div.outline-bar', null, input));
      let syms: Sym[] = [];
      function load(): void {
        const d = editors.activeDoc();
        syms = d ? symbolsOf(d.model.getValue(), d.model.getLanguageId()) : [];
        api.setBadge(syms.length || null);
        paint();
      }
      function paint(): void {
        const d = editors.activeDoc();
        const shown = syms.filter((s) => !filter || s.name.toLowerCase().includes(filter));
        root.replaceChildren(...(shown.length ? shown.map((s) => h('div', { class: `out-row ${s.kind}`, style: `padding-left:${12 + s.depth * 14}px`, onclick: () => editors.reveal(s.line) },
          h('span', { innerHTML: icon(s.kind === 'class' ? 'package' : s.kind === 'head' ? 'fileText' : 'zap', 13) }), h('span.out-name', null, s.name), h('span.dim.small', null, String(s.line))))
          : [h('div.dim.small.pad', null, d ? 'Символов не найдено (или язык не поддерживается). Для TS/JS/JSON/CSS — Ctrl+Shift+O.' : 'Нет открытого файла')]));
      }
      const reload = debounce(load, 400);
      editors.activeChanged.on(load);
      docs.onChange.on(reload);
      load();
    },
  });
  commands.register({ id: 'view.outline', title: 'Показать структуру файла', category: 'Вид', run: () => shell.showView('outline') });
}
