import { app, monaco } from '../app';
import { commands } from '../commands';
import { docs, editors, languageFor } from '../editor';
import { gitState } from '../gitstate';
import { fileIconInfo, icon } from '../icons';
import { errText, ipc, type GitFile, type GitStatus } from '../ipc';
import { cfg } from '../settings';
import { shell } from '../shell';
import { confirmDialog, inputBox, notify, quickPick, section, showMenu } from '../ui';
import { basename, debounce, dirname, h, join } from '../util';

let status: GitStatus | null = null;
let rerender: () => void = () => undefined;
let branchItem: ReturnType<typeof shell.statusItem> | null = null;

export async function refreshGit(): Promise<void> {
  if (!app.root || !cfg('git.enabled')) { gitState.set(null); status = null; paintStatusItem(); rerender(); return; }
  try { status = await ipc.gitStatus(app.root); } catch { status = null; }
  gitState.set(status);
  paintStatusItem();
  rerender();
  for (const g of editors.groups) if (g.active?.doc) void editors.refreshGutter(g, g.active.doc);
}

function paintStatusItem(): void {
  if (!branchItem) return;
  if (!status?.is_repo) { branchItem.update({ hidden: true }); return; }
  const sync = (status.ahead ? ` ↑${status.ahead}` : '') + (status.behind ? ` ↓${status.behind}` : '');
  branchItem.update({ text: status.branch + sync, tooltip: `Ветка ${status.branch}${status.upstream ? ` → ${status.upstream}` : ''}\nНажмите, чтобы переключить`, hidden: false });
}

async function git(args: string[], opts: { quiet?: boolean } = {}): Promise<{ ok: boolean; out: string }> {
  if (!status?.is_repo && args[0] !== 'init') return { ok: false, out: 'Нет репозитория' };
  const cwd = status?.root || app.root!;
  const r = await ipc.git(cwd, args);
  if (r.code !== 0 && !opts.quiet) notify(`git ${args[0]}: ${(r.stderr || r.stdout).trim() || `код ${r.code}`}`, { kind: 'error', timeout: 8000 });
  return { ok: r.code === 0, out: r.stdout };
}

