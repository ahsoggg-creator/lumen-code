import { app } from './app';
import { bindingFor, chordOf, commands, keymap, normalizeBinding, prettyBinding, setRecording } from './commands';
import { editors } from './editor';
import { icon } from './icons';
import { ipc } from './ipc';
import { SCHEMA, settings, cfg, type SettingDef } from './settings';
import { shell } from './shell';
import { ACCENTS, allThemes, accentOf, findTheme } from './themes';
import { dialog, notify } from './ui';
import { h, join } from './util';

const FONTS = ['Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', 'Fira Code', 'Consolas', 'Source Code Pro', 'Hack', 'Iosevka', 'Courier New', 'Segoe UI', 'Inter', 'Roboto'];

// ================================================================= settings page
function control(d: SettingDef): HTMLElement {
  const val = settings.get(d.key);
  const set = (v: unknown) => settings.set(d.key, v);
  switch (d.type) {
    case 'boolean':
      return h('label.switch', null, h('input', { type: 'checkbox', checked: !!val, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }), h('span.slider'));
    case 'number': {
      const num = h('input.field.num', { type: 'number', value: String(val), min: d.min, max: d.max, step: d.step ?? 1, onchange: () => { const n = Number(num.value); if (Number.isFinite(n)) set(Math.min(d.max ?? Infinity, Math.max(d.min ?? -Infinity, n))); } });
      if (d.min != null && d.max != null && d.max - d.min <= 100) {
        const range = h('input', { type: 'range', min: d.min, max: d.max, step: d.step ?? 1, value: String(val), oninput: () => { num.value = range.value; set(Number(range.value)); } });
        return h('div.num-row', null, range, num);
      }
      return num;
    }
    case 'enum': {
      const opts = d.key === 'workbench.theme' ? allThemes().map((t) => ({ value: t.id, label: t.name })) : d.options ?? [];
      return h('select.field', { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) }, ...opts.map((o) => h('option', { value: o.value, selected: o.value === val }, o.label)));
    }
    case 'color': {
      const th = findTheme(cfg('workbench.theme'));
      const hex = h('input.field', { value: String(val), spellcheck: false, onchange: (e: Event) => set((e.target as HTMLInputElement).value.trim()) });
      return h('div.accent-row', null,
        ...ACCENTS.map((a) => h('button', { class: `dot-btn ${val === a ? 'on' : ''}`, title: a, style: `background:${accentOf(th, a)}`, onclick: () => { set(a); hex.value = a; } })),
        h('input', { type: 'color', value: String(accentOf(th, String(val))).slice(0, 7), oninput: (e: Event) => { set((e.target as HTMLInputElement).value); hex.value = (e.target as HTMLInputElement).value; } }), hex);
    }
    case 'font': {
      const id = `fonts-${d.key}`;
      const inp = h('input.field', { value: String(val), spellcheck: false, list: id, onchange: () => set(inp.value) });
      return h('div', null, inp, h('datalist', { id }, ...FONTS.map((f) => h('option', { value: `'${f}', ${d.key.startsWith('terminal') || d.key.startsWith('editor') ? 'monospace' : 'sans-serif'}` }, f))));
    }
    case 'string': {
      const inp = h('input.field', { value: String(val ?? ''), spellcheck: false, onchange: () => set(inp.value) });
      return inp;
    }
    default:
      return h('button.btn', { onclick: () => void openSettingsJson(d.key) }, 'Править в settings.json');
  }
}

export async function openSettingsJson(focusKey?: string): Promise<void> {
  await settings.reloadUser(false);
  const path = settings.userPath;
  if (!(await ipc.exists(path))) await ipc.writeFile(path, '{\n}\n');
  await editors.openFile(path, { preview: false });
  if (focusKey) {
    const m = editors.activeEditor()?.getModel();
    const hit = m?.findMatches(`"${focusKey}"`, false, false, true, null, false)[0];
    if (hit) editors.reveal(hit.range.startLineNumber, 1);
  }
}

function themeGallery(): HTMLElement {
  const cur = cfg<string>('workbench.theme');
  return h('div.theme-grid', null, ...allThemes().map((t) => h('button', { class: `theme-card ${t.id === cur ? 'on' : ''}`, onclick: () => { settings.set('workbench.theme', t.id); }, title: t.name },
    h('div.theme-prev', { style: `background:${t.c.base};border-color:${t.c.s1}` },
      h('div.tp-side', { style: `background:${t.c.mantle}` }),
      h('div.tp-code', null,
        h('i', { style: `width:55%;background:${t.c.mauve}` }), h('i', { style: `width:75%;background:${t.c.green}` }), h('i', { style: `width:40%;background:${t.c.blue}` }), h('i', { style: `width:62%;background:${t.c.peach}` }), h('i', { style: `width:30%;background:${t.c.red}` }))),
    h('span.theme-name', null, t.name))));
}

