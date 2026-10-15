import { getCurrentWindow } from '@tauri-apps/api/window';
import { app, monaco } from './app';
import { commands, prettyBinding } from './commands';
import { docs, editors, langLabel } from './editor';
import { ipc } from './ipc';
import { openCustomCss, openKeybindingsPage, openSettingsJson, openSettingsPage, openWelcome } from './pages';
import { settings, cfg } from './settings';
import { shell } from './shell';
import { noticeHistory, notify, onNotices, quickPick, type MenuItem } from './ui';
import { basename, fmtSize, join } from './util';
import { openFolder, pickAndOpenFile, pickAndOpenFolder, recentFolders } from './workspace';

const trig = (action: string) => () => editors.activeEditor()?.trigger('menu', action, null);

export function registerWorkbench(): void {
  const C = (id: string, title: string, run: (...a: never[]) => unknown, o: { kb?: string; cat?: string; hidden?: boolean; term?: boolean } = {}) =>
    commands.register({ id, title, category: o.cat, keybinding: o.kb, hidden: o.hidden, inTerminal: o.term, run });

  // ---- files
  C('file.newUntitled', 'Новый файл', () => { editors.newUntitled(); }, { kb: 'ctrl+n', cat: 'Файл' });
  C('file.open', 'Открыть файл…', pickAndOpenFile, { kb: 'ctrl+o', cat: 'Файл' });
  C('workspace.openFolder', 'Открыть папку…', pickAndOpenFolder, { kb: 'ctrl+k ctrl+o', cat: 'Файл' });
  C('workspace.close', 'Закрыть папку', () => openFolder(null), { cat: 'Файл' });
  C('workspace.openRecent', 'Открыть недавнюю папку…', async () => {
    const pick = await quickPick(recentFolders().map((p) => ({ label: basename(p), description: p, value: p, icon: 'folder' })), { placeholder: 'Недавние папки' });
    if (pick) await openFolder(pick.value);
  }, { kb: 'ctrl+r', cat: 'Файл' });
  C('file.save', 'Сохранить', async () => { const d = editors.activeDoc(); if (d) await docs.save(d); }, { kb: 'ctrl+s', cat: 'Файл' });
  C('file.saveAs', 'Сохранить как…', async () => {
    const d = editors.activeDoc();
    if (!d) return;
    const { save } = await import('@tauri-apps/plugin-dialog');
    const p = await save({ defaultPath: d.path ?? (app.root ? join(app.root, d.name) : d.name) });
    if (p) await docs.save(d, p);
  }, { kb: 'ctrl+shift+s', cat: 'Файл' });
  C('file.saveAll', 'Сохранить все', () => editors.saveAll(), { kb: 'ctrl+k s', cat: 'Файл' });
  C('file.close', 'Закрыть вкладку', () => editors.closeActive(), { kb: 'ctrl+w', cat: 'Файл', term: true });
  C('file.closeAll', 'Закрыть все вкладки', () => editors.closeAll(), { kb: 'ctrl+k ctrl+w', cat: 'Файл' });
  C('file.revert', 'Вернуть файл с диска', async () => { const d = editors.activeDoc(); if (d?.path) await docs.reload(d); }, { cat: 'Файл' });
  C('file.copyPath', 'Копировать путь файла', () => { const d = editors.activeDoc(); if (d?.path) void navigator.clipboard.writeText(d.path); }, { cat: 'Файл' });
  C('file.reveal', 'Показать файл в проводнике Windows', () => { const d = editors.activeDoc(); if (d?.path) void ipc.reveal(d.path); }, { cat: 'Файл' });
  C('app.quit', 'Выйти', () => void getCurrentWindow().close(), { cat: 'Файл' });
  C('workbench.reload', 'Перезагрузить окно', () => location.reload(), { cat: 'Вид' });

  // ---- editing (delegates to Monaco)
  C('edit.undo', 'Отменить', trig('undo'), { cat: 'Правка' });
  C('edit.redo', 'Повторить', trig('redo'), { cat: 'Правка' });
  C('edit.find', 'Найти', trig('actions.find'), { cat: 'Правка' });
  C('edit.replace', 'Заменить', trig('editor.action.startFindReplace'), { cat: 'Правка' });
  C('edit.comment', 'Закомментировать строки', trig('editor.action.commentLine'), { cat: 'Правка' });
  C('edit.blockComment', 'Блочный комментарий', trig('editor.action.blockComment'), { cat: 'Правка' });
  C('edit.format', 'Форматировать документ', trig('editor.action.formatDocument'), { kb: 'shift+alt+f', cat: 'Правка' });
  C('edit.selectAll', 'Выделить всё', trig('editor.action.selectAll'), { cat: 'Правка' });
  C('edit.expandSelection', 'Расширить выделение', trig('editor.action.smartSelect.expand'), { kb: 'shift+alt+right', cat: 'Выделение' });
  C('edit.shrinkSelection', 'Сузить выделение', trig('editor.action.smartSelect.shrink'), { kb: 'shift+alt+left', cat: 'Выделение' });
  C('edit.cursorAbove', 'Добавить курсор выше', trig('editor.action.insertCursorAbove'), { cat: 'Выделение' });
  C('edit.cursorBelow', 'Добавить курсор ниже', trig('editor.action.insertCursorBelow'), { cat: 'Выделение' });
  C('edit.nextOccurrence', 'Добавить следующее вхождение', trig('editor.action.addSelectionToNextFindMatch'), { cat: 'Выделение' });
  C('edit.allOccurrences', 'Выделить все вхождения', trig('editor.action.selectHighlights'), { cat: 'Выделение' });
  C('edit.duplicateLine', 'Дублировать строку', trig('editor.action.copyLinesDownAction'), { cat: 'Выделение' });
  C('edit.fold', 'Свернуть всё', trig('editor.foldAll'), { cat: 'Правка' });
  C('edit.unfold', 'Развернуть всё', trig('editor.unfoldAll'), { cat: 'Правка' });
  C('edit.goDefinition', 'Перейти к определению', trig('editor.action.revealDefinition'), { cat: 'Переход' });
  C('edit.rename', 'Переименовать символ', trig('editor.action.rename'), { cat: 'Правка' });
  C('edit.sortLines', 'Сортировать строки', trig('editor.action.sortLinesAscending'), { cat: 'Правка' });
  C('edit.toUpper', 'В верхний регистр', trig('editor.action.transformToUppercase'), { cat: 'Правка' });
  C('edit.toLower', 'В нижний регистр', trig('editor.action.transformToLowercase'), { cat: 'Правка' });
  C('edit.joinLines', 'Объединить строки', trig('editor.action.joinLines'), { cat: 'Правка' });
  C('edit.indentToSpaces', 'Преобразовать отступы в пробелы', trig('editor.action.indentationToSpaces'), { cat: 'Правка' });
  C('edit.indentToTabs', 'Преобразовать отступы в табы', trig('editor.action.indentationToTabs'), { cat: 'Правка' });

  // ---- view
  C('view.toggleSidebar', 'Показать/скрыть боковую панель', () => shell.setSidebar(!shell.sidebarVisible), { kb: 'ctrl+b', cat: 'Вид', term: true });
  C('view.togglePanel', 'Показать/скрыть нижнюю панель', () => shell.togglePanel(), { kb: 'ctrl+j', cat: 'Вид', term: true });
  C('view.zen', 'Режим концентрации', () => shell.setZen(!shell.zen), { kb: 'ctrl+k z', cat: 'Вид' });
  C('view.explorer', 'Показать проводник', () => shell.showView('explorer'), { kb: 'ctrl+shift+e', cat: 'Вид' });
  C('view.search', 'Показать поиск', () => shell.showView('search'), { cat: 'Вид' });
  C('view.git', 'Показать Git', () => shell.showView('git'), { kb: 'ctrl+shift+g', cat: 'Вид' });
  C('view.python', 'Показать Python', () => shell.showView('python'), { kb: 'ctrl+shift+y', cat: 'Вид' });
  C('view.wordWrap', 'Переключить перенос строк', () => settings.set('editor.wordWrap', cfg('editor.wordWrap') === 'off' ? 'on' : 'off'), { kb: 'alt+z', cat: 'Вид' });
  C('view.minimap', 'Переключить миникарту', () => settings.set('editor.minimap', !cfg('editor.minimap')), { cat: 'Вид' });
  C('view.sidebarSide', 'Сменить сторону боковой панели', () => settings.set('workbench.sidebarPosition', cfg('workbench.sidebarPosition') === 'left' ? 'right' : 'left'), { cat: 'Вид' });
  C('view.activityBar', 'Показать/скрыть панель действий', () => settings.set('workbench.activityBar', !cfg('workbench.activityBar')), { cat: 'Вид' });
  C('view.statusBar', 'Показать/скрыть строку состояния', () => settings.set('workbench.statusBar', !cfg('workbench.statusBar')), { cat: 'Вид' });
  C('view.breadcrumbs', 'Показать/скрыть навигационную цепочку', () => settings.set('workbench.breadcrumbs', !cfg('workbench.breadcrumbs')), { cat: 'Вид' });
  C('view.zoomIn', 'Увеличить масштаб интерфейса', () => settings.set('workbench.uiScale', Math.min(1.8, +(cfg<number>('workbench.uiScale') + 0.1).toFixed(2))), { kb: 'ctrl+=', cat: 'Вид' });
  C('view.zoomOut', 'Уменьшить масштаб интерфейса', () => settings.set('workbench.uiScale', Math.max(0.7, +(cfg<number>('workbench.uiScale') - 0.1).toFixed(2))), { kb: 'ctrl+-', cat: 'Вид' });
  C('view.zoomReset', 'Сбросить масштаб интерфейса', () => settings.set('workbench.uiScale', 1), { kb: 'ctrl+0', cat: 'Вид' });
  C('editor.splitRight', 'Разделить редактор вправо', () => editors.splitRight(), { kb: 'ctrl+\\', cat: 'Вид' });
  C('editor.next', 'Следующая вкладка', () => editors.cycle(1), { kb: 'ctrl+pagedown', cat: 'Переход' });
  C('editor.prev', 'Предыдущая вкладка', () => editors.cycle(-1), { kb: 'ctrl+pageup', cat: 'Переход' });
  C('editor.nextTab2', 'Следующая вкладка (Ctrl+Tab)', () => editors.cycle(1), { kb: 'ctrl+tab', hidden: true });
  C('editor.prevTab2', 'Предыдущая вкладка (Ctrl+Shift+Tab)', () => editors.cycle(-1), { kb: 'ctrl+shift+tab', hidden: true });
  C('editor.focusLeft', 'Фокус на левую группу', () => editors.focusGroup(-1), { cat: 'Переход' });
  C('editor.focusRight', 'Фокус на правую группу', () => editors.focusGroup(1), { cat: 'Переход' });
  for (let i = 1; i <= 9; i++) C(`editor.tab${i}`, `Вкладка ${i}`, () => { const g = editors.activeGroup; const t = i === 9 ? g.tabs[g.tabs.length - 1] : g.tabs[i - 1]; if (t) g.show(t); }, { kb: `alt+${i}`, hidden: true });

  // ---- settings and help
  C('workbench.openSettings', 'Открыть настройки', () => openSettingsPage(), { kb: 'ctrl+,', cat: 'Настройки' });
  C('workbench.openSettingsJson', 'Открыть settings.json', () => openSettingsJson(), { cat: 'Настройки' });
  C('workbench.openKeybindings', 'Сочетания клавиш', () => openKeybindingsPage(), { kb: 'ctrl+k ctrl+s', cat: 'Настройки' });
  C('workbench.openCustomCss', 'Открыть свой CSS (оформление)', () => openCustomCss(), { cat: 'Настройки' });
  C('workbench.openWorkspaceSettings', 'Открыть настройки проекта', async () => {
    if (!app.root) { notify('Сначала откройте папку', { kind: 'warn' }); return; }
    const p = settings.workspacePath!;
    if (!(await ipc.exists(p))) await ipc.writeFile(p, '{\n}\n');
    await editors.openFile(p, { preview: false });
  }, { cat: 'Настройки' });
  C('workbench.openConfigFolder', 'Открыть папку конфигурации', () => ipc.reveal(app.paths.config), { cat: 'Настройки' });
  C('help.welcome', 'Справка: страница приветствия', () => openWelcome(recentFolders(), () => void pickAndOpenFolder(), (p) => void openFolder(p)), { cat: 'Справка' });
  C('help.docs', 'Справка: документация на GitHub', () => ipc.openUrl('https://github.com/ahsoggg-creator/lumen-code#readme'), { cat: 'Справка' });
  C('help.issue', 'Справка: сообщить о проблеме', () => ipc.openUrl('https://github.com/ahsoggg-creator/lumen-code/issues/new'), { cat: 'Справка' });
  C('help.about', 'Справка: о программе', () => {
    const jsMem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    notify(`Lumen Code ${app.version}\nTauri + Monaco · ${jsMem ? `память JS: ${fmtSize(jsMem.usedJSHeapSize)}` : ''}`, { timeout: 7000 });
  }, { cat: 'Справка' });
  C('markdown.preview', 'Markdown: открыть предпросмотр', () => commands.execute('markdown-preview.open'), { cat: 'Markdown', hidden: true });

  C('editor.changeLanguage', 'Сменить язык файла…', async () => {
    const { editor, doc } = editors.active();
    if (!editor || !doc) return;
    const mo = monaco();
    const pick = await quickPick(mo.languages.getLanguages().map((l) => ({ label: l.aliases?.[0] ?? l.id, description: l.id, value: l.id })), { placeholder: 'Язык файла' });
    if (pick) mo.editor.setModelLanguage(doc.model, pick.value);
  }, { cat: 'Правка' });
  C('editor.changeEncoding', 'Сменить кодировку…', async () => {
    const doc = editors.activeDoc();
    if (!doc) return;
    const encs = [['utf8', 'UTF-8'], ['utf8bom', 'UTF-8 с BOM'], ['windows1251', 'Windows 1251 (кириллица)'], ['koi8r', 'KOI8-R'], ['ibm866', 'CP866 (DOS)'], ['windows1252', 'Windows 1252'], ['utf16le', 'UTF-16 LE'], ['utf16be', 'UTF-16 BE'], ['shift_jis', 'Shift JIS'], ['gbk', 'GBK']];
    const act = await quickPick([{ label: 'Открыть заново в кодировке…', value: 'reopen' }, { label: 'Сохранять в кодировке…', value: 'save' }], { placeholder: `Сейчас: ${doc.encoding}` });
    if (!act) return;
    const pick = await quickPick(encs.map(([v, l]) => ({ label: l!, value: v!, detail: v === doc.encoding ? 'текущая' : '' })), { placeholder: 'Кодировка' });
    if (!pick) return;
    if (act.value === 'reopen' && doc.path) await docs.reload(doc, pick.value);
    else { doc.encoding = pick.value; notify(`Файл будет сохранён в ${pick.label}`); }
  }, { cat: 'Правка' });
  C('editor.toggleEol', 'Сменить конец строки (LF/CRLF)', () => {
    const doc = editors.activeDoc();
    if (!doc) return;
    const mo = monaco();
    doc.model.pushEOL(doc.model.getEOL() === '\n' ? mo.editor.EndOfLineSequence.CRLF : mo.editor.EndOfLineSequence.LF);
  }, { cat: 'Правка' });
  C('editor.indentation', 'Настроить отступы…', async () => {
    const doc = editors.activeDoc();
    if (!doc) return;
    const pick = await quickPick([2, 4, 8].flatMap((n) => [{ label: `Пробелы: ${n}`, value: `s${n}` }, { label: `Табы: ${n}`, value: `t${n}` }]), { placeholder: 'Отступы для этого файла' });
    if (pick) doc.model.updateOptions({ insertSpaces: pick.value[0] === 's', tabSize: Number(pick.value.slice(1)) });
  }, { cat: 'Правка' });

  registerStatusItems();
}

