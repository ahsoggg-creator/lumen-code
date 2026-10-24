import { commands } from './commands';
import { editors } from './editor';
import { errText, ipc } from './ipc';
import { LANGS } from './toolchains';
import { notify } from './ui';
import { h } from './util';

const EXTRA: Record<string, string[]> = {
  'Текст и данные': ['txt', 'md', 'log', 'csv', 'tsv', 'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'sql', 'gitignore'],
  'Разметка и стили': ['html', 'htm', 'css', 'scss', 'less', 'svg', 'vue', 'svelte'],
};

function groups(): Record<string, string[]> {
  const code = LANGS.filter((l) => l.group === 'Языки программирования').flatMap((l) => l.exts);
  const scripts = LANGS.filter((l) => l.group === 'Скрипты и оболочки').flatMap((l) => l.exts);
  const g: Record<string, string[]> = { 'Языки программирования': [...code, 'h', 'hpp'], 'Скрипты и оболочки': [...scripts, 'pyi', 'tscn', 'tres', 'gdshader'] };
  for (const [k, v] of Object.entries(EXTRA)) g[k] = v;
  for (const k of Object.keys(g)) g[k] = [...new Set(g[k])];
  return g;
}

export const allKnownExts = (): string[] => [...new Set(Object.values(groups()).flat())];

export function openAssociationsPage(): void {
  editors.openView({
    key: 'associations', title: 'Ассоциации файлов', icon: 'link',
    render(host) {
      const g = groups();
      const all = allKnownExts();
      const chosen = new Set<string>();
      let context = true;
      const status = h('div.dim.small.pad');
      const body = h('div.assoc-groups');
      const ctxBox = h('input', { type: 'checkbox', checked: true, onchange: () => { context = ctxBox.checked; } });
      host.append(h('div.kb-page', null,
        h('h2', null, 'Открывать файлы в Lumen Code'),
        h('p.dim', null, 'Отметьте типы файлов, которые должны открываться этим редактором. Они появятся в «Открыть с помощью», а чтобы двойной щелчок открывал Lumen Code сразу, выберите его в окне «Приложения по умолчанию» Windows (кнопка ниже). Права администратора не нужны, всё записывается только для вашей учётной записи.'),
        h('div.btn-row', { style: 'padding-left:0' },
          h('button.btn.primary', { onclick: () => void apply() }, 'Применить'),
          h('button.btn', { onclick: () => { all.forEach((e) => chosen.add(e)); paint(); } }, 'Выбрать всё'),
          h('button.btn', { onclick: () => { chosen.clear(); paint(); } }, 'Снять всё'),
          h('button.btn', { title: 'Откроет системные настройки, где нужно выбрать Lumen Code для нужных расширений', onclick: () => void ipc.openDefaultApps() }, 'Приложения по умолчанию Windows…'),
          h('button.btn.danger', { onclick: () => void remove() }, 'Удалить все ассоциации')),
        h('label.check', { style: 'padding-left:0' }, ctxBox, 'Пункты «Открыть в Lumen Code» в контекстном меню проводника (для файлов, папок и пустого места в папке; в Windows 11 — под «Показать дополнительные параметры»)'),
        status, body));

      function paint(): void {
        body.replaceChildren(...Object.entries(g).map(([title, list]) => h('div.assoc-group', null, h('h3', null, title),
          h('div.assoc-grid', null, ...list.map((e) => h('label', { class: `assoc-ext ${chosen.has(e) ? 'on' : ''}` },
            h('input', { type: 'checkbox', checked: chosen.has(e), onchange: (ev: Event) => { if ((ev.target as HTMLInputElement).checked) chosen.add(e); else chosen.delete(e); paint(); } }), `.${e}`))))));
      }

      async function load(): Promise<void> {
        try {
          const s = await ipc.assocStatus(all);
          chosen.clear();
          s.exts.forEach((e) => chosen.add(e));
          context = s.context_menu || !s.registered;
          ctxBox.checked = context;
          status.textContent = s.registered ? `Сейчас включено типов файлов: ${s.exts.length}${s.context_menu ? ', контекстное меню включено' : ''}.` : 'Ассоциации ещё не настроены.';
        } catch (e) { status.textContent = errText(e); }
        paint();
      }

      async function apply(): Promise<void> {
        try {
          await ipc.assocApply([...chosen], all, context);
          try { localStorage.removeItem(OPT_OUT); } catch { /* ignore */ }
          await ipc.assocSetDefault([...chosen]).catch(() => []);
          notify(`Готово: ${chosen.size} типов файлов. Чтобы двойной щелчок открывал Lumen Code, выберите его в «Приложения по умолчанию».`, { actions: [{ label: 'Открыть настройки Windows', run: () => void ipc.openDefaultApps() }], timeout: 12000 });
          await load();
        } catch (e) { notify(`Не удалось записать ассоциации: ${errText(e)}`, { kind: 'error' }); }
      }

      async function remove(): Promise<void> {
        await ipc.assocRemoveAll(all);
        try { localStorage.setItem(OPT_OUT, '1'); } catch { /* ignore */ }
        notify('Ассоциации и пункты контекстного меню удалены');
        await load();
      }

      void load();
    },
  });
}

export function registerAssoc(): void {
  commands.register({ id: 'file.associations', title: 'Ассоциации файлов: открывать .py и другие в Lumen Code…', category: 'Файл', run: () => openAssociationsPage() });
}

const OPT_OUT = 'lumen.assoc.optout';
const DEFAULTS_DONE = 'lumen.assoc.defaults';

/** Types that should open in Lumen Code by default when nothing else owns them. */
const DEFAULT_EXTS = ['txt', 'md', 'log', 'py', 'json', 'js', 'ts', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'csv', 'xml', 'sql', 'rs', 'go', 'lua', 'sh', 'bat', 'ps1', 'http', 'rest'];

/**
 * On every start: make sure Lumen Code is in Explorer's "Open with" list, in the context menu of files and folders
 * (HKCU only) and points at this executable, so the entries come back after a reinstall, a move or a cleanup.
 * The associations page's "remove" is respected and switches this off.
 */
export async function autoRegisterAssoc(): Promise<void> {
  try { if (localStorage.getItem(OPT_OUT) || (await ipc.headless())) return; } catch { return; }
  try {
    const all = allKnownExts();
    const st = await ipc.assocStatus(['txt', 'md', 'py']);
    if (!st.registered || !st.context_menu || !st.current || st.exts.length < 3) await ipc.assocApply(all, all, true);
    if (!localStorage.getItem(DEFAULTS_DONE)) {
      const blocked = await ipc.assocSetDefault(DEFAULT_EXTS);
      localStorage.setItem(DEFAULTS_DONE, '1');
      if (blocked.length) {
        notify(`Для ${blocked.slice(0, 6).map((e) => `.${e}`).join(', ')}${blocked.length > 6 ? ' и др.' : ''} уже выбрана другая программа. Windows не даёт менять это из программ: выберите Lumen Code в «Приложения по умолчанию».`, { actions: [{ label: 'Открыть настройки Windows', run: () => void ipc.openDefaultApps() }], timeout: 15000 });
      }
    }
  } catch { /* retried on the next launch */ }
}