export function openSettingsPage(group?: string): void {
  editors.openView({
    key: 'settings', title: 'Настройки', icon: 'sliders',
    render(host) {
      const groups = [...new Set(SCHEMA.map((s) => s.group))];
      let active = group ?? groups[0]!;
      let q = '';
      const nav = h('div.set-nav');
      const main = h('div.set-main');
      const search = h('input.field.set-search', { placeholder: 'Поиск настроек…', spellcheck: false, oninput: () => { q = search.value.toLowerCase(); paint(); } });
      host.append(h('div.settings-page', null, h('div.set-left', null, search, nav, h('div.set-links', null,
        h('button.link', { onclick: () => void openSettingsJson() }, 'Открыть settings.json'),
        h('button.link', { onclick: () => void commands.execute('workbench.openKeybindings') }, 'Сочетания клавиш'),
        h('button.link', { onclick: () => void commands.execute('workbench.openCustomCss') }, 'Свой CSS'),
        h('button.link', { onclick: () => void commands.execute('workbench.openWorkspaceSettings') }, 'Настройки проекта'))), main));
      function paint(): void {
        const all = SCHEMA;
        const shown = q ? all.filter((s) => `${s.key} ${s.label} ${s.desc ?? ''}`.toLowerCase().includes(q)) : all.filter((s) => s.group === active);
        nav.replaceChildren(...groups.map((g) => h('button', { class: `set-nav-item ${!q && g === active ? 'on' : ''}`, onclick: () => { active = g; q = ''; search.value = ''; paint(); } }, g, h('span.sr-count', null, String(all.filter((s) => s.group === g).length)))));
        main.replaceChildren(...[
          h('h2', null, q ? `Результаты: ${shown.length}` : active),
          !q && active === 'Внешний вид' ? themeGallery() : null,
          ...shown.map((d) => {
            const modified = settings.has(d.key);
            return h('div', { class: `set-row ${modified ? 'mod' : ''}` },
              h('div.set-info', null, h('div.set-label', null, d.label, modified ? h('button.link.small', { title: 'Сбросить', onclick: () => { settings.reset(d.key); paint(); } }, 'сбросить') : null), d.desc ? h('div.dim.small', null, d.desc) : null, h('code.set-key', null, d.key)),
              h('div.set-ctl', null, control(d)));
          })].filter((x): x is HTMLElement => !!x));
      }
      const off = settings.changed.on((k) => { if (k.includes('workbench.theme') || k.includes('workbench.accent')) paint(); });
      paint();
      return () => off.dispose();
    },
  });
}

// ================================================================= keyboard shortcuts page
export function openKeybindingsPage(): void {
  editors.openView({
    key: 'keybindings', title: 'Сочетания клавиш', icon: 'keyboard',
    render(host) {
      let q = '';
      const list = h('div.kb-list');
      const search = h('input.field', { placeholder: 'Поиск по названию команды или сочетанию…', spellcheck: false, oninput: () => { q = search.value.toLowerCase(); paint(); } });
      host.append(h('div.kb-page', null, h('div.kb-head', null, h('h2', null, 'Сочетания клавиш'), search, h('button.link', { onclick: () => void openSettingsJson('keybindings') }, 'Править JSON')), list));

      async function record(id: string, title: string): Promise<void> {
        const label = h('div.kb-rec', null, 'Нажмите нужное сочетание…', h('div.dim.small', null, 'Можно два шага подряд (например Ctrl+K, затем Ctrl+S). Esc — отмена. Пауза 1,5 с завершает ввод.'));
        const chords: string[] = [];
        let timer = 0;
        let resolveDone: (v: string | null) => void = () => undefined;
        const done = new Promise<string | null>((r) => { resolveDone = r; });
        const onKey = (e: KeyboardEvent) => {
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') { resolveDone(null); return; }
          const c = chordOf(e);
          if (!c) return;
          chords.push(c);
          label.firstChild!.textContent = prettyBinding(chords.join(' '));
          clearTimeout(timer);
          timer = window.setTimeout(() => resolveDone(chords.join(' ')), chords.length === 2 ? 0 : 1500);
        };
        setRecording(true);
        window.addEventListener('keydown', onKey, true);
        const dlg = dialog(`Сочетание для «${title}»`, label, [{ label: 'Отмена' }]);
        void dlg.then(() => resolveDone(null));
        const result = await done;
        window.removeEventListener('keydown', onKey, true);
        setRecording(false);
        document.querySelector('.modal-overlay')?.remove();
        if (result) {
          const user = { ...(settings.get<Record<string, string>>('keybindings') ?? {}) };
          for (const [k, v] of Object.entries(user)) if (v === id) delete user[k];
          const clash = keymap().get(normalizeBinding(result));
          if (clash && clash !== id) notify(`Сочетание уже занято командой «${commands.get(clash)?.title ?? clash}» — оно будет переопределено`, { kind: 'warn' });
          user[result] = id;
          settings.set('keybindings', user);
          paint();
        }
      }

      function paint(): void {
        const user = settings.get<Record<string, string>>('keybindings') ?? {};
        const rows = commands.all().filter((c) => !c.hidden).map((c) => ({ c, kb: bindingFor(c.id) }))
          .filter(({ c, kb }) => !q || `${c.title} ${c.id} ${kb}`.toLowerCase().includes(q)).sort((a, b) => a.c.title.localeCompare(b.c.title));
        list.replaceChildren(...rows.map(({ c, kb }) => {
          const custom = Object.values(user).includes(c.id);
          return h('div', { class: `kb-row ${custom ? 'mod' : ''}` },
            h('div.kb-title', null, c.title, h('code.set-key', null, c.id)),
            h('button', { class: 'kb-key', title: 'Нажмите, чтобы изменить', onclick: () => void record(c.id, c.title) }, kb ? prettyBinding(kb) : h('span.dim', null, '— не задано —')),
            custom ? h('button.link.small', { onclick: () => { const u = { ...user }; for (const [k, v] of Object.entries(u)) if (v === c.id) delete u[k]; settings.set('keybindings', u); paint(); } }, 'сбросить') : null,
            kb && !custom ? h('button.link.small', { title: 'Отвязать', onclick: () => { settings.set('keybindings', { ...user, [kb]: '' }); paint(); } }, 'отвязать') : null);
        }));
      }
      paint();
    },
  });
}

