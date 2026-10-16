import { app } from '../app';
import { commands } from '../commands';
import { icon } from '../icons';
import { errText, ipc } from '../ipc';
import { settings } from '../settings';
import { shell } from '../shell';
import { confirmDialog, notify, section } from '../ui';
import { h } from '../util';
import { extRoot, installFrom, installedExts, isEnabled, scanInstalled, searchOpenVsx, type OpenVsxHit } from '../vscode/ext';

const fmtN = (n = 0): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n));

export function registerVsx(): void {
  shell.registerView({
    id: 'vsx', title: 'Расширения VS Code', icon: 'package', order: 55,
    create(host, api) {
      const root = h('div.vsx-view');
      host.append(root);
      let hits: OpenVsxHit[] | null = null;
      let loading = false;
      let error = '';
      let busy = new Set<string>();
      const input = h('input.field', { placeholder: 'Поиск на Open VSX: тема, Python, snippets…', spellcheck: false });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void search(input.value); e.stopPropagation(); });

      async function search(q: string, sort = 'relevance'): Promise<void> {
        loading = true; error = ''; paint();
        try { hits = await searchOpenVsx(q.trim() || 'theme', q.trim() ? sort : 'downloadCount'); } catch (e) { error = errText(e); hits = null; }
        loading = false; paint();
      }

      async function install(source: string, key: string): Promise<void> {
        busy.add(key); paint();
        try {
          const { info, applied } = await installFrom(source);
          const parts = [applied.themes && `тем: ${applied.themes}`, applied.snippets && `сниппетов: ${applied.snippets}`, applied.grammars && `грамматик: ${applied.grammars}`, applied.languages && `языков: ${applied.languages}`].filter(Boolean);
          notify(`«${info.name}» установлено${parts.length ? ` — ${parts.join(', ')}` : ''}.${info.hasCode ? ' Код расширения не выполняется.' : ''}${applied.themes ? ' Тему выберите: Ctrl+K Ctrl+T.' : ''}`, { timeout: 9000 });
        } catch (e) { notify(`Не удалось установить: ${errText(e)}`, { kind: 'error', timeout: 10000 }); }
        busy.delete(key);
        await scanInstalled();
        paint();
      }

      function chips(c: { themes: number; snippets: number; grammars: number; languages: number }): HTMLElement[] {
        return ([['themes', 'тем'], ['snippets', 'сниппетов'], ['grammars', 'грамматик'], ['languages', 'языков']] as const).filter(([k]) => c[k]).map(([k, l]) => h('span.chip.ok', null, `${l}: ${c[k]}`));
      }

      function paint(): void {
        const have = new Set(installedExts.map((e) => e.id));
        root.replaceChildren(...[
          h('div.vsx-note.small.dim', null, 'Расширения берутся из реестра Open VSX. Работают темы, сниппеты, языки и подсветка (TextMate-грамматики). Расширения, которым нужен код VS Code (отладчики, языковые серверы, команды), не запускаются.'),
          h('div.vsx-search', null, input, h('button.btn.primary', { onclick: () => void search(input.value) }, 'Найти')),
          h('div.chips', null, ...([['Темы', 'theme'], ['Сниппеты', 'snippets'], ['Языки', 'language support'], ['Популярные', '']] as const).map(([l, q]) => h('button.chip', { onclick: () => { input.value = q; void search(q, q ? 'relevance' : 'downloadCount'); } }, l))),
          loading ? h('div.dim.small.pad', null, 'Поиск…') : null,
          error ? h('div.plug-error.small.pad', null, error) : null,
          ...(hits ?? []).map((x) => {
            const id = `${x.namespace}.${x.name}`;
            return h('div.plug-card', null,
              h('div.plug-head', null, h('span.plug-ic', { innerHTML: icon('package', 18) }),
                h('div.plug-title', null, h('b', null, x.displayName ?? x.name), h('span.dim.small', null, ` ${x.namespace} · v${x.version} · ↓${fmtN(x.downloadCount)}`)),
                have.has(id) ? h('span.chip.ok', null, 'установлено') : h('button.btn.primary', { disabled: busy.has(id) || !x.files.download, onclick: () => void install(x.files.download!, id) }, busy.has(id) ? '…' : 'Установить')),
              x.description ? h('div.dim.small', null, x.description) : null,
              h('button.link.small', { onclick: () => void ipc.openUrl(`https://open-vsx.org/extension/${x.namespace}/${x.name}`) }, 'Страница на Open VSX'));
          }),
          section(`Установленные · ${installedExts.length}`, installedExts.length ? installedExts.map((e) => h('div.plug-card', { class: isEnabled(e.id) ? '' : 'disabled' },
            h('div.plug-head', null, h('span.plug-ic', { innerHTML: icon('package', 18) }), h('div.plug-title', null, h('b', null, e.name), h('span.dim.small', null, ` ${e.publisher} · v${e.version}`)),
              h('label.switch', null, h('input', { type: 'checkbox', checked: isEnabled(e.id), onchange: async (ev: Event) => { const on = (ev.target as HTMLInputElement).checked; const off = new Set(settings.get<string[]>('vscode.disabled')); if (on) off.delete(e.id); else off.add(e.id); settings.set('vscode.disabled', [...off]); if (!on && await confirmDialog('Выключить расширение', 'Изменение полностью вступит в силу после перезагрузки окна. Перезагрузить сейчас?', 'Перезагрузить')) location.reload(); paint(); } }), h('span.slider'))),
            e.description ? h('div.dim.small', null, e.description) : null,
            h('div.chips', { style: 'padding:0' }, ...chips(e.counts), e.hasCode ? h('span.chip.warn', { title: 'extension.js не запускается: нет среды VS Code' }, 'код не выполняется') : null),
            h('div.plug-actions', null,
              h('button.link.small', { onclick: () => void ipc.reveal(e.dir) }, 'Папка'),
              h('button.link.small', { onclick: async () => { if (!(await confirmDialog('Удаление', `Удалить «${e.name}»?`, 'Удалить', true))) return; await ipc.remove(e.dir, true); await scanInstalled(); paint(); notify('Удалено. Полностью исчезнет после перезагрузки окна.'); } }, 'Удалить')))) : [h('div.dim.small.pad', null, 'Пока ничего. Найдите расширение выше или установите из файла .vsix.')]),
        ].filter((x): x is HTMLElement => !!x));
      }

      api.setActions([
        h('button.icon-btn', { title: 'Установить из файла .vsix', innerHTML: icon('upload', 15), onclick: () => void commands.execute('vsx.installFile') }),
        h('button.icon-btn', { title: 'Открыть папку расширений', innerHTML: icon('folderOpen', 15), onclick: () => void ipc.mkdir(extRoot()).then(() => ipc.reveal(extRoot())) }),
      ]);
      void scanInstalled().then(paint);
      paint();
      void app;
    },
  });

  commands.register({ id: 'vsx.manage', title: 'Расширения VS Code: управление', category: 'Расширения VS Code', run: () => shell.showView('vsx') });
  commands.register({ id: 'vsx.installFile', title: 'Расширения VS Code: установить из .vsix…', category: 'Расширения VS Code', run: async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const f = await open({ multiple: false, filters: [{ name: 'Расширение VS Code', extensions: ['vsix'] }] });
    if (typeof f !== 'string') return;
    try { const { installFrom: inst } = await import('../vscode/ext'); const r = await inst(f); notify(`«${r.info.name}» установлено`); shell.showView('vsx'); } catch (e) { notify(`Не удалось установить: ${errText(e)}`, { kind: 'error' }); }
  } });
}
