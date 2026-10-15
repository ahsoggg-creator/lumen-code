import { app } from '../app';
import { commands } from '../commands';
import { docs, editors, languageFor } from '../editor';
import { icon } from '../icons';
import { ipc, type Interp } from '../ipc';
import { log, runInTerminal, setPythonResolver } from '../panels';
import { settings, cfg } from '../settings';
import { shell } from '../shell';
import { runTask } from '../tasks';
import { confirmDialog, inputBox, notify, quickPick, section, showMenu } from '../ui';
import { Emitter, debounce, dirname, h, join } from '../util';

interface Pkg { name: string; version: string }

export const pythonChanged = new Emitter<string>();
let interps: Interp[] = [];
let discovered = false;

export const currentPython = (): string => cfg<string>('python.interpreter');

export async function discover(force = false): Promise<Interp[]> {
  if (!discovered || force) {
    interps = await ipc.pyDiscover(app.root ?? undefined).catch(() => []);
    discovered = true;
  }
  return interps;
}

/** The interpreter used for running and for pip: the chosen one, else the newest discovered. */
export async function effectivePython(): Promise<string> {
  const c = currentPython();
  if (c) return c;
  const list = await discover();
  return list.find((i) => !i.is_venv)?.path ?? list[0]?.path ?? 'python';
}

export function selectPython(path: string): void {
  settings.set('python.interpreter', path, app.root ? 'workspace' : 'user');
  pythonChanged.fire(path);
}

const label = (i: Interp): string => `Python ${i.version}${i.is_venv ? ` (${i.path.split('\\').slice(-3, -2)[0]})` : ''}`;

export const DEFAULT_RUN: Record<string, string> = {
  python: '"${python}" "${file}"', javascript: 'node "${file}"', typescript: 'npx tsx "${file}"', lua: 'lua "${file}"', powershell: '& "${file}"',
  bat: '"${file}"', go: 'go run "${file}"', rust: 'cargo run', shell: 'bash "${file}"', ruby: 'ruby "${file}"', php: 'php "${file}"',
};

