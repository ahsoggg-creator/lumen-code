import { dirname } from '../util';
import type { Theme } from '../themes';
import { registerBuiltin, type LumenApi } from './host';

// ------------------------------------------------------------------ snippets
type Snip = [prefix: string, label: string, body: string];
const JS: Snip[] = [
  ['log', 'console.log', 'console.log($1);'], ['fn', 'function', 'function ${1:name}(${2:args}) {\n\t$0\n}'], ['af', 'arrow function', 'const ${1:name} = (${2:args}) => {\n\t$0\n};'],
  ['for', 'for loop', 'for (let ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}'], ['forof', 'for…of', 'for (const ${1:item} of ${2:items}) {\n\t$0\n}'], ['if', 'if', 'if (${1:cond}) {\n\t$0\n}'],
  ['ifel', 'if / else', 'if (${1:cond}) {\n\t$2\n} else {\n\t$0\n}'], ['try', 'try / catch', 'try {\n\t$1\n} catch (${2:e}) {\n\t$0\n}'], ['imp', 'import', "import { $2 } from '${1:module}';"],
  ['cls', 'class', 'class ${1:Name} {\n\tconstructor(${2:args}) {\n\t\t$0\n\t}\n}'], ['fetch', 'fetch json', "const res = await fetch('${1:url}');\nconst data = await res.json();$0"], ['timeout', 'setTimeout', 'setTimeout(() => {\n\t$0\n}, ${1:1000});'],
];
const SNIPPETS: Record<string, Snip[]> = {
  javascript: JS, typescript: [...JS, ['iface', 'interface', 'interface ${1:Name} {\n\t$0\n}'], ['type', 'type', 'type ${1:Name} = $0;']],
  python: [
    ['main', 'if __name__ == "__main__"', 'def main() -> None:\n    $0\n\n\nif __name__ == "__main__":\n    main()'], ['def', 'function', 'def ${1:name}(${2:args}):\n    ${0:pass}'], ['cls', 'class', 'class ${1:Name}:\n    def __init__(self${2:, args}):\n        ${0:pass}'],
    ['for', 'for', 'for ${1:item} in ${2:items}:\n    $0'], ['fori', 'for range', 'for ${1:i} in range(${2:n}):\n    $0'], ['if', 'if', 'if ${1:cond}:\n    $0'], ['ifel', 'if / else', 'if ${1:cond}:\n    $2\nelse:\n    $0'],
    ['try', 'try / except', 'try:\n    $1\nexcept ${2:Exception} as e:\n    $0'], ['with', 'with open', "with open(${1:'file.txt'}, ${2:'r'}, encoding='utf-8') as f:\n    $0"], ['dc', 'dataclass', '@dataclass\nclass ${1:Name}:\n    ${0:field}: str'],
    ['lc', 'list comprehension', '[${1:x} for ${1:x} in ${2:items}]'], ['pyauto', 'pyautogui click', 'import pyautogui\n\npyautogui.click(${1:x}, ${2:y})'], ['req', 'requests.get', "import requests\n\nr = requests.get(${1:'url'}, timeout=10)\nr.raise_for_status()\n$0"],
  ],
  java: [['main', 'main method', 'public static void main(String[] args) {\n\t$0\n}'], ['sout', 'System.out.println', 'System.out.println($0);'], ['fori', 'for loop', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}'], ['foreach', 'for each', 'for (${1:Type} ${2:item} : ${3:items}) {\n\t$0\n}'], ['cls', 'class', 'public class ${1:Name} {\n\t$0\n}'], ['try', 'try / catch', 'try {\n\t$1\n} catch (${2:Exception} e) {\n\t$0\n}'], ['sc', 'Scanner', 'Scanner sc = new Scanner(System.in);\n$0']],
  c: [['main', 'main', '#include <stdio.h>\n\nint main(void) {\n\t$0\n\treturn 0;\n}'], ['printf', 'printf', 'printf("${1:%d}\\n", $2);'], ['for', 'for', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}'], ['if', 'if', 'if (${1:cond}) {\n\t$0\n}'], ['st', 'struct', 'typedef struct {\n\t$0\n} ${1:Name};']],
  cpp: [['main', 'main', '#include <iostream>\n\nint main() {\n\t$0\n\treturn 0;\n}'], ['cout', 'cout', 'std::cout << $1 << std::endl;'], ['for', 'for', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ++${1:i}) {\n\t$0\n}'], ['fore', 'range for', 'for (auto& ${1:x} : ${2:items}) {\n\t$0\n}'], ['cls', 'class', 'class ${1:Name} {\npublic:\n\t$0\n};'], ['vec', 'vector', 'std::vector<${1:int}> ${2:v};']],
  csharp: [['cw', 'Console.WriteLine', 'Console.WriteLine($0);'], ['cls', 'class', 'public class ${1:Name}\n{\n\t$0\n}'], ['for', 'for', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++)\n{\n\t$0\n}'], ['foreach', 'foreach', 'foreach (var ${1:item} in ${2:items})\n{\n\t$0\n}'], ['prop', 'property', 'public ${1:string} ${2:Name} { get; set; }']],
  go: [['main', 'main', 'package main\n\nimport "fmt"\n\nfunc main() {\n\t$0\n}'], ['fp', 'fmt.Println', 'fmt.Println($0)'], ['for', 'for', 'for ${1:i} := 0; ${1:i} < ${2:n}; ${1:i}++ {\n\t$0\n}'], ['forr', 'for range', 'for ${1:i}, ${2:v} := range ${3:items} {\n\t$0\n}'], ['iferr', 'if err', 'if err != nil {\n\treturn ${1:err}\n}'], ['fn', 'func', 'func ${1:name}(${2:args}) ${3:error} {\n\t$0\n}']],
  rust: [['main', 'main', 'fn main() {\n    $0\n}'], ['pl', 'println!', 'println!("{}", $0);'], ['fn', 'fn', 'fn ${1:name}(${2:args}) -> ${3:()} {\n    $0\n}'], ['for', 'for', 'for ${1:x} in ${2:iter} {\n    $0\n}'], ['match', 'match', 'match ${1:value} {\n    ${2:pat} => $0,\n    _ => {}\n}'], ['st', 'struct', '#[derive(Debug)]\nstruct ${1:Name} {\n    $0\n}'], ['test', 'test', '#[test]\nfn ${1:name}() {\n    $0\n}']],
  html: [['!', 'HTML5', '<!DOCTYPE html>\n<html lang="ru">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>${1:Title}</title>\n</head>\n<body>\n\t$0\n</body>\n</html>'], ['link', 'link css', '<link rel="stylesheet" href="${1:style.css}">'], ['script', 'script', '<script src="${1:script.js}"></script>'], ['div', 'div', '<div class="${1:cls}">$0</div>'], ['a', 'link', '<a href="${1:#}">$0</a>'], ['img', 'img', '<img src="${1:src}" alt="${2:}">']],
  css: [['flex', 'flex center', 'display: flex;\nalign-items: center;\njustify-content: center;'], ['grid', 'grid', 'display: grid;\ngrid-template-columns: repeat(${1:3}, 1fr);\ngap: ${2:1rem};'], ['media', '@media', '@media (max-width: ${1:768px}) {\n\t$0\n}'], ['anim', '@keyframes', '@keyframes ${1:name} {\n\tfrom { $2 }\n\tto { $0 }\n}']],
  lua: [['fn', 'function', 'local function ${1:name}(${2:args})\n\t$0\nend'], ['for', 'for', 'for ${1:i} = 1, ${2:n} do\n\t$0\nend'], ['forp', 'for pairs', 'for ${1:k}, ${2:v} in pairs(${3:t}) do\n\t$0\nend'], ['if', 'if', 'if ${1:cond} then\n\t$0\nend']],
  php: [['echo', 'echo', 'echo $0;'], ['fn', 'function', 'function ${1:name}(${2:args}) {\n\t$0\n}'], ['foreach', 'foreach', 'foreach (${1:$items} as ${2:$item}) {\n\t$0\n}']],
  shell: [['if', 'if', 'if [[ ${1:cond} ]]; then\n\t$0\nfi'], ['for', 'for', 'for ${1:i} in ${2:list}; do\n\t$0\ndone'], ['fn', 'function', '${1:name}() {\n\t$0\n}']],
  powershell: [['fn', 'function', 'function ${1:Name} {\n    param($2)\n    $0\n}'], ['foreach', 'foreach', 'foreach ($${1:item} in $${2:items}) {\n    $0\n}'], ['try', 'try / catch', 'try {\n    $1\n} catch {\n    Write-Error $_\n}']],
  kotlin: [['main', 'main', 'fun main() {\n    $0\n}'], ['fun', 'function', 'fun ${1:name}(${2:args}): ${3:Unit} {\n    $0\n}'], ['for', 'for', 'for (${1:i} in ${2:0 until n}) {\n    $0\n}']],
};

// ------------------------------------------------------------------ tiny expression evaluator (no eval: CSP forbids it)
export function calc(src: string): number {
  const toks = src.replace(/,/g, '.').match(/\d+\.?\d*(?:e[+-]?\d+)?|[a-zA-Z_]\w*|[-+*/%^(),]|\*\*/gi);
  if (!toks) throw new Error('пусто');
  let i = 0;
  const FN: Record<string, (...a: number[]) => number> = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max, pow: Math.pow, exp: Math.exp };
  const CONST: Record<string, number> = { pi: Math.PI, e: Math.E };
  const peek = () => toks[i];
  const next = () => toks[i++];
  function primary(): number {
    const t = next();
    if (t === undefined) throw new Error('неожиданный конец');
    if (t === '(') { const v = expr(); if (next() !== ')') throw new Error('нет «)»'); return v; }
    if (t === '-') return -power();
    if (t === '+') return power();
    if (/^\d/.test(t)) return Number(t);
    const name = t.toLowerCase();
    if (name in CONST && peek() !== '(') return CONST[name]!;
    if (name in FN) {
      if (next() !== '(') throw new Error(`после ${t} нужна «(»`);
      const args: number[] = [];
      if (peek() !== ')') { do { args.push(expr()); } while (peek() === ';' || (peek() === ',' && next())); }
      if (next() !== ')') throw new Error('нет «)»');
      return FN[name]!(...args);
    }
    throw new Error(`неизвестно: ${t}`);
  }
  function power(): number { const b = primary(); if (peek() === '^' || peek() === '**') { next(); return b ** power(); } return b; }
  function term(): number { let v = power(); while (peek() === '*' || peek() === '/' || peek() === '%') { const o = next(); const r = power(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; }
  function expr(): number { let v = term(); while (peek() === '+' || peek() === '-') { const o = next(); const r = term(); v = o === '+' ? v + r : v - r; } return v; }
  const v = expr();
  if (i < toks.length) throw new Error(`лишнее: ${toks[i]}`);
  return v;
}

// ------------------------------------------------------------------ extra themes
const T = (id: string, name: string, dark: boolean, c: string): Theme => {
  const k = ['base', 'mantle', 'crust', 's0', 's1', 's2', 'overlay', 'subtext', 'text', 'red', 'green', 'yellow', 'blue', 'mauve', 'teal', 'peach', 'pink'];
  const v = c.split(' ');
  return { id, name, dark, c: Object.fromEntries(k.map((x, i) => [x, v[i]!])) as unknown as Theme['c'] };
};
const EXTRA_THEMES: Theme[] = [
  T('catppuccin-frappe', 'Catppuccin Frappé', true, '#303446 #292c3c #232634 #414559 #51576d #626880 #737994 #a5adce #c6d0f5 #e78284 #a6d189 #e5c890 #8caaee #ca9ee6 #81c8be #ef9f76 #f4b8e4'),
  T('catppuccin-macchiato', 'Catppuccin Macchiato', true, '#24273a #1e2030 #181926 #363a4f #494d64 #5b6078 #6e738d #a5adcb #cad3f5 #ed8796 #a6da95 #eed49f #8aadf4 #c6a0f6 #8bd5ca #f5a97f #f5bde6'),
  T('monokai', 'Monokai', true, '#272822 #1e1f1c #171815 #3e3d32 #49483e #75715e #75715e #cfcfc2 #f8f8f2 #f92672 #a6e22e #e6db74 #66d9ef #ae81ff #66d9ef #fd971f #f92672'),
  T('ayu-dark', 'Ayu Dark', true, '#0b0e14 #0a0d12 #07090d #131721 #1c2230 #2d3548 #565b66 #8a919e #bfbdb6 #f07178 #aad94c #ffb454 #59c2ff #d2a6ff #95e6cb #ff8f40 #f29668'),
  T('material-ocean', 'Material Ocean', true, '#0f111a #0b0d14 #090b10 #1a1c25 #232635 #3b3f51 #4b526d #8f93a2 #a6accd #f07178 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #f78c6c #ff5370'),
  T('night-owl', 'Night Owl', true, '#011627 #01111d #010c15 #0b2942 #122d42 #1d3b53 #5f7e97 #8aa0b5 #d6deeb #ef5350 #addb67 #ecc48d #82aaff #c792ea #7fdbca #f78c6c #ff869a'),
  T('everforest', 'Everforest Dark', true, '#2d353b #272e33 #232a2e #343f44 #3d484d #475258 #859289 #9da9a0 #d3c6aa #e67e80 #a7c080 #dbbc7f #7fbbb3 #d699b6 #83c092 #e69875 #d699b6'),
  T('kanagawa', 'Kanagawa', true, '#1f1f28 #1a1a22 #16161d #2a2a37 #363646 #54546d #727169 #a6a69c #dcd7ba #e82424 #98bb6c #e6c384 #7e9cd8 #957fb8 #7aa89f #ffa066 #d27e99'),
  T('synthwave', 'Synthwave \'84', true, '#262335 #1e1b2c #171520 #34294f #3b3157 #495495 #848bbd #b6b1c9 #ffffff #fe4450 #72f1b8 #fede5d #36f9f6 #ff7edb #36f9f6 #f97e72 #ff7edb'),
  T('palenight', 'Palenight', true, '#292d3e #232635 #1c1f2b #32364a #3a3f58 #4e5579 #676e95 #959dcb #a6accd #f07178 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #f78c6c #ff5370'),
  T('solarized-light', 'Solarized Light', false, '#fdf6e3 #eee8d5 #e4ddc8 #eee8d5 #ddd6c1 #93a1a1 #93a1a1 #657b83 #586e75 #dc322f #859900 #b58900 #268bd2 #6c71c4 #2aa198 #cb4b16 #d33682'),
  T('one-light', 'One Light', false, '#fafafa #f0f0f0 #e5e5e6 #e5e5e6 #d3d3d4 #a0a1a7 #9d9d9f #696c77 #383a42 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #986801 #ca1243'),
  T('ayu-light', 'Ayu Light', false, '#fcfcfc #f3f4f5 #e7e8e9 #eceff1 #dcdfe3 #b8bec6 #8a9199 #5c6166 #5c6166 #f07171 #86b300 #f2ae49 #399ee6 #a37acc #4cbf99 #fa8d3e #e6ba7e'),
];

// ------------------------------------------------------------------ colour swatches
function colourRegexes(): RegExp {
  return /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgb|hsl)a?\(\s*[\d.%\s,/-]+\)/g;
}

export function registerBuiltinPlugins2(): void {
  registerBuiltin({ id: 'snippets', name: 'Сниппеты', version: '1.0.0', description: 'Готовые фрагменты кода для Python, JS/TS, Java, C/C++, C#, Go, Rust, HTML, CSS, Lua, PHP, Shell, PowerShell, Kotlin. Начните вводить: main, for, if, try, log…' }, (lumen) => {
    const subs = Object.entries(SNIPPETS).map(([lang, list]) => lumen.monaco.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems(model, pos) {
        const w = model.getWordUntilPosition(pos);
        const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
        return { suggestions: list.map(([prefix, label, body]) => ({ label: prefix, detail: `сниппет: ${label}`, kind: lumen.monaco.languages.CompletionItemKind.Snippet, insertText: body, insertTextRules: lumen.monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, documentation: { value: `\`\`\`\n${body.replace(/\$\{\d:?([^}]*)\}|\$\d/g, '$1')}\n\`\`\`` }, range, sortText: `0${prefix}` })) };
      },
    }));
    return () => subs.forEach((s) => s.dispose());
  });

  registerBuiltin({ id: 'extra-themes', name: 'Ещё темы', version: '1.0.0', description: 'Frappé, Macchiato, Monokai, Ayu, Material Ocean, Night Owl, Everforest, Kanagawa, Synthwave, Palenight и светлые Solarized, One Light, Ayu Light.' }, (lumen) => {
    for (const t of EXTRA_THEMES) lumen.themes.register(t);
  });

  registerBuiltin({ id: 'calculator', name: 'Калькулятор', version: '1.0.0', description: 'Вычисляет выражение в выделении или в строке: 2*(3+4)^2, sqrt(16), sin(pi/2).' }, (lumen) => {
    lumen.commands.register('eval', 'Вычислить выражение (заменить результатом)', () => {
      const a = lumen.editor.active();
      const ed = lumen.editor.getEditor();
      if (!a || !ed) return;
      const sel = ed.getSelection();
      const text = a.selectionText || ed.getModel()?.getLineContent(a.line) || '';
      const expr = text.replace(/=\s*[-\d.,e+]*\s*$/i, '').trim();
      try {
        const v = calc(expr);
        const out = Number.isInteger(v) ? String(v) : String(+v.toFixed(10));
        if (a.selectionText && sel) lumen.editor.replaceSelection(out);
        else { const m = ed.getModel()!; ed.executeEdits('calc', [{ range: new lumen.monaco.Range(a.line, m.getLineMaxColumn(a.line), a.line, m.getLineMaxColumn(a.line)), text: ` = ${out}` }]); }
      } catch (e) { lumen.window.error(`Не получилось вычислить: ${(e as Error).message}`); }
    }, { keybinding: 'ctrl+alt+c' });
  });

  registerBuiltin({ id: 'color-preview', name: 'Цвета в коде', version: '1.0.0', description: 'Рисует цветной квадратик рядом с #hex, rgb() и hsl() в любом языке.' }, (lumen) => {
    const style = document.head.appendChild(lumen.ui.h('style', { 'data-plugin': 'color-preview' }));
    const known = new Set<string>();
    const cls = (c: string): string => {
      const id = `csw-${[...c].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36)}`;
      if (!known.has(id)) { known.add(id); style.append(`.${id}{background:${c};display:inline-block;width:.9em;height:.9em;margin-right:.35em;border-radius:3px;box-shadow:0 0 0 1px rgba(128,128,128,.55);vertical-align:-1px}\n`); }
      return id;
    };
    const stores = new WeakMap<object, import('monaco-editor').editor.IEditorDecorationsCollection>();
    const refresh = (ed: import('monaco-editor').editor.ICodeEditor | null) => {
      const m = ed?.getModel();
      if (!ed || !m || m.getLineCount() > 20000) return;
      let c = stores.get(ed);
      if (!c) { c = ed.createDecorationsCollection(); stores.set(ed, c); }
      const decos: import('monaco-editor').editor.IModelDeltaDecoration[] = [];
      const max = Math.min(m.getLineCount(), 6000);
      const re = colourRegexes();
      for (let l = 1; l <= max && decos.length < 600; l++) {
        const line = m.getLineContent(l);
        if (line.length > 400 || (!line.includes('#') && !line.includes('('))) continue;
        re.lastIndex = 0;
        for (let hit = re.exec(line); hit; hit = re.exec(line)) {
          decos.push({ range: new lumen.monaco.Range(l, hit.index + 1, l, hit.index + 1), options: { before: { content: '\u200b', inlineClassName: cls(hit[0]), inlineClassNameAffectsLetterSpacing: true } } });
        }
      }
      c.set(decos);
    };
    const timers = new WeakMap<object, number>();
    const hook = (ed: import('monaco-editor').editor.ICodeEditor) => {
      const go = () => { clearTimeout(timers.get(ed)); timers.set(ed, window.setTimeout(() => refresh(ed), 250)); };
      ed.onDidChangeModelContent(go);
      ed.onDidChangeModel(go);
      go();
    };
    const ed0 = lumen.editor.getEditor();
    if (ed0) hook(ed0);
    const sub = lumen.monaco.editor.onDidCreateEditor(hook);
    return () => { sub.dispose(); style.remove(); };
  });

  registerBuiltin({ id: 'git-blame', name: 'Git: автор строки', version: '1.0.0', description: 'В строке состояния — кто и когда менял текущую строку.', permissions: ['exec'] }, (lumen) => {
    const item = lumen.window.status({ text: '', align: 'right', priority: 35, tooltip: 'git blame текущей строки' });
    item.update({ hidden: true });
    let t = 0;
    let seq = 0;
    const run = async () => {
      const a = lumen.editor.active();
      if (!a?.path || !lumen.workspace.root) { item.update({ hidden: true }); return; }
      const mine = ++seq;
      const r = await lumen.exec('git', ['blame', '-L', `${a.line},${a.line}`, '--porcelain', '--', a.path], { cwd: dirname(a.path), timeout: 4000 });
      if (mine !== seq) return;
      if (r.code !== 0) { item.update({ hidden: true }); return; }
      const get = (k: string) => new RegExp(`^${k} (.*)$`, 'm').exec(r.stdout)?.[1] ?? '';
      const author = get('author');
      if (!author || author === 'Not Committed Yet') { item.update({ text: 'не закоммичено', hidden: false, tooltip: 'Строка ещё не в коммите' }); return; }
      const date = new Date(Number(get('author-time')) * 1000).toLocaleDateString('ru-RU');
      item.update({ text: `${author}, ${date}`, tooltip: `${get('summary')}\n${r.stdout.split(' ')[0]?.slice(0, 8)}`, hidden: false });
    };
    const hook = (ed: import('monaco-editor').editor.ICodeEditor) => ed.onDidChangeCursorPosition(() => { clearTimeout(t); t = window.setTimeout(() => void run(), 400); });
    const ed0 = lumen.editor.getEditor();
    if (ed0) hook(ed0);
    const sub = lumen.monaco.editor.onDidCreateEditor(hook);
    lumen.editor.onDidChangeActive(() => { clearTimeout(t); t = window.setTimeout(() => void run(), 300); });
    return () => sub.dispose();
  });

  registerBuiltin({ id: 'todo-tree', name: 'TODO-список', version: '1.0.0', description: 'Панель со всеми TODO / FIXME / HACK / BUG по проекту.' }, (lumen) => {
    const h = lumen.ui.h;
    lumen.window.addSidebarView({
      id: 'view', title: 'TODO', icon: 'check',
      render(host) {
        const list = h('div.todo-list');
        const status = h('div.dim.small.pad');
        const btn = h('button.btn', { onclick: () => void scan() }, 'Обновить');
        host.append(h('div.btn-row', null, btn), status, list);
        async function scan() {
          if (!lumen.workspace.root) { status.textContent = 'Откройте папку'; list.replaceChildren(); return; }
          status.textContent = 'Поиск…';
          const res = await lumen.workspace.search('\\b(TODO|FIXME|HACK|BUG|XXX)\\b', { regex: true, exclude: ['**/*.min.*', '**/dist/**', '**/target/**'] });
          const total = res.reduce((n, f) => n + f.matches.length, 0);
          status.textContent = total ? `Найдено: ${total}` : 'Ничего нет — отлично!';
          list.replaceChildren(...res.flatMap((f) => [h('div.sr-file', null, h('span.sr-name', null, f.path.split('\\').pop()!), h('span.sr-count', null, String(f.matches.length))),
            ...f.matches.slice(0, 50).map((m) => h('div.sr-match', { onclick: () => void lumen.editor.openFile(f.path, { line: m.line, col: m.col }) }, h('span.sr-line', null, String(m.line)), h('span.sr-text', null, m.text.trim().slice(0, 120))))]));
        }
        lumen.workspace.onDidChangeRoot(() => void scan());
        lumen.editor.onDidSave(() => void scan());
        void scan();
      },
    });
  });

  registerBuiltin({ id: 'bookmarks', name: 'Закладки', version: '1.0.0', description: 'Ctrl+Alt+K — закладка на строке, Ctrl+Alt+L / Ctrl+Alt+J — следующая / предыдущая, список закладок проекта.' }, (lumen) => {
    const marks = new Map<string, number[]>();
    const stores = new WeakMap<object, import('monaco-editor').editor.IEditorDecorationsCollection>();
    const ed = () => lumen.editor.getEditor();
    const cur = () => lumen.editor.active();
    const paint = () => {
      const e = ed();
      const a = cur();
      if (!e || !a?.path) return;
      let c = stores.get(e);
      if (!c) { c = e.createDecorationsCollection(); stores.set(e, c); }
      c.set((marks.get(a.path) ?? []).map((l) => ({ range: new lumen.monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'bm-line', glyphMarginClassName: 'bm-glyph', overviewRuler: { color: '#89b4fa', position: lumen.monaco.editor.OverviewRulerLane.Left } } })));
    };
    const save = () => void lumen.storage.set('marks', Object.fromEntries(marks));
    void lumen.storage.get('marks').then((v) => { for (const [p, l] of Object.entries((v as Record<string, number[]>) ?? {})) marks.set(p, l); paint(); });
    lumen.editor.onDidChangeActive(paint);
    const c = lumen.commands;
    c.register('toggle', 'Поставить / убрать закладку', () => { const a = cur(); if (!a?.path) return; const l = marks.get(a.path) ?? []; const i = l.indexOf(a.line); if (i >= 0) l.splice(i, 1); else l.push(a.line); l.sort((x, y) => x - y); marks.set(a.path, l); save(); paint(); }, { keybinding: 'ctrl+alt+k' });
    const jump = (dir: 1 | -1) => () => { const a = cur(); if (!a?.path) return; const l = marks.get(a.path) ?? []; if (!l.length) return; const t = dir === 1 ? (l.find((x) => x > a.line) ?? l[0]!) : ([...l].reverse().find((x) => x < a.line) ?? l[l.length - 1]!); lumen.editor.openFile(a.path, { line: t }); };
    c.register('next', 'Следующая закладка', jump(1), { keybinding: 'ctrl+alt+l' });
    c.register('prev', 'Предыдущая закладка', jump(-1), { keybinding: 'ctrl+alt+j' });
    c.register('list', 'Все закладки…', async () => {
      const items = [...marks].flatMap(([p, ls]) => ls.map((l) => ({ label: `${p.split('\\').pop()}:${l}`, description: p, value: { p, l } })));
      if (!items.length) { lumen.window.info('Закладок нет'); return; }
      const v = await lumen.window.pick(items, { placeholder: 'Перейти к закладке' });
      if (v) void lumen.editor.openFile(v.p, { line: v.l });
    });
    c.register('clear', 'Убрать все закладки', () => { marks.clear(); save(); paint(); });
  });

  registerBuiltin({ id: 'html-live', name: 'HTML: предпросмотр', version: '1.0.0', description: 'Открывает .html и .svg в браузере по умолчанию (кнопка ▶ или Ctrl+F5).' }, (lumen) => {
    lumen.commands.register('open', 'Открыть в браузере', () => void lumen.commands.execute('run.openInBrowser'));
  });
}

export type { LumenApi };
