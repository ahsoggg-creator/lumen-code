import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { app, monaco } from './app';
import { commands } from './commands';
import { editors } from './editor';
import { icon } from './icons';
import { errText, ipc, on } from './ipc';
import { settings, cfg } from './settings';
import { shell } from './shell';
import { findTheme } from './themes';
import { xtermTheme } from './themes';
import { notify, showMenu } from './ui';
import { basename, dirname, h, relative } from './util';

// ================================================================= output channels
const channels = new Map<string, string[]>();
let currentChannel = 'Lumen Code';
let outputEl: HTMLElement | null = null;
let channelSelect: HTMLSelectElement | null = null;

export function log(channel: string, text: string): void {
  let lines = channels.get(channel);
  if (!lines) { lines = []; channels.set(channel, lines); syncChannels(); }
  const stamp = new Date().toLocaleTimeString();
  for (const l of text.split('\n')) lines.push(channel === 'Lumen Code' ? `[${stamp}] ${l}` : l);
  if (lines.length > 5000) lines.splice(0, lines.length - 5000);
  if (outputEl && channel === currentChannel) {
    outputEl.append(document.createTextNode(text.split('\n').map((l) => (channel === 'Lumen Code' ? `[${stamp}] ${l}` : l)).join('\n') + '\n'));
    outputEl.scrollTop = outputEl.scrollHeight;
  }
}

function syncChannels(): void {
  if (!channelSelect) return;
  channelSelect.replaceChildren(...[...channels.keys()].map((c) => h('option', { value: c, selected: c === currentChannel }, c)));
}

/** Shows the Output panel on the given channel. */
export function revealChannel(c: string): void {
  if (!channels.has(c)) log(c, '');
  showChannel(c);
  shell.showPanel('output');
  syncChannels();
}

function showChannel(c: string): void {
  currentChannel = c;
  if (outputEl) { outputEl.textContent = (channels.get(c) ?? []).join('\n') + '\n'; outputEl.scrollTop = outputEl.scrollHeight; }
}

// ================================================================= terminal
interface Term {
  ptyId: number;
  name: string;
  xterm: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  profile: string;
  alive: boolean;
}

const terms: Term[] = [];
let activeTerm: Term | null = null;
let termTabs: HTMLElement | null = null;
let termArea: HTMLElement | null = null;
let xtermMods: Promise<{ Terminal: typeof Terminal; FitAddon: typeof FitAddon; WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon }> | null = null;
let selectedPython = () => '';

export function setPythonResolver(f: () => string): void { selectedPython = f; }