export function registerPython(): void {
  setPythonResolver(() => currentPython());
  const item = shell.statusItem({ id: 'python', align: 'right', priority: 40, icon: 'python', text: 'Python', command: 'python.select', tooltip: 'Выбрать интерпретатор Python' });
  const paint = async () => {
    const c = currentPython();
    const i = interps.find((x) => x.path.toLowerCase() === c.toLowerCase());
    item.update({ text: c ? (i ? label(i) : c.split('\\').slice(-3).join('\\')) : 'Выбрать Python', tooltip: c || 'Выбрать интерпретатор Python' });
  };
  pythonChanged.on(() => void paint());
  settings.changed.on((k) => { if (k.includes('python.interpreter')) void paint(); });
  app.rootChanged.on(async () => { discovered = false; await discover(); void paint(); });
  void discover().then(paint);

  shell.registerView({
    id: 'python', title: 'Python', icon: 'python', order: 40,
    create(host, api) {
      const root = h('div.py-view');
      host.append(root);
      let pkgs: Pkg[] = [];
      let outdated = new Map<string, string>();
      let loadingPkgs = false;
      let filter = '';
      const logEl = h('pre.py-log');
      let busy: ReturnType<typeof runTask> | null = null;
      const POPULAR = ['pyautogui', 'requests', 'numpy', 'pandas', 'pillow', 'opencv-python', 'pygame', 'flask', 'fastapi', 'pytest', 'matplotlib', 'beautifulsoup4', 'selenium', 'keyboard', 'pynput', 'pyperclip', 'psutil', 'rich', 'customtkinter', 'pyinstaller', 'pywin32', 'scipy', 'tqdm', 'python-dotenv', 'aiohttp'];

      async function py(): Promise<string> { return effectivePython(); }

      async function loadPackages(): Promise<void> {
        loadingPkgs = true;
        paint();
        const exe = await py();
        const r = await ipc.exec(exe, ['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'], app.root ?? undefined, 60000);
        if (r.code === 0) {
          try { pkgs = (JSON.parse(r.stdout) as Pkg[]).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())); } catch { pkgs = []; }
        } else if (/No module named pip/i.test(r.stderr)) {
          pkgs = [];
          if (await confirmDialog('pip не найден', 'В этом Python нет pip. Установить через ensurepip?', 'Установить')) { await pip(['-m', 'ensurepip', '--upgrade']); return loadPackages(); }
        } else { pkgs = []; notify(`pip list: ${(r.stderr || r.stdout).trim().split('\n').pop()}`, { kind: 'error' }); }
        loadingPkgs = false;
        paint();
      }

      async function checkOutdated(): Promise<void> {
        const t = notify('Проверяю обновления пакетов…', { timeout: 0 });
        const r = await ipc.exec(await py(), ['-m', 'pip', 'list', '--outdated', '--format=json', '--disable-pip-version-check'], app.root ?? undefined, 120000);
        t.close();
        try { outdated = new Map((JSON.parse(r.stdout) as { name: string; latest_version: string }[]).map((p) => [p.name.toLowerCase(), p.latest_version])); } catch { outdated = new Map(); }
        notify(outdated.size ? `Доступны обновления: ${outdated.size}` : 'Все пакеты актуальны');
        paint();
      }

      async function pip(args: string[], title = 'pip'): Promise<number> {
        if (busy) { notify('Дождитесь окончания текущей операции', { kind: 'warn' }); return -1; }
        const exe = await py();
        const full = args[0] === '-m' ? args : ['-m', 'pip', ...args, '--disable-pip-version-check', '--no-input'];
        logEl.textContent = `> ${exe} ${full.join(' ')}\n`;
        logEl.style.display = '';
        shell.showView('python');
        busy = runTask(exe, full, { cwd: app.root ?? undefined, onLine: (l) => { logEl.append(document.createTextNode(l + '\n')); logEl.scrollTop = logEl.scrollHeight; log('Python', l); } });
        paint();
        const code = await busy.done;
        busy = null;
        logEl.append(document.createTextNode(code === 0 ? '✓ Готово\n' : `✗ Ошибка (код ${code})\n`));
        if (code !== 0) notify(`${title}: ошибка (код ${code}). Подробности в панели Python`, { kind: 'error' });
        paint();
        return code;
      }

      async function install(spec: string): Promise<void> {
        const name = spec.trim();
        if (!name) return;
        if ((await pip(['install', ...name.split(/\s+/)], 'Установка')) === 0) { notify(`Установлено: ${name}`); await loadPackages(); }
      }

      async function createVenv(): Promise<void> {
        if (!app.root) { notify('Сначала откройте папку проекта', { kind: 'warn' }); return; }
        const list = await discover();
        const base = list.filter((i) => !i.is_venv);
        if (!base.length) { notify('Не найден Python для создания окружения', { kind: 'error' }); return; }
        const pick = await quickPick(base.map((i) => ({ label: label(i), description: i.path, value: i })), { placeholder: 'На основе какого Python создать .venv?' });
        if (!pick) return;
        const dir = join(app.root, '.venv');
        logEl.textContent = `> ${pick.value.path} -m venv .venv\n`;
        logEl.style.display = '';
        const t = runTask(pick.value.path, ['-m', 'venv', dir], { cwd: app.root, onLine: (l) => logEl.append(document.createTextNode(l + '\n')) });
        if ((await t.done) !== 0) { notify('Не удалось создать окружение', { kind: 'error' }); return; }
        await discover(true);
        selectPython(join(dir, 'Scripts', 'python.exe'));
        notify('Окружение .venv создано и выбрано');
        if (await ipc.exists(join(app.root, 'requirements.txt')) && await confirmDialog('requirements.txt', 'Установить зависимости из requirements.txt?', 'Установить')) await pip(['install', '-r', join(app.root, 'requirements.txt')]);
        await loadPackages();
      }

      function interpRow(i: Interp): HTMLElement {
        const cur = currentPython().toLowerCase() === i.path.toLowerCase();
        return h('div', { class: `py-interp ${cur ? 'current' : ''}`, onclick: () => { selectPython(i.path); }, title: i.path },
          h('span.radio', { class: cur ? 'on' : '' }),
          h('div.py-interp-main', null, h('div', null, h('b', null, `Python ${i.version}`), i.is_venv ? h('span.chip.venv', null, 'venv') : null, h('span.chip', null, i.kind === 'launcher' || i.kind === 'installed' ? 'установлен' : i.kind === 'path' ? 'PATH' : i.kind)), h('div.dim.small.path', null, i.path)));
      }

      function pkgRow(p: Pkg): HTMLElement {
        const latest = outdated.get(p.name.toLowerCase());
        return h('div.pkg', { title: `${p.name} ${p.version}` },
          h('span.pkg-name', null, p.name), h('span.pkg-ver', null, p.version),
          latest ? h('button.chip.upd', { title: `Обновить до ${latest}`, onclick: () => void pip(['install', '--upgrade', p.name]).then((c) => { if (c === 0) return loadPackages(); }) }, `↑ ${latest}`) : null,
          h('button.icon-btn.pkg-del', { title: 'Удалить', innerHTML: icon('trash', 13), onclick: async () => { if (await confirmDialog('Удаление пакета', `Удалить ${p.name}?`, 'Удалить', true)) { if ((await pip(['uninstall', '-y', p.name])) === 0) await loadPackages(); } } }));
      }

      const installInput = h('input.field', { placeholder: 'Имя пакета, например pyautogui или requests==2.32.0', spellcheck: false });
      const preview = h('div.pkg-preview.dim.small');
      const lookup = debounce(async () => {
        const name = installInput.value.trim().split(/[=<>~ ]/)[0]!;
        if (!name) { preview.textContent = ''; return; }
        try { const i = await ipc.pypiInfo(name); preview.textContent = `${i.name} ${i.version} — ${i.summary}`; } catch { preview.textContent = 'Не найден на PyPI'; }
      }, 450);
      installInput.addEventListener('input', lookup);
      installInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { void install(installInput.value); installInput.value = ''; preview.textContent = ''; } });

      function paint(): void {
        const cur = currentPython();
        const ci = interps.find((i) => i.path.toLowerCase() === cur.toLowerCase());
        const have = new Set(pkgs.map((p) => p.name.toLowerCase().replace(/_/g, '-')));
        const shown = pkgs.filter((p) => !filter || p.name.toLowerCase().includes(filter));
        root.replaceChildren(
          section('Интерпретатор', [
            h('div.py-current', null, h('div', null, h('b', null, ci ? label(ci) : cur ? 'Свой путь' : 'Не выбран')), h('div.dim.small.path', null, cur || 'Используется первый найденный Python')),
            ...interps.map(interpRow),
            !interps.length ? h('div.dim.small.pad', null, 'Python не найден. Установите его кнопкой ниже.') : null,
            h('div.btn-row', null,
              h('button.btn', { onclick: async () => { await discover(true); paint(); } }, h('span', { innerHTML: icon('refresh', 13) }), 'Найти заново'),
              h('button.btn', { onclick: () => void createVenv() }, h('span', { innerHTML: icon('plus', 13) }), 'Создать .venv'),
              h('button.btn', { onclick: (e: MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); showMenu(r.left, r.bottom + 2, ['3.13', '3.12', '3.11', '3.10'].map((v) => ({ label: `Установить Python ${v} (winget)`, run: () => void runInTerminal(`winget install -e --id Python.Python.${v}`, { name: 'Установка Python' }) }))); } }, h('span', { innerHTML: icon('download', 13) }), 'Установить Python…')),
          ]),
          section(`Пакеты${pkgs.length ? ` · ${pkgs.length}` : ''}`, [
            h('div.pkg-tools', null,
              h('input.field', { placeholder: 'Фильтр…', spellcheck: false, value: filter, oninput: (e: Event) => { filter = (e.target as HTMLInputElement).value.toLowerCase(); paint(); const el = root.querySelector<HTMLInputElement>('.pkg-tools input'); el?.focus(); el?.setSelectionRange(filter.length, filter.length); } }),
              h('button.icon-btn', { title: 'Проверить обновления', innerHTML: icon('cloud', 15), onclick: () => void checkOutdated() }),
              h('button.icon-btn', { title: 'Обновить список', innerHTML: icon('refresh', 15), onclick: () => void loadPackages() }),
              h('button.icon-btn', { title: 'requirements.txt', innerHTML: icon('fileText', 15), onclick: (e: MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); showMenu(r.left, r.bottom + 2, [
                { label: 'Установить из requirements.txt', run: async () => { if (app.root) await pip(['install', '-r', join(app.root, 'requirements.txt')]).then((c) => { if (c === 0) return loadPackages(); }); } },
                { label: 'Сохранить установленные в requirements.txt', run: async () => { if (!app.root) return; const r2 = await ipc.exec(await py(), ['-m', 'pip', 'freeze', '--disable-pip-version-check'], app.root, 60000); if (r2.code === 0) { await ipc.writeFile(join(app.root, 'requirements.txt'), r2.stdout); notify('requirements.txt обновлён'); void editors.openFile(join(app.root, 'requirements.txt'), { preview: true }); } } },
                { label: 'Обновить все устаревшие', disabled: !outdated.size, run: async () => { for (const n of outdated.keys()) await pip(['install', '--upgrade', n]); await loadPackages(); } },
              ]); } })),
            loadingPkgs ? h('div.dim.small.pad', null, 'Загрузка списка…') : null,
            h('div.pkg-list', null, shown.map(pkgRow)),
            !loadingPkgs && !pkgs.length ? h('div.dim.small.pad', null, 'Список пуст или pip недоступен.') : null,
          ]),
          section('Установить пакет', [
            h('div.install-row', null, installInput, h('button.btn.primary', { onclick: () => { void install(installInput.value); installInput.value = ''; preview.textContent = ''; } }, 'Установить')),
            preview,
            h('div.dim.small.pad', null, 'Популярные модули:'),
            h('div.chips', null, POPULAR.map((n) => { const ok = have.has(n.toLowerCase()); return h('button', { class: `chip ${ok ? 'ok' : ''}`, title: ok ? 'Уже установлен' : `pip install ${n}`, onclick: () => { if (!ok) void install(n); } }, ok ? `✓ ${n}` : `+ ${n}`); })),
          ]),
          section('Журнал pip', [logEl, busy ? h('button.btn', { onclick: () => busy?.kill() }, 'Остановить') : null], { open: true }),
        );
        installInput.isConnected || void 0;
      }

      api.setActions([h('button.icon-btn', { title: 'Обновить', innerHTML: icon('refresh', 15), onclick: () => { void discover(true).then(() => { paint(); void loadPackages(); }); } })]);
      logEl.style.display = 'none';
      pythonChanged.on(() => { pkgs = []; outdated = new Map(); void loadPackages(); });
      settings.changed.on((k) => { if (k.includes('python.interpreter')) { pkgs = []; void loadPackages(); } });
      paint();
      void discover().then(() => { paint(); void loadPackages(); });
    },
  });

  commands.register({
    id: 'python.select', title: 'Python: выбрать интерпретатор', category: 'Python',
    run: async () => {
      const list = await discover(true);
      const cur = currentPython().toLowerCase();
      const pick = await quickPick([
        ...list.map((i) => ({ label: label(i), description: i.path, detail: i.path.toLowerCase() === cur ? 'выбран' : '', icon: 'python', value: i.path })),
        { label: 'Открыть панель Python…', value: '\0panel', icon: 'package' },
        { label: 'Указать путь вручную…', value: '\0manual', icon: 'edit' },
      ], { placeholder: 'Выберите интерпретатор Python' });
      if (!pick) return;
      if (pick.value === '\0panel') shell.showView('python');
      else if (pick.value === '\0manual') { const p = await inputBox({ title: 'Путь к python.exe', placeholder: 'C:\\Python312\\python.exe' }); if (p) selectPython(p.trim()); }
      else selectPython(pick.value);
    },
  });
  commands.register({ id: 'python.createVenv', title: 'Python: создать виртуальное окружение', category: 'Python', run: () => { shell.showView('python'); } });
  commands.register({ id: 'python.packages', title: 'Python: управление пакетами', category: 'Python', run: () => shell.showView('python') });

  commands.register({
    id: 'run.file', title: 'Запустить текущий файл', category: 'Запуск', keybinding: 'f5',
    run: async () => {
      const d = editors.activeDoc();
      if (!d) { notify('Нет открытого файла', { kind: 'warn' }); return; }
      if (d.dirty || !d.path) { if (!(await docs.save(d))) return; }
      const lang = languageFor(d.path!);
      const templates = { ...DEFAULT_RUN, ...cfg<Record<string, string>>('run.commands') };
      const t = templates[lang];
      if (!t) { notify(`Для языка «${lang}» нет команды запуска. Добавьте её в настройку run.commands.`, { kind: 'warn' }); return; }
      const python = await effectivePython();
      const cmd = t.replace(/\$\{file\}/g, d.path!).replace(/\$\{dir\}/g, dirname(d.path!)).replace(/\$\{python\}/g, python).replace(/\$\{workspace\}/g, app.root ?? dirname(d.path!));
      await runInTerminal(cmd, { name: 'Запуск', cwd: lang === 'rust' ? app.root ?? dirname(d.path!) : dirname(d.path!) });
    },
  });
}