const abs = (f: GitFile): string => join(status!.root, f.path.replace(/\//g, '\\'));
const isStaged = (f: GitFile): boolean => f.index !== ' ' && f.index !== '?' && f.index !== '!';
const isChanged = (f: GitFile): boolean => f.work !== ' ' || f.index === '?';

async function openDiff(f: GitFile, staged: boolean): Promise<void> {
  const root = status!.root;
  const path = abs(f);
  const lang = languageFor(path);
  const show = async (rev: string) => ipc.gitShow(root, f.orig && staged ? f.orig : f.path, rev).catch(() => '');
  if (f.index === '?') {
    const d = await docs.open(path);
    if (d !== 'binary') editors.openDiff({ key: `${path}:new`, title: `${basename(path)} (новый)`, original: '', modifiedDoc: d, language: lang, path });
    return;
  }
  if (staged) {
    const [orig, index] = await Promise.all([show('HEAD'), ipc.gitShow(root, f.path, '').catch(() => '')]);
    editors.openDiff({ key: `${path}:staged`, title: `${basename(path)} (в индексе)`, original: orig, modifiedText: index, language: lang, path });
  } else {
    const orig = (await ipc.gitShow(root, f.path, '').catch(() => '')) || (await show('HEAD'));
    const d = await docs.open(path).catch(() => 'binary' as const);
    if (d === 'binary') { notify('Бинарный файл: сравнение недоступно', { kind: 'warn' }); return; }
    editors.openDiff({ key: `${path}:work`, title: `${basename(path)} (изменения)`, original: orig, modifiedDoc: d, language: lang, path });
  }
}

export function registerGit(): void {
  branchItem = shell.statusItem({ id: 'git.branch', icon: 'branch', text: '', priority: 100, command: 'git.checkout', tooltip: 'Ветка' });
  branchItem.update({ hidden: true });

  shell.registerView({
    id: 'git', title: 'Система контроля версий', icon: 'git', order: 30,
    create(host, api) {
      const root = h('div.git-view');
      host.append(root);
      const message = h('textarea.field.commit-msg', { placeholder: 'Сообщение коммита (Ctrl+Enter — закоммитить)', rows: 2, spellcheck: false });
      let amend = false;
      let logOpen = false;
      let logEl: HTMLElement | null = null;

      message.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); void commit(); } e.stopPropagation(); });
      message.addEventListener('input', () => { message.style.height = 'auto'; message.style.height = `${Math.min(160, message.scrollHeight)}px`; });

      async function commit(push = false): Promise<void> {
        if (!status) return;
        const msg = message.value.trim();
        if (!msg && !amend) { notify('Введите сообщение коммита', { kind: 'warn' }); message.focus(); return; }
        const staged = status.files.filter(isStaged);
        if (!staged.length && !amend) {
          if (!status.files.length) { notify('Нет изменений для коммита', { kind: 'warn' }); return; }
          if (!(await confirmDialog('Нечего коммитить', 'В индексе пусто. Добавить все изменения и закоммитить?', 'Добавить всё'))) return;
          if (!(await git(['add', '-A'])).ok) return;
        }
        const [first, ...rest] = msg.split(/\n\s*\n/);
        const args = ['commit', ...(amend ? ['--amend'] : []), ...(msg ? ['-m', first!, ...rest.flatMap((r) => ['-m', r])] : ['--no-edit'])];
        const r = await git(args);
        if (!r.ok) return;
        message.value = '';
        message.style.height = '';
        amend = false;
        if (push) await git(['push']);
        notify('Коммит создан');
        await refreshGit();
      }

      function fileRow(f: GitFile, staged: boolean): HTMLElement {
        const p = abs(f);
        const ic = fileIconInfo(basename(p));
        const letter = staged ? f.index : f.index === '?' ? 'U' : f.work;
        const cls = letter === 'D' ? 'git-del' : letter === 'U' || letter === 'A' ? 'git-new' : letter === '!' ? 'git-conflict' : 'git-mod';
        const btn = (i: string, title: string, fn: () => void) => h('button.icon-btn', { title, innerHTML: icon(i, 14), onclick: (e: Event) => { e.stopPropagation(); fn(); } });
        const actions = staged
          ? [btn('minus', 'Убрать из индекса', () => void unstage([f]))]
          : [btn('undo', 'Отменить изменения', () => void discard(f)), btn('plus', 'Добавить в индекс', () => void stage([f]))];
        return h('div.git-file', { onclick: () => void openDiff(f, staged), oncontextmenu: (e: MouseEvent) => { e.preventDefault(); showMenu(e.clientX, e.clientY, [{ label: 'Открыть файл', run: () => void editors.openFile(p, { preview: false }) }, { label: 'Показать в проводнике', run: () => app.revealRequest.fire(p) }, { label: 'История файла', run: () => void fileHistory(f) }]); } },
          h('span', { class: `tree-ic c-${ic.color}`, innerHTML: icon(ic.icon, 14) }),
          h('span.gf-name', { class: letter === 'D' ? 'strike' : '' }, basename(p)),
          h('span.gf-dir', null, dirname(f.path.replace(/\//g, '\\')) === '.' ? '' : dirname(f.path.replace(/\//g, '\\'))),
          h('span.gf-actions', null, ...actions),
          h('span', { class: `git-badge ${cls}` }, letter));
      }

      async function stage(files: GitFile[]): Promise<void> { await git(['add', '--', ...files.map((f) => f.path)]); await refreshGit(); }
      async function unstage(files: GitFile[]): Promise<void> {
        const paths = files.map((f) => f.path);
        const r = await git(['restore', '--staged', '--', ...paths], { quiet: true });
        if (!r.ok) await git(['rm', '--cached', '-r', '--', ...paths]);
        await refreshGit();
      }
      async function discard(f: GitFile): Promise<void> {
        const untracked = f.index === '?';
        if (!(await confirmDialog('Отмена изменений', `${untracked ? 'Удалить новый файл' : 'Отменить изменения в'} «${basename(f.path)}»? Это необратимо.`, 'Отменить', true))) return;
        if (untracked) await ipc.remove(abs(f), false).catch((e) => notify(errText(e), { kind: 'error' }));
        else await git(['restore', '--', f.path]);
        const d = docs.find(abs(f));
        if (d) await docs.reload(d);
        await refreshGit();
      }
      async function fileHistory(f: GitFile): Promise<void> {
        const log = await ipc.gitLog(status!.root, 50, f.path);
        const pick = await quickPick(log.map((c) => ({ label: c.subject, description: `${c.hash} · ${c.author} · ${c.date}`, value: c.hash })), { placeholder: `История ${basename(f.path)}` });
        if (pick) await showCommit(pick.value);
      }
      async function showCommit(hash: string): Promise<void> {
        const r = await ipc.git(status!.root, ['show', '--stat', '--patch', '--no-color', hash]);
        editors.newUntitled(r.stdout, 'diff');
      }

      function paint(): void {
        root.replaceChildren();
        if (!app.root) { root.append(h('div.explorer-empty', null, h('div.dim', null, 'Откройте папку, чтобы работать с Git'))); api.setBadge(null); return; }
        if (!status?.is_repo) {
          root.append(h('div.explorer-empty', null, h('div.dim', null, 'В этой папке нет Git-репозитория'),
            h('button.btn.primary', { onclick: async () => { const r = await ipc.git(app.root!, ['init']); if (r.code !== 0) notify(r.stderr, { kind: 'error' }); await refreshGit(); } }, 'Создать репозиторий')));
          api.setBadge(null);
          return;
        }
        const s = status;
        const staged = s.files.filter(isStaged);
        const changed = s.files.filter((f) => isChanged(f) && !(isStaged(f) && f.work === ' '));
        api.setBadge(s.files.length || null);
        api.setActions([
          h('button.icon-btn', { title: 'Обновить', innerHTML: icon('refresh', 15), onclick: () => void refreshGit() }),
          h('button.icon-btn', { title: 'Получить (fetch)', innerHTML: icon('cloud', 15), onclick: () => void commands.execute('git.fetch') }),
          h('button.icon-btn', { title: 'Pull', innerHTML: icon('arrowDown', 15), onclick: () => void commands.execute('git.pull') }),
          h('button.icon-btn', { title: 'Push', innerHTML: icon('arrowUp', 15), onclick: () => void commands.execute('git.push') }),
        ]);
        root.append(
          h('div.git-branch', { onclick: () => void commands.execute('git.checkout') }, h('span', { innerHTML: icon('branch', 14) }), h('b', null, s.branch), s.upstream ? h('span.dim', null, `→ ${s.upstream}`) : h('span.dim', null, 'нет upstream'), (s.ahead || s.behind) ? h('span.dim', null, `↑${s.ahead} ↓${s.behind}`) : null),
          h('div.commit-box', null, message,
            h('div.commit-actions', null,
              h('button.btn.primary.grow', { onclick: () => void commit() }, h('span', { innerHTML: icon('check', 14) }), amend ? 'Изменить коммит' : 'Закоммитить'),
              h('button.icon-btn', { title: 'Закоммитить и отправить', innerHTML: icon('upload', 15), onclick: () => void commit(true) }),
              h('label.small.amend', null, h('input', { type: 'checkbox', checked: amend, onchange: (e: Event) => { amend = (e.target as HTMLInputElement).checked; paint(); } }), 'amend'))));
        if (staged.length) root.append(section(`Подготовлено · ${staged.length}`, staged.map((f) => fileRow(f, true)), { actions: [h('button.icon-btn', { title: 'Убрать всё из индекса', innerHTML: icon('minus', 14), onclick: () => void unstage(staged) })] }));
        root.append(section(`Изменения · ${changed.length}`, changed.length ? changed.map((f) => fileRow(f, false)) : [h('div.dim.small.pad', null, 'Изменений нет')], { actions: changed.length ? [h('button.icon-btn', { title: 'Добавить всё в индекс', innerHTML: icon('plus', 14), onclick: () => void stage(changed) })] : [] }));
        logEl = h('div.git-log');
        root.append(section('История', [logEl], { open: logOpen }));
        root.querySelectorAll('.sec-head').forEach((el, i, all) => { if (i === all.length - 1) el.addEventListener('click', () => { logOpen = !logOpen; if (logOpen) void loadLog(); }); });
        if (logOpen) void loadLog();
      }

      async function loadLog(): Promise<void> {
        if (!status || !logEl) return;
        const log = await ipc.gitLog(status.root, 40);
        logEl.replaceChildren(...log.map((c) => h('div.git-commit', { title: `${c.author} · ${c.date}`, onclick: () => void showCommit(c.hash) }, h('span.hash', null, c.hash), h('span.subj', null, c.subject), h('span.dim.small', null, c.date))));
      }

      rerender = paint;
      paint();
    },
  });

  const reg = (id: string, title: string, run: () => unknown, kb?: string) => commands.register({ id, title, category: 'Git', run, keybinding: kb });
  reg('git.refresh', 'Git: обновить', () => refreshGit());
  reg('git.stageAll', 'Git: добавить всё в индекс', async () => { await git(['add', '-A']); await refreshGit(); });
  reg('git.unstageAll', 'Git: убрать всё из индекса', async () => { await git(['restore', '--staged', '.'], { quiet: true }); await refreshGit(); });
  reg('git.fetch', 'Git: fetch', async () => { const t = notify('Получаю изменения…', { timeout: 0 }); const r = await git(['fetch', '--all', '--prune']); t.close(); if (r.ok) notify('Fetch выполнен'); await refreshGit(); });
  reg('git.pull', 'Git: pull', async () => { const t = notify('Pull…', { timeout: 0 }); const r = await git(['pull']); t.close(); if (r.ok) notify(r.out.trim().split('\n').pop() || 'Готово'); await refreshGit(); });
  reg('git.push', 'Git: push', async () => {
    const t = notify('Push…', { timeout: 0 });
    let r = await git(['push'], { quiet: true });
    if (!r.ok && status && !status.upstream) r = await git(['push', '-u', 'origin', status.branch]);
    else if (!r.ok) await git(['push']);
    t.close();
    if (r.ok) notify('Push выполнен');
    await refreshGit();
  });
  reg('git.checkout', 'Git: переключить ветку…', async () => {
    if (!status?.is_repo) return;
    const out = await git(['branch', '-a', '--format=%(refname:short)'], { quiet: true });
    const names = [...new Set(out.out.split('\n').map((s) => s.trim()).filter((s) => s && !s.includes('->')).map((s) => s.replace(/^origin\//, '')))];
    const pick = await quickPick([{ label: '+ Создать новую ветку…', value: '\0new', icon: 'plus' }, ...names.map((n) => ({ label: n, value: n, icon: 'branch', description: n === status!.branch ? 'текущая' : '' }))], { placeholder: 'Выберите ветку' });
    if (!pick) return;
    if (pick.value === '\0new') {
      const name = await inputBox({ title: 'Название новой ветки', placeholder: 'feature/...' });
      if (name) { await git(['checkout', '-b', name.trim()]); await refreshGit(); }
    } else { await git(['checkout', pick.value]); await refreshGit(); }
  });
  reg('git.init', 'Git: создать репозиторий', async () => { if (app.root) { await ipc.git(app.root, ['init']); await refreshGit(); } });

  // gutter decorations
  editors.gutterRequest.on(async ({ doc, editor }) => {
    if (!cfg('git.gutter') || !status?.is_repo || !doc.path) { setGutter(editor, []); return; }
    const root = status.root.toLowerCase();
    if (!doc.path.toLowerCase().startsWith(root + '\\')) { setGutter(editor, []); return; }
    const rel = doc.path.slice(root.length + 1).replace(/\\/g, '/');
    const f = status.files.find((x) => x.path === rel);
    const mo = monaco();
    if (f?.index === '?') { setGutter(editor, [{ range: new mo.Range(1, 1, doc.model.getLineCount(), 1), options: { linesDecorationsClassName: 'gutter-added' } }]); return; }
    const hunks = await ipc.gitHunks(status.root, rel).catch(() => []);
    if (editor.getModel() !== doc.model) return;
    setGutter(editor, hunks.map((hk) => ({
      range: new mo.Range(Math.min(hk.start, doc.model.getLineCount()), 1, Math.min(hk.start + Math.max(hk.count - 1, 0), doc.model.getLineCount()), 1),
      options: { linesDecorationsClassName: `gutter-${hk.kind}` },
    })));
  });

  const auto = debounce(() => { if (document.visibilityState === 'visible') void refreshGit(); }, 700);
  app.fsChanged.on(() => auto());
  app.rootChanged.on(() => void refreshGit());
  window.addEventListener('focus', () => auto());
  docs.onSave.on(() => auto());
}

const gutterStore = new WeakMap<object, import('monaco-editor').editor.IEditorDecorationsCollection>();
function setGutter(editor: import('monaco-editor').editor.IStandaloneCodeEditor, decos: import('monaco-editor').editor.IModelDeltaDecoration[]): void {
  let c = gutterStore.get(editor);
  if (!c) { c = editor.createDecorationsCollection(); gutterStore.set(editor, c); }
  c.set(decos);
}