const PROFILES: Record<string, { label: string; program: string; args: string[]; kind: 'ps' | 'cmd' | 'sh' }> = {
  powershell: { label: 'PowerShell', program: 'powershell.exe', args: ['-NoLogo'], kind: 'ps' },
  pwsh: { label: 'PowerShell 7', program: 'pwsh.exe', args: ['-NoLogo'], kind: 'ps' },
  cmd: { label: 'Командная строка', program: 'cmd.exe', args: [], kind: 'cmd' },
  gitbash: { label: 'Git Bash', program: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'], kind: 'sh' },
  wsl: { label: 'WSL', program: 'wsl.exe', args: [], kind: 'sh' },
};

function loadXterm() {
  xtermMods ??= (async () => {
    const [x, f, w] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-web-links')]);
    await import('@xterm/xterm/css/xterm.css');
    return { Terminal: x.Terminal, FitAddon: f.FitAddon, WebLinksAddon: w.WebLinksAddon };
  })();
  return xtermMods;
}

function termFont(): string { return cfg<string>('terminal.fontFamily') || cfg<string>('editor.fontFamily'); }

export async function newTerminal(o: { cwd?: string; profile?: string; name?: string; show?: boolean } = {}): Promise<Term | null> {
  const profKey = o.profile ?? cfg<string>('terminal.shell');
  const custom = cfg<string>('terminal.customShell');
  const prof = custom && !o.profile ? { label: basename(custom), program: custom, args: [] as string[], kind: 'sh' as const } : PROFILES[profKey] ?? PROFILES.powershell!;
  if (o.show !== false) shell.showPanel('terminal');
  const m = await loadXterm();
  const th = findTheme(cfg('workbench.theme'));
  const xterm = new m.Terminal({
    fontFamily: termFont(), fontSize: cfg('terminal.fontSize'), cursorStyle: cfg('terminal.cursorStyle'), cursorBlink: true, scrollback: cfg('terminal.scrollback'),
    theme: xtermTheme(th, cfg('workbench.accent')), allowProposedApi: true, smoothScrollDuration: 80, fontWeightBold: 'bold', allowTransparency: false,
  });
  const fit = new m.FitAddon();
  xterm.loadAddon(fit);
  xterm.loadAddon(new m.WebLinksAddon((_e, uri) => void ipc.openUrl(uri)));
  const el = h('div.term-pane');
  termArea!.append(el);
  xterm.open(el);
  try { fit.fit(); } catch { /* hidden */ }
  const py = cfg<boolean>('python.activateInTerminal') ? selectedPython() : '';
  const env: Record<string, string> = { LUMEN: '1' };
  const pathPrepend: string[] = [];
  if (py) {
    const dir = dirname(py);
    pathPrepend.push(dir, `${dir}\\Scripts`);
    if (/\\(scripts)$/i.test(dir)) { env.VIRTUAL_ENV = dirname(dir); pathPrepend.length = 0; pathPrepend.push(dir); }
  }
  let ptyId: number;
  try {
    ptyId = await ipc.termOpen({ program: prof.program, args: prof.args, cwd: o.cwd ?? app.root ?? app.paths.home, cols: xterm.cols, rows: xterm.rows, env, pathPrepend });
  } catch (e) {
    xterm.dispose();
    el.remove();
    notify(`Терминал: ${errText(e)}`, { kind: 'error' });
    return null;
  }
  const t: Term = { ptyId, name: o.name ?? prof.label, xterm, fit, el, profile: profKey, alive: true };
  xterm.onData((d) => void ipc.termWrite(ptyId, d));
  xterm.onResize(({ cols, rows }) => void ipc.termResize(ptyId, cols, rows));
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.code === 'KeyC' && xterm.hasSelection()) { void navigator.clipboard.writeText(xterm.getSelection()); xterm.clearSelection(); return false; }
    if (e.ctrlKey && e.code === 'KeyV') return false; // let the browser paste natively
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') { void navigator.clipboard.writeText(xterm.getSelection()); return false; }
    return true;
  });
  el.addEventListener('focusin', () => { app.focusTerminal = true; });
  el.addEventListener('focusout', () => { app.focusTerminal = false; });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: 'Копировать', disabled: !xterm.hasSelection(), run: () => { void navigator.clipboard.writeText(xterm.getSelection()); xterm.clearSelection(); } },
      { label: 'Вставить', run: () => void navigator.clipboard.readText().then((s) => xterm.paste(s)).catch(() => notify('Вставьте текст сочетанием Ctrl+V', { kind: 'warn' })) },
      { label: 'Очистить', run: () => xterm.clear() },
    ]);
  });
  new ResizeObserver(() => { if (activeTerm === t && el.offsetParent) try { fit.fit(); } catch { /* ignore */ } }).observe(el);
  terms.push(t);
  selectTerm(t);
  xterm.focus();
  return t;
}

function selectTerm(t: Term | null): void {
  activeTerm = t;
  for (const x of terms) x.el.style.display = x === t ? '' : 'none';
  renderTermTabs();
  if (t) requestAnimationFrame(() => { try { t.fit.fit(); } catch { /* ignore */ } t.xterm.focus(); });
}

function renderTermTabs(): void {
  if (!termTabs) return;
  termTabs.style.display = terms.length > 1 ? '' : 'none';
  termTabs.replaceChildren(...terms.map((t) => h('div', { class: `term-tab ${t === activeTerm ? 'active' : ''}`, onclick: () => selectTerm(t) },
    h('span', { innerHTML: icon('terminal', 13) }), h('span', null, t.name), h('button.icon-btn', { title: 'Закрыть терминал', innerHTML: icon('x', 12), onclick: (e: Event) => { e.stopPropagation(); closeTerm(t); } }))));
}

function closeTerm(t: Term): void {
  const i = terms.indexOf(t);
  if (i < 0) return;
  void ipc.termClose(t.ptyId);
  t.xterm.dispose();
  t.el.remove();
  terms.splice(i, 1);
  if (activeTerm === t) selectTerm(terms[Math.min(i, terms.length - 1)] ?? null);
  else renderTermTabs();
  if (!terms.length) shell.setPanel(false);
}

function chain(kind: 'ps' | 'cmd' | 'sh', cmds: string[]): string {
  if (kind !== 'ps') return cmds.join(' && ');
  const parts = cmds.map((c) => (c.startsWith('"') ? `& ${c}` : c));
  let s = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i >= 0; i--) s = `${parts[i]}; if ($?) { ${s} }`;
  return s;
}

