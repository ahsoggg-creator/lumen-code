import { commands } from '../commands';
import { icon } from '../icons';
import { errText, ipc } from '../ipc';
import { app } from '../app';
import { createPlugin, fetchRegistry, installFromFolder, installFromUrl, listPlugins, onPluginsChanged, removePlugin, scanPlugins, setEnabled, type RegistryEntry } from '../plugins/host';
import { shell } from '../shell';
import { inputBox, notify, section } from '../ui';
import { h } from '../util';

export function registerPluginsView(): void {
  shell.registerView({
    id: 'plugins', title: 'Плагины', icon: 'plug', order: 50,
    create(host, api) {
      const root = h('div.plug-view');
      host.append(root);
      let registry: RegistryEntry[] | null = null;
      let regError = '';
      let loadingReg = false;

      function card(p: ReturnType<typeof listPlugins>[number]): HTMLElement {
        const m = p.manifest;
        const on = p.state === 'active';
        return h('div', { class: `plug-card ${p.state}` },
          h('div.plug-head', null,
            h('span.plug-ic', { innerHTML: icon('plug', 18) }),
            h('div.plug-title', null, h('b', null, m.name), h('span.dim.small', null, ` v${m.version}`), p.builtin ? h('span.chip', null, 'встроенный') : null, (m.permissions ?? []).length ? h('span.chip.warn', { title: 'Запрашивает права' }, (m.permissions ?? []).join(', ')) : null),
            p.state === 'error' ? null : h('label.switch', { title: on ? 'Выключить' : 'Включить' }, h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => void setEnabled(m.id, (e.target as HTMLInputElement).checked) }), h('span.slider'))),
          m.description ? h('div.dim.small', null, m.description) : null,
          p.error ? h('div.plug-error.small', null, p.error) : null,
          !p.builtin && p.dir ? h('div.plug-actions', null,
            h('button.link.small', { onclick: () => void ipc.reveal(p.dir!) }, 'Папка'),
            h('button.link.small', { onclick: () => void removePlugin(m.id) }, 'Удалить')) : null);
      }

      async function loadRegistry(): Promise<void> {
        loadingReg = true; regError = ''; paint();
        try { registry = await fetchRegistry(); } catch (e) { regError = errText(e); registry = null; }
        loadingReg = false; paint();
      }

      function paint(): void {
        const installed = listPlugins();
        const have = new Set(installed.map((p) => p.manifest.id));
        root.replaceChildren(
          h('div.btn-row.pad', null,
            h('button.btn', { onclick: () => void createPlugin() }, h('span', { innerHTML: icon('plus', 13) }), 'Создать'),
            h('button.btn', { onclick: async () => { const u = await inputBox({ title: 'Установить плагин по ссылке', placeholder: 'владелец/репозиторий[/папка] или https://…/raw/…', }); if (u) await installFromUrl(u); } }, h('span', { innerHTML: icon('link', 13) }), 'По ссылке'),
            h('button.btn', { onclick: async () => { const { open } = await import('@tauri-apps/plugin-dialog'); const d = await open({ directory: true, title: 'Папка с плагином' }); if (typeof d === 'string') await installFromFolder(d); } }, h('span', { innerHTML: icon('folderOpen', 13) }), 'Из папки')),
          section(`Установленные · ${installed.length}`, installed.map(card)),
          section('Каталог', [
            h('div.btn-row.pad', null, h('button.btn', { onclick: () => void loadRegistry() }, h('span', { innerHTML: icon('refresh', 13) }), registry ? 'Обновить' : 'Загрузить каталог')),
            loadingReg ? h('div.dim.small.pad', null, 'Загрузка…') : null,
            regError ? h('div.plug-error.small', null, `Каталог недоступен: ${regError}`) : null,
            ...(registry ?? []).map((r) => h('div.plug-card', null,
              h('div.plug-head', null, h('span.plug-ic', { innerHTML: icon('package', 18) }), h('div.plug-title', null, h('b', null, r.name), r.author ? h('span.dim.small', null, ` · ${r.author}`) : null),
                have.has(r.id) ? h('span.chip.ok', null, 'установлен') : h('button.btn.primary', { onclick: async () => { if (await installFromUrl(`${r.repo}${r.path ? `/${r.path}` : ''}`)) paint(); } }, 'Установить')),
              r.description ? h('div.dim.small', null, r.description) : null)),
          ], { open: false }),
          h('div.dim.small.pad', null, 'Плагины — это JavaScript-модули в папке плагинов. Документация: docs/PLUGINS.md в репозитории.'),
        );
      }

      api.setActions([
        h('button.icon-btn', { title: 'Перезагрузить плагины', innerHTML: icon('refresh', 15), onclick: () => void commands.execute('plugins.reload') }),
        h('button.icon-btn', { title: 'Открыть папку плагинов', innerHTML: icon('folderOpen', 15), onclick: () => void ipc.reveal(app.paths.plugins) }),
      ]);
      onPluginsChanged(paint);
      paint();
    },
  });

  commands.register({ id: 'plugins.reload', title: 'Плагины: перезагрузить все', category: 'Плагины', run: async () => { await scanPlugins(); notify('Плагины перезагружены'); } });
  commands.register({ id: 'plugins.create', title: 'Плагины: создать новый', category: 'Плагины', run: () => createPlugin() });
  commands.register({ id: 'plugins.openFolder', title: 'Плагины: открыть папку', category: 'Плагины', run: () => ipc.reveal(app.paths.plugins) });
  commands.register({ id: 'plugins.manage', title: 'Плагины: управление', category: 'Плагины', keybinding: 'ctrl+shift+x', run: () => shell.showView('plugins') });
  commands.register({ id: 'plugins.installUrl', title: 'Плагины: установить по ссылке', category: 'Плагины', run: async () => { const u = await inputBox({ title: 'Установить плагин по ссылке', placeholder: 'владелец/репозиторий[/папка]' }); if (u) await installFromUrl(u); } });
}