function registerStatusItems(): void {
  const pos = shell.statusItem({ id: 'pos', align: 'right', priority: 90, text: '', command: 'palette.gotoLine', tooltip: 'Перейти к строке (Ctrl+G)' });
  const indent = shell.statusItem({ id: 'indent', align: 'right', priority: 80, text: '', command: 'editor.indentation', tooltip: 'Отступы' });
  const enc = shell.statusItem({ id: 'enc', align: 'right', priority: 70, text: '', command: 'editor.changeEncoding', tooltip: 'Кодировка' });
  const eol = shell.statusItem({ id: 'eol', align: 'right', priority: 60, text: '', command: 'editor.toggleEol', tooltip: 'Конец строки' });
  const lang = shell.statusItem({ id: 'lang', align: 'right', priority: 50, text: '', command: 'editor.changeLanguage', tooltip: 'Язык' });
  const chord = shell.statusItem({ id: 'chord', align: 'left', priority: 200, text: '' });
  chord.update({ hidden: true });
  const bell = shell.statusItem({ id: 'bell', align: 'right', priority: 1, icon: 'bell', text: '', tooltip: 'Уведомления', onClick: async () => {
    const items = noticeHistory.slice().reverse().map((n) => ({ label: n.message.split('\n')[0]!, description: new Date(n.time).toLocaleTimeString(), icon: n.kind === 'error' ? 'xCircle' : n.kind === 'warn' ? 'alert' : 'info', value: n.id }));
    await quickPick(items.length ? items : [{ label: 'Уведомлений нет', value: 0 }], { placeholder: 'История уведомлений', filter: false });
  } });
  onNotices(() => bell.update({ text: noticeHistory.length ? String(noticeHistory.length) : '' }));

  const update = () => {
    const { doc, editor } = editors.active();
    const show = !!doc && !!editor;
    for (const it of [pos, indent, enc, eol, lang]) it.update({ hidden: !show });
    if (!doc || !editor) return;
    const p = editor.getPosition();
    const sel = editor.getSelection();
    const selCount = sel && !sel.isEmpty() ? doc.model.getValueInRange(sel).length : 0;
    const multi = editor.getSelections()?.length ?? 1;
    pos.update({ text: `Стр ${p?.lineNumber ?? 1}, стлб ${p?.column ?? 1}${selCount ? ` (выделено ${selCount})` : ''}${multi > 1 ? ` · курсоров: ${multi}` : ''}` });
    const o = doc.model.getOptions();
    indent.update({ text: `${o.insertSpaces ? 'Пробелы' : 'Табы'}: ${o.tabSize}` });
    enc.update({ text: ({ utf8: 'UTF-8', utf8bom: 'UTF-8 BOM', windows1251: 'Win-1251', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', koi8r: 'KOI8-R', ibm866: 'CP866' } as Record<string, string>)[doc.encoding] ?? doc.encoding });
    eol.update({ text: doc.model.getEOL() === '\n' ? 'LF' : 'CRLF' });
    lang.update({ text: langLabel(doc.model.getLanguageId()) });
  };
  editors.activeChanged.on(update);
  editors.cursorMoved.on(update);
  docs.onChange.on(update);
  editors.tabsChanged.on(update);
  update();
  window.addEventListener('lumen-chord', ((e: CustomEvent<string | null>) => chord.update(e.detail ? { text: `(${prettyBinding(e.detail)}) ждём вторую клавишу…`, hidden: false } : { hidden: true })) as EventListener);
}

export function buildMenus(): void {
  const I = (label: string, command: string, extra: Partial<MenuItem> = {}): MenuItem => ({ label, command, ...extra });
  const sep: MenuItem = { separator: true };
  shell.setMenus([
    { label: 'Файл', items: () => [I('Новый файл', 'file.newUntitled'), I('Открыть файл…', 'file.open'), I('Открыть папку…', 'workspace.openFolder'),
      { label: 'Открыть недавнюю', submenu: recentFolders().length ? recentFolders().slice(0, 10).map((p) => ({ label: p, run: () => void openFolder(p) })) : [{ label: 'Нет недавних', disabled: true }] },
      I('Закрыть папку', 'workspace.close'), sep, I('Сохранить', 'file.save'), I('Сохранить как…', 'file.saveAs'), I('Сохранить все', 'file.saveAll'), sep,
      I('Закрыть вкладку', 'file.close'), I('Закрыть все вкладки', 'file.closeAll'), sep,
      { label: 'Настройки', submenu: [I('Настройки', 'workbench.openSettings'), I('settings.json', 'workbench.openSettingsJson'), I('Сочетания клавиш', 'workbench.openKeybindings'), I('Свой CSS', 'workbench.openCustomCss'), I('Выбрать тему', 'workbench.pickTheme'), I('Настройки проекта', 'workbench.openWorkspaceSettings')] },
      sep, I('Выход', 'app.quit')] },
    { label: 'Правка', items: () => [I('Отменить', 'edit.undo', { keybinding: 'ctrl+z' }), I('Повторить', 'edit.redo', { keybinding: 'ctrl+y' }), sep, I('Найти', 'edit.find', { keybinding: 'ctrl+f' }), I('Заменить', 'edit.replace', { keybinding: 'ctrl+h' }), I('Найти в файлах', 'search.focus'), sep,
      I('Закомментировать строки', 'edit.comment', { keybinding: 'ctrl+/' }), I('Форматировать документ', 'edit.format'), I('Переименовать символ', 'edit.rename', { keybinding: 'f2' }), sep, I('Свернуть всё', 'edit.fold'), I('Развернуть всё', 'edit.unfold')] },
    { label: 'Выделение', items: () => [I('Выделить всё', 'edit.selectAll', { keybinding: 'ctrl+a' }), I('Расширить выделение', 'edit.expandSelection'), I('Сузить выделение', 'edit.shrinkSelection'), sep,
      I('Следующее вхождение', 'edit.nextOccurrence', { keybinding: 'ctrl+d' }), I('Все вхождения', 'edit.allOccurrences', { keybinding: 'ctrl+shift+l' }), I('Курсор выше', 'edit.cursorAbove', { keybinding: 'ctrl+alt+up' }), I('Курсор ниже', 'edit.cursorBelow', { keybinding: 'ctrl+alt+down' }), I('Дублировать строку', 'edit.duplicateLine', { keybinding: 'shift+alt+down' })] },
    { label: 'Вид', items: () => [I('Палитра команд…', 'palette.commands'), sep, I('Проводник', 'view.explorer'), I('Поиск', 'search.focus'), I('Git', 'view.git'), I('Python', 'view.python'), I('Плагины', 'plugins.manage'), I('Чат с ИИ', 'ai.toggleChat'), sep,
      I('Проблемы', 'view.problems'), I('Вывод', 'view.output'), I('Терминал', 'terminal.toggle'), sep,
      { label: 'Оформление', submenu: [I('Боковая панель', 'view.toggleSidebar'), I('Нижняя панель', 'view.togglePanel'), I('Режим концентрации', 'view.zen'), I('Сменить сторону панели', 'view.sidebarSide'), I('Панель действий', 'view.activityBar', { checked: cfg('workbench.activityBar') }), I('Строка состояния', 'view.statusBar', { checked: cfg('workbench.statusBar') }), I('Навигационная цепочка', 'view.breadcrumbs', { checked: cfg('workbench.breadcrumbs') })] },
      I('Разделить редактор', 'editor.splitRight'), I('Перенос строк', 'view.wordWrap', { checked: cfg('editor.wordWrap') !== 'off' }), I('Миникарта', 'view.minimap', { checked: cfg('editor.minimap') }), sep, I('Увеличить масштаб', 'view.zoomIn'), I('Уменьшить масштаб', 'view.zoomOut'), I('Сбросить масштаб', 'view.zoomReset')] },
    { label: 'Переход', items: () => [I('К файлу…', 'palette.quickOpen'), I('К строке…', 'palette.gotoLine'), I('К символу…', 'palette.symbols'), I('К определению', 'edit.goDefinition', { keybinding: 'f12' }), sep, I('Следующая вкладка', 'editor.next'), I('Предыдущая вкладка', 'editor.prev')] },
    { label: 'Запуск', items: () => [I('Запустить файл', 'run.file'), I('Выбрать интерпретатор Python…', 'python.select'), I('Пакеты Python', 'python.packages')] },
    { label: 'Терминал', items: () => [I('Новый терминал', 'terminal.new'), I('Показать/скрыть', 'terminal.toggle'), I('Очистить', 'terminal.clear'), I('Закрыть текущий', 'terminal.kill')] },
    { label: 'Справка', items: () => [I('Приветствие', 'help.welcome'), I('Документация', 'help.docs'), I('Сообщить о проблеме', 'help.issue'), sep, I('Проверить обновления…', 'help.checkUpdates'), I('О программе', 'help.about')] },
  ]);
}
