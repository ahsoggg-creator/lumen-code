import './style.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { app, setMonaco } from './app';
import { applyAppearance, installSettingsSchema, loadCustomCss } from './appearance';
import { installKeyHandler, commands } from './commands';
import { ipc, on } from './ipc';
import { settings } from './settings';
import { shell } from './shell';
import { dialog, notify } from './ui';
import { dirname, join } from './util';

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  app.paths = await ipc.paths();
  app.version = await ipc.version();
  await settings.init(app.paths.config);
  const { initWorkspace, openFolder, lastRoot, recentFolders, pickAndOpenFolder, saveSession } = await import('./workspace');
  await initWorkspace();
  applyAppearance();
  void loadCustomCss();

  root.append(shell.build());
  shell.updateTitle();
  window.addEventListener('contextmenu', (e) => { if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault(); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  void ipc.ready();

  // Monaco is the heaviest dependency: load it after the shell is on screen.
  const m = await import('./monaco-setup');
  setMonaco(m.monaco);
  applyAppearance();
  installSettingsSchema();

  const [{ editors, docs }, { registerExplorer }, { registerSearch }, { registerGit }, { registerPython }, { registerPluginsView }, { registerAI, installEditorActions },
    { registerPanels }, { registerPalette }, { registerWorkbench, buildMenus }, { registerUpdates }, { registerBuiltinPlugins }, { scanPlugins }, { openWelcome, openSettingsPage }] = await Promise.all([
    import('./editor'), import('./views/explorer'), import('./views/search'), import('./views/git'), import('./views/python'), import('./views/plugins'), import('./ai/view'),
    import('./panels'), import('./palette'), import('./workbench'), import('./update'), import('./plugins/builtin'), import('./plugins/host'), import('./pages'),
  ]);
  const { registerBuiltinPlugins2 } = await import('./plugins/builtin2');
  const [{ registerRun }, { registerTemplates }, { registerDebug }, { registerOutline }] = await Promise.all([import('./run'), import('./templates'), import('./debug/debug'), import('./views/outline')]);

  shell.editorHost.append(editors.el);
  editors.init();
  editors.editorCreated.on(installEditorActions);
  editors.applyOptions();
  editors.editorCreated.on(() => editors.applyOptions());

  registerExplorer(() => void pickAndOpenFolder(), recentFolders, (p) => void openFolder(p));
  registerSearch();
  registerGit();
  registerPython();
  registerPluginsView();
  registerAI();
  registerPanels();
  registerRun();
  registerTemplates();
  registerDebug();
  registerOutline();
  registerPalette();
  registerWorkbench();
  registerUpdates();
  buildMenus();
  registerBuiltinPlugins();
  registerBuiltinPlugins2();
  commands.register({ id: 'view.settings.open', title: 'Открыть настройки (страница)', hidden: true, run: () => openSettingsPage() });

  installKeyHandler(() => app.focusTerminal, (s) => window.dispatchEvent(new CustomEvent('lumen-chord', { detail: s })));

  // activity bar: settings gear
  const gear = document.createElement('button');
  gear.className = 'act-btn';
  gear.title = 'Управление';
  gear.innerHTML = (await import('./icons')).icon('sliders', 22);
  gear.onclick = (e) => {
    const r = gear.getBoundingClientRect();
    void import('./ui').then(({ showMenu }) => showMenu(r.right + 4, r.top - 120, [
      { label: 'Палитра команд…', command: 'palette.commands' }, { separator: true },
      { label: 'Настройки', command: 'workbench.openSettings' }, { label: 'Сочетания клавиш', command: 'workbench.openKeybindings' }, { label: 'Выбрать тему', command: 'workbench.pickTheme' }, { separator: true },
      { label: 'Проверить обновления…', command: 'help.checkUpdates' }]));
    e.stopPropagation();
  };
  shell.activityBottom.append(gear);

  // ---- wiring
  void on<{ paths: string[] }>('fs-change', ({ paths }) => { app.fsChanged.fire(paths); void editors.onDiskChange(paths); });
  settings.changed.on((keys) => { if (keys.some((k) => k.startsWith('workbench.') || k === 'editor.fontFamily')) applyAppearance(); });
  settings.saved.on((p) => { const d = docs.find(p); if (d && !d.dirty) void docs.reload(d); });
  docs.onSave.on((d) => {
    if (!d.path) return;
    const p = d.path.toLowerCase();
    if (p === settings.userPath.toLowerCase()) void settings.reloadUser();
    else if (p === settings.workspacePath?.toLowerCase()) void settings.reloadWorkspace();
    else if (p === join(app.paths.config, 'custom.css').toLowerCase()) void loadCustomCss();
  });
  editors.tabsChanged.on(() => saveSession());
  editors.activeChanged.on(() => saveSession());

  // ---- workspace / arguments
  const arg = app.paths.args[0];
  let opened = false;
  if (arg) {
    const isDir = await ipc.readDir(arg).then(() => true).catch(() => false);
    if (isDir) { await openFolder(arg); opened = true; }
    else if (await ipc.exists(arg)) { await openFolder(dirname(arg)); await editors.openFile(arg, { preview: false }); opened = true; }
  }
  if (!opened) {
    const last = lastRoot();
    if (last && await ipc.exists(last)) await openFolder(last);
    else await openFolder(null);
  }
  shell.showView('explorer');
  if (!editors.groups.some((g) => g.tabs.length)) openWelcome(recentFolders(), () => void pickAndOpenFolder(), (p) => void openFolder(p));
  await scanPlugins();

  // ---- window close with unsaved changes
  const win = getCurrentWindow();
  await win.onCloseRequested(async (e) => {
    const dirty = docs.all().filter((d) => d.dirty);
    if (dirty.length) {
      e.preventDefault();
      const r = await dialog('Несохранённые изменения', `Есть несохранённые файлы (${dirty.length}): ${dirty.slice(0, 5).map((d) => d.name).join(', ')}${dirty.length > 5 ? '…' : ''}. Закрыть без сохранения?`, [{ label: 'Отмена' }, { label: 'Сохранить всё и выйти', primary: true }, { label: 'Выйти без сохранения', danger: true }]);
      if (r === 1) { await editors.saveAll(); if (docs.all().some((d) => d.dirty)) return; }
      else if (r !== 2) return;
    }
    await ipc.watch(null).catch(() => undefined);
    await win.destroy();
  });
}

boot().catch((e) => {
  console.error(e);
  try { notify(`Ошибка запуска: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error', timeout: 0 }); } catch { /* ignore */ }
  void ipc.ready();
});