// ================================================================= welcome page
export function openWelcome(recent: string[], openFolder: () => void, openRecent: (p: string) => void): void {
  editors.openView({
    key: 'welcome', title: 'Добро пожаловать', icon: 'home',
    render(host) {
      const link = (ic: string, text: string, fn: () => void, kb?: string) => h('button.welcome-link', { onclick: fn }, h('span', { innerHTML: icon(ic, 16) }), h('span.grow', null, text), kb ? h('span.kbd', null, prettyBinding(kb)) : null);
      const tip = (kb: string, text: string) => h('div.tip', null, h('span.kbd', null, prettyBinding(kb)), h('span', null, text));
      host.append(h('div.welcome', null,
        h('div.welcome-hero', null, h('span.hero-logo', { innerHTML: icon('logo', 44) }), h('div', null, h('h1', null, 'Lumen Code'), h('div.dim', null, `Лёгкий, быстрый и полностью настраиваемый редактор · версия ${app.version}`))),
        h('div.welcome-cols', null,
          h('div.welcome-col', null, h('h3', null, 'Начало'),
            link('filePlus', 'Новый файл', () => void commands.execute('file.newUntitled'), 'ctrl+n'),
            link('folderOpen', 'Открыть папку…', openFolder, 'ctrl+k ctrl+o'),
            link('command', 'Палитра команд', () => void commands.execute('palette.commands'), 'ctrl+shift+p'),
            h('h3.mt', null, 'Недавние'),
            ...(recent.length ? recent.slice(0, 7).map((p) => h('button.welcome-link.small', { title: p, onclick: () => openRecent(p) }, h('span', { innerHTML: icon('folder', 15) }), h('span.grow', null, p.split('\\').pop() ?? p), h('span.dim.small.path', null, p))) : [h('div.dim.small', null, 'Пока пусто')])),
          h('div.welcome-col', null, h('h3', null, 'Настройте под себя'),
            link('palette', 'Выбрать тему', () => void commands.execute('workbench.pickTheme'), 'ctrl+k ctrl+t'),
            link('sliders', 'Все настройки', () => openSettingsPage(), 'ctrl+,'),
            link('keyboard', 'Сочетания клавиш', () => openKeybindingsPage(), 'ctrl+k ctrl+s'),
            link('link', 'Открывать .py и другие файлы в Lumen Code', () => void commands.execute('file.associations')),
            link('wrench', 'Свой CSS-файл оформления', () => void commands.execute('workbench.openCustomCss')),
            h('h3.mt', null, 'Возможности'),
            link('python', 'Python: интерпретатор и пакеты', () => shell.showView('python')),
            link('sparkles', 'ИИ-чат и агенты', () => shell.showView('ai'), 'ctrl+alt+i'),
            link('plug', 'Плагины', () => shell.showView('plugins'), 'ctrl+shift+x')),
          h('div.welcome-col', null, h('h3', null, 'Полезные сочетания'),
            tip('ctrl+p', 'открыть файл по имени'), tip('ctrl+shift+f', 'поиск по проекту'), tip('ctrl+`', 'терминал'), tip('ctrl+b', 'боковая панель'),
            tip('ctrl+d', 'выделить следующее вхождение'), tip('alt+click', 'несколько курсоров'), tip('ctrl+/', 'закомментировать'), tip('alt+up', 'переместить строку'),
            tip('f5', 'запустить файл (Python и др.)'), tip('ctrl+\\', 'разделить редактор'), tip('ctrl+k z', 'режим концентрации'))),
      ));
    },
  });
}

export async function openCustomCss(): Promise<void> {
  const path = join(app.paths.config, 'custom.css');
  if (!(await ipc.exists(path))) {
    await ipc.writeFile(path, `/* Свой CSS подхватывается сразу после сохранения.\n   Меняйте переменные или любые элементы интерфейса. */\n:root {\n  /* --accent: #ff6188; */\n  /* --bg: #101018; */\n}\n\n/* .tab.active { border-top: 2px solid var(--accent); } */\n`);
  }
  await editors.openFile(path, { preview: false });
}