export async function runInTerminal(command: string | string[], opts: { name?: string; cwd?: string; reuse?: boolean } = {}): Promise<void> {
  let t = opts.reuse !== false ? terms.find((x) => x.name === (opts.name ?? 'Запуск') && x.alive) : undefined;
  t ??= (await newTerminal({ name: opts.name ?? 'Запуск', cwd: opts.cwd })) ?? undefined;
  if (!t) return;
  selectTerm(t);
  shell.showPanel('terminal');
  const kind = (PROFILES[t.profile] ?? PROFILES.powershell!).kind;
  const cmd = chain(kind, Array.isArray(command) ? command : [command]);
  if (opts.cwd) {
    const cd = kind === 'cmd' ? `cd /d "${opts.cwd}"` : `cd "${opts.cwd}"`;
    await ipc.termWrite(t.ptyId, `${cd}\r`);
  }
  await ipc.termWrite(t.ptyId, `${cmd}\r`);
  t.xterm.focus();
}

export function sendToTerminal(text: string): void { if (activeTerm) void ipc.termWrite(activeTerm.ptyId, text); }

// ================================================================= problems
function severityIcon(s: number): string { return s >= 8 ? 'xCircle' : s >= 4 ? 'alert' : 'info'; }

// ================================================================= registration
export function registerPanels(): void {
  void on<{ id: number; data: string }>('term-data', ({ id, data }) => terms.find((t) => t.ptyId === id)?.xterm.write(data));
  void on<{ id: number }>('term-exit', ({ id }) => {
    const t = terms.find((x) => x.ptyId === id);
    if (!t) return;
    t.alive = false;
    t.xterm.write('\r\n\x1b[2m[процесс завершён — закройте вкладку или нажмите Enter]\x1b[0m\r\n');
    const d = t.xterm.onKey(({ domEvent }) => { if (domEvent.key === 'Enter') { d.dispose(); closeTerm(t); } });
  });

  shell.registerPanel({
    id: 'terminal', title: 'Терминал', order: 10,
    create(host, api) {
      termTabs = h('div.term-tabs');
      termArea = h('div.term-area');
      host.append(termTabs, termArea);
      api.setActions([
        h('button.icon-btn', { title: 'Новый терминал (Ctrl+Shift+`)', innerHTML: icon('plus', 16), onclick: () => void newTerminal() }),
        h('button.icon-btn', { title: 'Выбрать оболочку', innerHTML: icon('chevronDown', 16), onclick: (e: MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); showMenu(r.left, r.bottom + 2, Object.entries(PROFILES).map(([k, p]) => ({ label: p.label, run: () => void newTerminal({ profile: k }) }))); } }),
        h('button.icon-btn', { title: 'Закрыть текущий терминал', innerHTML: icon('trash', 15), onclick: () => { if (activeTerm) closeTerm(activeTerm); } }),
      ]);
      settings.changed.on((k) => {
        if (!k.some((x) => x.startsWith('terminal.') || x === 'editor.fontFamily' || x === 'workbench.theme' || x === 'workbench.accent')) return;
        const th = findTheme(cfg('workbench.theme'));
        for (const t of terms) {
          t.xterm.options.fontFamily = termFont();
          t.xterm.options.fontSize = cfg('terminal.fontSize');
          t.xterm.options.cursorStyle = cfg('terminal.cursorStyle');
          t.xterm.options.theme = xtermTheme(th, cfg('workbench.accent'));
          try { t.fit.fit(); } catch { /* ignore */ }
        }
      });
    },
    onShow() { if (!terms.length && termArea) void newTerminal({ show: false }); else if (activeTerm) requestAnimationFrame(() => { try { activeTerm!.fit.fit(); } catch { /* ignore */ } activeTerm!.xterm.focus(); }); },
  });
  shell.layoutChanged.on(() => { if (activeTerm) requestAnimationFrame(() => { try { activeTerm!.fit.fit(); } catch { /* ignore */ } }); });

  // ---- problems
  let problemsEl: HTMLElement | null = null;
  let errors = 0, warnings = 0;
  const probItem = shell.statusItem({ id: 'problems', align: 'left', priority: 90, icon: 'xCircle', text: '0', tooltip: 'Проблемы', onClick: () => shell.showPanel('problems') });
  const probWarn = shell.statusItem({ id: 'problems.warn', align: 'left', priority: 89, icon: 'alert', text: '0', tooltip: 'Предупреждения', onClick: () => shell.showPanel('problems') });

  function renderProblems(): void {
    const mo = monaco();
    const markers = mo.editor.getModelMarkers({}).filter((m) => m.resource.scheme === 'file' || m.resource.scheme === 'untitled');
    errors = markers.filter((m) => m.severity === mo.MarkerSeverity.Error).length;
    warnings = markers.filter((m) => m.severity === mo.MarkerSeverity.Warning).length;
    probItem.update({ text: String(errors), color: errors ? 'var(--red)' : '' });
    probWarn.update({ text: String(warnings), color: warnings ? 'var(--yellow)' : '' });
    if (!problemsEl) return;
    const byFile = new Map<string, typeof markers>();
    for (const m of markers) { const k = m.resource.scheme === 'file' ? m.resource.fsPath : m.resource.path; (byFile.get(k) ?? byFile.set(k, []).get(k)!).push(m); }
    if (!markers.length) { problemsEl.replaceChildren(h('div.panel-empty', null, 'Проблем не найдено ✓')); return; }
    problemsEl.replaceChildren(...[...byFile].flatMap(([file, ms]) => [
      h('div.prob-file', null, h('b', null, basename(file)), h('span.dim', null, relative(app.root, dirname(file))), h('span.sr-count', null, String(ms.length))),
      ...ms.sort((a, b) => a.startLineNumber - b.startLineNumber).map((m) => h('div.prob', { onclick: () => void editors.openFile(file, { line: m.startLineNumber, col: m.startColumn, preview: true }) },
        h('span', { class: `prob-ic sev${m.severity}`, innerHTML: icon(severityIcon(m.severity), 14) }), h('span.prob-msg', null, m.message), h('span.dim.small', null, `${m.source ?? ''} ${m.code && typeof m.code === 'string' ? m.code : ''}`.trim()), h('span.dim.small', null, `[${m.startLineNumber}, ${m.startColumn}]`))),
    ]));
  }
  shell.registerPanel({
    id: 'problems', title: 'Проблемы', order: 20,
    create(host, api) {
      problemsEl = h('div.problems');
      host.append(problemsEl);
      renderProblems();
      const refresh = () => { renderProblems(); api.setBadge(errors + warnings || null); };
      monaco().editor.onDidChangeMarkers(() => refresh());
      refresh();
    },
    onShow: renderProblems,
  });

  // ---- output
  shell.registerPanel({
    id: 'output', title: 'Вывод', order: 30,
    create(host, api) {
      outputEl = h('pre.output');
      channelSelect = h('select.field.small', { onchange: (e: Event) => showChannel((e.target as HTMLSelectElement).value) });
      if (!channels.has(currentChannel)) channels.set(currentChannel, []);
      syncChannels();
      showChannel(currentChannel);
      host.append(outputEl);
      api.setActions([channelSelect, h('button.icon-btn', { title: 'Очистить', innerHTML: icon('trash', 15), onclick: () => { channels.set(currentChannel, []); showChannel(currentChannel); } })]);
    },
  });

  commands.register({ id: 'terminal.new', title: 'Терминал: создать', category: 'Терминал', keybinding: 'ctrl+shift+`', inTerminal: true, run: () => newTerminal() });
  commands.register({ id: 'terminal.newAt', title: 'Терминал: создать в папке', hidden: true, run: (...a: never[]) => newTerminal({ cwd: (a as unknown as string[])[0] }) });
  commands.register({ id: 'terminal.toggle', title: 'Терминал: показать/скрыть', category: 'Терминал', keybinding: 'ctrl+`', inTerminal: true, run: () => { if (shell.panelVisible && shell.activePanel === 'terminal') shell.setPanel(false); else shell.showPanel('terminal'); } });
  commands.register({ id: 'terminal.kill', title: 'Терминал: закрыть текущий', category: 'Терминал', run: () => { if (activeTerm) closeTerm(activeTerm); } });
  commands.register({ id: 'terminal.clear', title: 'Терминал: очистить', category: 'Терминал', run: () => activeTerm?.xterm.clear() });
  commands.register({ id: 'view.problems', title: 'Вид: проблемы', category: 'Вид', keybinding: 'ctrl+shift+m', run: () => shell.showPanel('problems') });
  commands.register({ id: 'view.output', title: 'Вид: вывод', category: 'Вид', keybinding: 'ctrl+shift+u', run: () => shell.showPanel('output') });
}
