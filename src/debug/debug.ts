import type * as Mn from 'monaco-editor';
import { app, monaco } from '../app';
import { commands } from '../commands';
import { docs, editors } from '../editor';
import { icon } from '../icons';
import { errText, ipc, on } from '../ipc';
import { runInTerminal } from '../panels';
import { runCurrent, fill } from '../run';
import { settings, cfg } from '../settings';
import { shell } from '../shell';
import { runTask } from '../tasks';
import { langForPath } from '../toolchains';
import { confirmDialog, inputBox, notify, section, showMenu } from '../ui';
import { basename, debounce, fmtSize, dirname, Emitter, h, key, uid } from '../util';
import { effectivePython } from '../views/python';
import { DapClient } from './dap';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Bp { line: number; condition?: string; logMessage?: string }
interface Frame { id: number; name: string; path?: string; line: number }
interface VarItem { name: string; value: string; type?: string; variablesReference: number }
interface Scope { name: string; ref: number }

interface AdapterCfg {
  kind: 'tcp-terminal' | 'stdio';
  command?: string;
  args?: string[];
  terminal?: string[];
  request: 'attach' | 'launch';
  adapterID: string;
  body: Record<string, unknown>;
  needs?: string;
  /** Adapter downloaded on request (see `adapters.rs`); `${adapter}` is the path of its program. */
  managed?: string;
  /** Commands run in the file's folder before the debugger starts; a failing one stops the launch. */
  build?: string[];
}


const nativeBody = { type: 'lldb', request: 'launch', program: '${out}', cwd: '${dir}', args: [], stopOnEntry: false };
const nativeAdapter = (build: string): AdapterCfg => ({ kind: 'tcp-terminal', terminal: ['"${adapter}" --port ${port}'], request: 'launch', adapterID: 'codelldb', body: nativeBody, managed: 'codelldb', build: [build] });

const BUILTIN: Record<string, AdapterCfg> = {
  python: { kind: 'tcp-terminal', terminal: ['"${python}" -m debugpy --listen 127.0.0.1:${port} --wait-for-client "${file}" ${args}'], request: 'attach', adapterID: 'python', body: { justMyCode: true }, needs: 'debugpy' },
  c: nativeAdapter('gcc -g -O0 "${file}" -o "${out}"'),
  cpp: nativeAdapter('g++ -g -O0 -std=c++17 "${file}" -o "${out}"'),
  rust: nativeAdapter('rustc -g "${file}" -o "${out}"'),
};

interface Session {
  client: DapClient;
  lang: string;
  state: 'starting' | 'running' | 'stopped';
  thread: number;
  frames: Frame[];
  frame: Frame | null;
  scopes: Scope[];
  vars: Map<number, VarItem[]>;
  file: string;
  watchRes: Map<string, string>;
}

const breakpoints = new Map<string, { path: string; list: Bp[] }>();
let watches: string[] = [];
let session: Session | null = null;
const changed = new Emitter<void>();
const consoleLines: { text: string; kind: 'out' | 'err' | 'in' | 'info' }[] = [];
let consoleEl: HTMLElement | null = null;
let toolbar: HTMLElement | null = null;
let statusIt: ReturnType<typeof shell.statusItem> | null = null;

export const isDebugging = (): boolean => !!session;

// ---------------------------------------------------------------- persistence
const storeKey = (): string => `lumen.bps.${app.root ? key(app.root) : ''}`;
function loadBps(): void {
  breakpoints.clear();
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey()) ?? '{}') as Record<string, Bp[]>;
    for (const [p, list] of Object.entries(raw)) if (list.length) breakpoints.set(key(p), { path: p, list });
    watches = JSON.parse(localStorage.getItem(`${storeKey()}.watch`) ?? '[]') as string[];
  } catch { /* ignore */ }
}
function saveBps(): void {
  try {
    localStorage.setItem(storeKey(), JSON.stringify(Object.fromEntries([...breakpoints.values()].filter((b) => b.list.length).map((b) => [b.path, b.list]))));
    localStorage.setItem(`${storeKey()}.watch`, JSON.stringify(watches));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- console
function out(text: string, kind: 'out' | 'err' | 'in' | 'info' = 'out'): void {
  consoleLines.push({ text, kind });
  if (consoleLines.length > 3000) consoleLines.shift();
  if (consoleEl) {
    consoleEl.append(h('div', { class: `dc-line ${kind}` }, text));
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
}

// ---------------------------------------------------------------- breakpoints + decorations
const decoStore = new WeakMap<Mn.editor.IStandaloneCodeEditor, Mn.editor.IEditorDecorationsCollection>();
const hooked = new WeakSet<Mn.editor.IStandaloneCodeEditor>();

function docOf(ed: Mn.editor.IStandaloneCodeEditor) { const m = ed.getModel(); return m ? docs.all().find((d) => d.model === m) ?? null : null; }

function paintDecorations(): void {
  const mo = monaco();
  for (const ed of editors.allEditors()) {
    const doc = docOf(ed);
    let coll = decoStore.get(ed);
    if (!coll) { coll = ed.createDecorationsCollection(); decoStore.set(ed, coll); }
    if (!doc?.path) { coll.clear(); continue; }
    const list = breakpoints.get(key(doc.path))?.list ?? [];
    const lines = doc.model.getLineCount();
    const decos: Mn.editor.IModelDeltaDecoration[] = list.map((b) => ({
      range: new mo.Range(Math.min(b.line, lines), 1, Math.min(b.line, lines), 1),
      options: {
        glyphMarginClassName: `bp-glyph${b.condition ? ' cond' : b.logMessage ? ' logp' : ''}`,
        glyphMarginHoverMessage: { value: b.condition ? `Условие: \`${b.condition}\`` : b.logMessage ? `Лог: \`${b.logMessage}\`` : 'Точка останова' },
        stickiness: mo.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));
    const f = session?.state === 'stopped' ? session.frame : null;
    if (f?.path && key(f.path) === key(doc.path)) {
      const ln = Math.min(f.line, lines);
      decos.push({ range: new mo.Range(ln, 1, ln, 1), options: { isWholeLine: true, className: 'dbg-line', glyphMarginClassName: 'dbg-arrow' } });
    }
    coll.set(decos);
  }
}

/** Breakpoints follow edits: read the tracked decoration positions back into our records. */
const syncFromDecorations = debounce(() => {
  let dirty = false;
  for (const ed of editors.allEditors()) {
    const doc = docOf(ed);
    const coll = decoStore.get(ed);
    const rec = doc?.path ? breakpoints.get(key(doc.path)) : null;
    if (!rec || !coll) continue;
    rec.list.forEach((b, i) => { const r = coll.getRange(i); if (r && r.startLineNumber !== b.line) { b.line = r.startLineNumber; dirty = true; } });
    const seen = new Set<number>();
    rec.list = rec.list.filter((b) => (seen.has(b.line) ? false : (seen.add(b.line), true)));
  }
  if (dirty) { saveBps(); changed.fire(); }
}, 250);

async function pushBreakpoints(path: string): Promise<void> {
  if (!session || session.state === 'starting') return;
  const list = breakpoints.get(key(path))?.list ?? [];
  try {
    await session.client.request('setBreakpoints', { source: { path, name: basename(path) }, breakpoints: list.map((b) => ({ line: b.line, condition: b.condition, logMessage: b.logMessage })), lines: list.map((b) => b.line), sourceModified: false });
  } catch (e) { out(`Точки останова: ${errText(e)}`, 'err'); }
}

function setBp(path: string, line: number, patch: Partial<Bp> | 'toggle' | 'remove'): void {
  const k = key(path);
  const rec = breakpoints.get(k) ?? { path, list: [] };
  const i = rec.list.findIndex((b) => b.line === line);
  if (patch === 'toggle') { if (i >= 0) rec.list.splice(i, 1); else rec.list.push({ line }); }
  else if (patch === 'remove') { if (i >= 0) rec.list.splice(i, 1); }
  else if (i >= 0) rec.list[i] = { line, ...patch }; else rec.list.push({ line, ...patch });
  rec.list.sort((a, b) => a.line - b.line);
  breakpoints.set(k, rec);
  saveBps();
  paintDecorations();
  changed.fire();
  void pushBreakpoints(path);
}

function hookEditor(ed: Mn.editor.IStandaloneCodeEditor): void {
  if (hooked.has(ed)) return;
  hooked.add(ed);
  ed.onDidChangeModel(() => paintDecorations());
  ed.onMouseDown((e) => {
    if (e.target.type !== monaco().editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const doc = docOf(ed);
    const line = e.target.position?.lineNumber;
    if (!doc?.path || !line) return;
    if (e.event.rightButton) {
      const has = breakpoints.get(key(doc.path))?.list.some((b) => b.line === line);
      showMenu(e.event.posx, e.event.posy, [
        { label: has ? 'Убрать точку останова' : 'Добавить точку останова', run: () => setBp(doc.path!, line, 'toggle') },
        { label: 'Условная точка…', run: async () => { const c = await inputBox({ title: `Остановиться на строке ${line}, если выражение истинно`, placeholder: 'x > 10' }); if (c) setBp(doc.path!, line, { condition: c }); } },
        { label: 'Лог-точка…', run: async () => { const m = await inputBox({ title: 'Сообщение (в фигурных скобках — выражения)', placeholder: 'x = {x}' }); if (m) setBp(doc.path!, line, { logMessage: m }); } },
      ]);
    } else setBp(doc.path, line, 'toggle');
  });
}

// ---------------------------------------------------------------- session
function userAdapters(): Record<string, AdapterCfg> { return { ...BUILTIN, ...(cfg<Record<string, AdapterCfg>>('debug.adapters') ?? {}) }; }
export const hasAdapter = (lang: string): boolean => lang in userAdapters();

function deepFill(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === 'string') return fill(v, vars);
  if (Array.isArray(v)) return v.map((x) => deepFill(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepFill(x, vars)]));
  return v;
}

async function ensureModule(python: string, mod: string): Promise<boolean> {
  const r = await ipc.exec(python, ['-c', `import ${mod}`], undefined, 15000);
  if (r.code === 0) return true;
  if (!(await confirmDialog('Нужен отладчик', `Для отладки Python требуется модуль ${mod}. Установить его через pip в выбранный интерпретатор?\n${python}`, 'Установить'))) return false;
  const toast = notify(`pip install ${mod}…`, { timeout: 0, progress: true });
  const code = await runTask(python, ['-m', 'pip', 'install', mod, '--disable-pip-version-check'], { onLine: (l) => out(l, 'info') }).done;
  toast.close();
  if (code !== 0) { notify(`Не удалось установить ${mod} (код ${code}). Подробности в консоли отладки.`, { kind: 'error' }); return false; }
  notify(`${mod} установлен`);
  return true;
}

const adaptersDir = (): string => `${app.paths.config}\\adapters`;

const ADAPTER_TITLE: Record<string, string> = { codelldb: 'CodeLLDB (отладчик C, C++ и Rust)' };

/** Path of a downloaded adapter; asks before downloading and shows exactly what will be fetched. */
async function ensureManaged(id: string): Promise<string | null> {
  const info = await ipc.adapterInfo(id, adaptersDir());
  if (info.entry) return info.entry;
  const title = ADAPTER_TITLE[id] ?? id;
  if (!(await confirmDialog('Нужен отладчик', `Для отладки нужен ${title} ${info.version}. Скачать его с GitHub и установить в папку программы?\n${info.url}\nSHA-256 пакета (проверяется перед установкой):\n${info.sha256}`, 'Скачать'))) return null;
  const toast = notify(`Скачиваю ${title}…`, { timeout: 0, progress: true });
  const un = await on<{ id: string; done: number; total: number }>('adapter-progress', (p) => {
    if (p.id === id) toast.update(`Скачиваю ${title}… ${fmtSize(p.done)}${p.total ? ` из ${fmtSize(p.total)}` : ''}`, p.total ? p.done / p.total : undefined);
  });
  try {
    const exe = await ipc.adapterInstall(id, adaptersDir());
    notify(`${title} установлен`);
    return exe;
  } catch (e) {
    notify(`Не удалось установить отладчик: ${errText(e)}`, { kind: 'error', timeout: 12000 });
    return null;
  } finally { un(); toast.close(); }
}

/** Compiles the program with debug information when the adapter config asks for it. */
async function buildFirst(adapter: AdapterCfg, vars: Record<string, string>, cwd: string): Promise<boolean> {
  for (const c of adapter.build ?? []) {
    const cmd = fill(c, vars);
    out(`$ ${cmd}`, 'info');
    const r = await ipc.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], cwd, 300000).catch((e) => ({ code: -1, stdout: '', stderr: errText(e) }));
    if (r.stdout.trim()) out(r.stdout.trim(), 'out');
    if (r.code !== 0) {
      out(r.stderr.trim() || `код ${r.code}`, 'err');
      shell.showPanel('debug');
      notify(`Сборка для отладки не удалась (код ${r.code}). Нужен установленный компилятор — см. «Языки и компиляторы».`, { kind: 'error', timeout: 9000 });
      return false;
    }
  }
  return true;
}

export async function startDebug(): Promise<void> {
  if (session) {
    if (session.state === 'stopped') { await control('continue'); }
    return;
  }
  const d = editors.activeDoc();
  if (!d) { notify('Откройте файл, который нужно отладить', { kind: 'warn' }); return; }
  if (d.dirty || !d.path) { if (!(await docs.save(d))) return; }
  const path = d.path!;
  const lang = langForPath(path)?.id ?? d.model.getLanguageId();
  const adapter = userAdapters()[lang];
  if (!adapter) {
    notify(`Для «${lang}» отладчик не настроен — запускаю без отладки. Подключить отладчик можно настройкой debug.adapters.`, { kind: 'warn', timeout: 7000 });
    await runCurrent();
    return;
  }
  const python = lang === 'python' ? await effectivePython() : 'python';
  if (adapter.needs && lang === 'python' && !(await ensureModule(python, adapter.needs))) return;

  const id = uid('dbg');
  const client = new DapClient(id);
  const port = await ipc.freePort();
  const vars: Record<string, string> = { file: path, dir: dirname(path), name: basename(path).replace(/\.[^.]+$/, ''), python, port: String(port), out: `${dirname(path)}\\${basename(path).replace(/\.[^.]+$/, '')}.exe`, adapter: '', workspace: app.root ?? dirname(path), args: cfg<string>('debug.args') ?? '' };
  if (adapter.managed) {
    const exe = await ensureManaged(adapter.managed);
    if (!exe) return;
    vars.adapter = exe;
  }
  if (!(await buildFirst(adapter, vars, dirname(path)))) return;
  session = { client, lang, state: 'starting', thread: 0, frames: [], frame: null, scopes: [], vars: new Map(), file: path, watchRes: new Map() };
  consoleLines.length = 0;
  consoleEl?.replaceChildren();
  shell.showView('debug');
  shell.showPanel('debug');
  setStatus();
  changed.fire();
  out(`▶ Отладка ${basename(path)}`, 'info');

  client.events.on((e) => void onEvent(e.event, e.body));
  client.closed.on(() => endSession('Соединение с отладчиком закрыто'));
  client.log.on((l) => out(l, 'err'));

  try {
    if (adapter.kind === 'tcp-terminal') {
      const cmds = (adapter.terminal ?? []).map((c) => fill(c, vars));
      void runInTerminal(cmds, { name: 'Отладка', cwd: dirname(path) });
      await client.connect('127.0.0.1', port, 30000);
    } else {
      await client.spawn(fill(adapter.command ?? '', vars), (adapter.args ?? []).map((a) => fill(a, vars)), dirname(path));
    }
    await handshake(client, adapter, vars, path);
    if (session) { session.state = 'running'; setStatus(); changed.fire(); }
  } catch (e) {
    out(`Ошибка запуска отладки: ${errText(e)}`, 'err');
    notify(`Отладка не запустилась: ${errText(e)}`, { kind: 'error' });
    endSession();
  }
}

async function handshake(client: DapClient, adapter: AdapterCfg, vars: Record<string, string>, path: string): Promise<void> {
  let gotInit: () => void = () => undefined;
  const initialized = new Promise<void>((r) => { gotInit = r; });
  client.events.on((e) => { if (e.event === 'initialized') gotInit(); });
  client.capabilities = await client.request('initialize', {
    clientID: 'lumen-code', clientName: 'Lumen Code', adapterID: adapter.adapterID, locale: 'ru', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
    supportsVariableType: true, supportsRunInTerminalRequest: false, supportsStartDebuggingRequest: false,
  }, 30000);
  const body = { ...(deepFill(adapter.body, vars) as Record<string, unknown>) };
  if (adapter.adapterID === 'python') body.justMyCode = cfg<boolean>('debug.justMyCode');
  const req = client.request(adapter.request, body, 180000).catch((e) => { out(`${adapter.request}: ${errText(e)}`, 'err'); endSession(); });
  await Promise.race([initialized, new Promise((_, rej) => setTimeout(() => rej(new Error('отладчик не прислал «initialized»')), 20000))]);
  for (const rec of breakpoints.values()) {
    if (!rec.list.length) continue;
    await client.request('setBreakpoints', { source: { path: rec.path, name: basename(rec.path) }, breakpoints: rec.list.map((b) => ({ line: b.line, condition: b.condition, logMessage: b.logMessage })), lines: rec.list.map((b) => b.line), sourceModified: false }).catch((e) => out(`Точки останова ${basename(rec.path)}: ${errText(e)}`, 'err'));
  }
  const mode = cfg<string>('debug.exceptions');
  const filters = mode === 'raised' ? ['raised', 'uncaught'] : mode === 'uncaught' ? ['uncaught'] : [];
  const supported = new Set<string>((client.capabilities.exceptionBreakpointFilters ?? []).map((f: any) => f.filter));
  await client.request('setExceptionBreakpoints', { filters: filters.filter((f) => !supported.size || supported.has(f)) }).catch(() => undefined);
  if (client.capabilities.supportsConfigurationDoneRequest !== false) await client.request('configurationDone');
  await req;
  void path;
}

async function onEvent(event: string, body: any): Promise<void> {
  const s = session;
  if (!s) return;
  if (event === 'stopped') {
    s.state = 'stopped';
    s.thread = body.threadId ?? s.thread;
    if (!s.thread) { const t = await s.client.request('threads').catch(() => ({ threads: [] })); s.thread = t.threads?.[0]?.id ?? 1; }
    out(`⏸ Остановка: ${body.reason ?? ''}${body.text ? ` — ${body.text}` : ''}`, 'info');
    await loadStack();
    shell.showView('debug');
    setStatus();
  } else if (event === 'continued') {
    s.state = 'running'; s.frame = null; s.frames = []; s.scopes = []; s.vars.clear();
    paintDecorations(); setStatus(); changed.fire();
  } else if (event === 'output') {
    const cat = body.category as string | undefined;
    if (cat === 'telemetry') return;
    if (cat === 'stdout' || cat === 'stderr') return; // the program writes to the terminal itself
    out(String(body.output ?? '').replace(/\n$/, ''), cat === 'important' ? 'err' : 'out');
  } else if (event === 'terminated' || event === 'exited') {
    if (event === 'exited') out(`Программа завершилась с кодом ${body.exitCode ?? '?'}`, 'info');
    if (event === 'terminated') endSession('Отладка завершена');
  }
}

async function loadStack(): Promise<void> {
  const s = session;
  if (!s) return;
  try {
    const st = await s.client.request('stackTrace', { threadId: s.thread, startFrame: 0, levels: 40 });
    s.frames = (st.stackFrames ?? []).map((f: any) => ({ id: f.id, name: f.name, path: f.source?.path, line: f.line }));
    await selectFrame(s.frames.find((f) => f.path) ?? s.frames[0] ?? null);
  } catch (e) { out(`Стек: ${errText(e)}`, 'err'); }
}

export async function selectFrame(f: Frame | null): Promise<void> {
  const s = session;
  if (!s) return;
  s.frame = f;
  s.vars.clear();
  s.scopes = [];
  if (f?.path) await editors.openFile(f.path, { line: f.line, col: 1, preview: false, focus: false });
  paintDecorations();
  if (f) {
    try {
      const sc = await s.client.request('scopes', { frameId: f.id });
      s.scopes = (sc.scopes ?? []).map((x: any) => ({ name: x.name, ref: x.variablesReference }));
      if (s.scopes[0]) await loadVars(s.scopes[0].ref);
    } catch (e) { out(`Переменные: ${errText(e)}`, 'err'); }
    await evalWatches();
  }
  changed.fire();
}

async function loadVars(ref: number): Promise<VarItem[]> {
  const s = session;
  if (!s) return [];
  const hit = s.vars.get(ref);
  if (hit) return hit;
  const r = await s.client.request('variables', { variablesReference: ref }).catch(() => ({ variables: [] }));
  const list: VarItem[] = (r.variables ?? []).map((v: any) => ({ name: v.name, value: String(v.value ?? ''), type: v.type, variablesReference: v.variablesReference ?? 0 }));
  s.vars.set(ref, list);
  return list;
}

async function evalWatches(): Promise<void> {
  const s = session;
  if (!s) return;
  s.watchRes.clear();
  for (const w of watches) {
    try { s.watchRes.set(w, (await s.client.request('evaluate', { expression: w, frameId: s.frame?.id, context: 'watch' })).result); }
    catch (e) { s.watchRes.set(w, `⚠ ${errText(e)}`); }
  }
}

export async function evaluateRepl(expr: string): Promise<void> {
  out(`> ${expr}`, 'in');
  const s = session;
  if (!s || s.state !== 'stopped') { out('Программа не приостановлена — выражения вычисляются только на точке останова.', 'info'); return; }
  try {
    const r = await s.client.request('evaluate', { expression: expr, frameId: s.frame?.id, context: 'repl' });
    out(String(r.result ?? ''), 'out');
    s.vars.clear();
    changed.fire();
  } catch (e) { out(errText(e), 'err'); }
}

function endSession(msg?: string): void {
  const s = session;
  if (!s) return;
  session = null;
  s.client.close();
  if (msg) out(`■ ${msg}`, 'info');
  paintDecorations();
  setStatus();
  changed.fire();
}

export async function control(action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause' | 'stop' | 'restart'): Promise<void> {
  const s = session;
  if (!s) { if (action === 'restart') await startDebug(); return; }
  try {
    if (action === 'stop' || action === 'restart') {
      const file = s.file;
      await s.client.request('disconnect', { terminateDebuggee: true }, 4000).catch(() => undefined);
      endSession('Отладка остановлена');
      if (action === 'restart') { await editors.openFile(file, { preview: false }); await startDebug(); }
      return;
    }
    if (action === 'pause') {
      if (!s.thread) { const t = await s.client.request('threads'); s.thread = t.threads?.[0]?.id ?? 1; }
      await s.client.request('pause', { threadId: s.thread });
      return;
    }
    if (s.state !== 'stopped') return;
    s.state = 'running';
    s.frame = null;
    paintDecorations();
    setStatus();
    changed.fire();
    await s.client.request(action, { threadId: s.thread });
  } catch (e) { out(errText(e), 'err'); }
}

function setStatus(): void {
  statusIt?.update(session ? { text: session.state === 'stopped' ? 'Отладка: пауза' : session.state === 'starting' ? 'Отладка: запуск…' : 'Отладка: выполняется', hidden: false, color: 'var(--peach)' } : { hidden: true });
  if (toolbar) toolbar.style.display = session ? '' : 'none';
  if (toolbar) {
    const stopped = session?.state === 'stopped';
    toolbar.querySelectorAll<HTMLButtonElement>('[data-needs-stop]').forEach((b) => { b.disabled = !stopped; });
    toolbar.querySelector<HTMLButtonElement>('[data-pause]')!.disabled = stopped || !session;
  }
}

// ---------------------------------------------------------------- UI
function varNode(v: VarItem, depth: number): HTMLElement {
  const wrap = h('div.var-node');
  const open = { v: false };
  const kids = h('div.var-kids');
  const row = h('div.var-row', { style: `padding-left:${8 + depth * 14}px`, title: `${v.name}${v.type ? `: ${v.type}` : ''} = ${v.value}` },
    h('span.tree-chev', { innerHTML: v.variablesReference ? icon('chevronRight', 12) : '' }), h('span.var-name', null, v.name), h('span.var-val', null, v.value));
  row.addEventListener('click', async () => {
    if (!v.variablesReference) return;
    open.v = !open.v;
    row.querySelector('.tree-chev')!.innerHTML = icon(open.v ? 'chevronDown' : 'chevronRight', 12);
    kids.replaceChildren();
    if (open.v) for (const c of await loadVars(v.variablesReference)) kids.append(varNode(c, depth + 1));
  });
  wrap.append(row, kids);
  return wrap;
}

function renderView(root: HTMLElement): void {
  const s = session;
  const bpAll = [...breakpoints.values()].flatMap((r) => r.list.map((b) => ({ path: r.path, b })));
  const doc = editors.activeDoc();
  const lang = doc?.path ? langForPath(doc.path)?.id ?? doc.model.getLanguageId() : '';
  const canDebug = hasAdapter(lang);
  root.replaceChildren(
    h('div.dbg-start', null,
      h('button.btn.primary.dbg-run', { onclick: () => void commands.execute('debug.start'), disabled: !!s && s.state !== 'stopped' }, h('span', { innerHTML: icon(s?.state === 'stopped' ? 'play' : 'bug', 15) }), s ? (s.state === 'stopped' ? 'Продолжить (F5)' : s.state === 'starting' ? 'Запуск…' : 'Выполняется…') : 'Начать отладку (F5)'),
      h('button.btn', { onclick: () => void commands.execute('run.file') }, h('span', { innerHTML: icon('play', 14) }), 'Без отладки (Ctrl+F5)'),
      !s ? h('div.dim.small.pad', null, doc ? (canDebug ? `Отладчик для «${lang}» доступен.` : `Для «${lang || 'этого файла'}» встроенного отладчика нет — F5 запустит файл без отладки. Свой отладчик подключается настройкой debug.adapters.`) : 'Откройте файл. Ставьте точки останова щелчком слева от номера строки (F9).') : null),
    section('Переменные', s?.state === 'stopped' ? s.scopes.map((sc) => {
      const box = h('div');
      const hd = h('div.var-scope', { onclick: async () => { if (box.childElementCount) { box.replaceChildren(); return; } for (const v of await loadVars(sc.ref)) box.append(varNode(v, 0)); } }, h('b', null, sc.name));
      if (s.scopes[0] === sc) for (const v of s.vars.get(sc.ref) ?? []) box.append(varNode(v, 0));
      return h('div', null, hd, box);
    }) : [h('div.dim.small.pad', null, s ? 'Доступно на точке останова' : 'Нет активной отладки')]),
    section('Наблюдение', [
      ...watches.map((w) => h('div.var-row', { style: 'padding-left:14px' }, h('span.var-name', null, w), h('span.var-val', null, s?.watchRes.get(w) ?? '—'),
        h('button.icon-btn', { title: 'Убрать', innerHTML: icon('x', 12), onclick: () => { watches = watches.filter((x) => x !== w); saveBps(); changed.fire(); } }))),
    ], { actions: [h('button.icon-btn', { title: 'Добавить выражение', innerHTML: icon('plus', 14), onclick: () => void commands.execute('debug.addWatch') })] }),
    section('Стек вызовов', s?.frames.length ? s.frames.map((f) => h('div', { class: `frame ${s.frame === f ? 'cur' : ''}`, onclick: () => void selectFrame(f) }, h('span', null, f.name), h('span.dim.small', null, f.path ? `${basename(f.path)}:${f.line}` : ''))) : [h('div.dim.small.pad', null, '—')]),
    section(`Точки останова · ${bpAll.length}`, bpAll.length ? bpAll.map(({ path, b }) => h('div.frame', { onclick: () => void editors.openFile(path, { line: b.line, preview: false }) },
      h('span.bp-dot', { class: b.condition ? 'cond' : b.logMessage ? 'logp' : '' }), h('span', null, `${basename(path)}:${b.line}`), h('span.dim.small', null, b.condition ?? b.logMessage ?? ''),
      h('button.icon-btn', { title: 'Убрать', innerHTML: icon('x', 12), onclick: (e: Event) => { e.stopPropagation(); setBp(path, b.line, 'remove'); } }))) : [h('div.dim.small.pad', null, 'Нет. Щёлкните слева от номера строки или нажмите F9.')],
    { actions: bpAll.length ? [h('button.icon-btn', { title: 'Убрать все', innerHTML: icon('trash', 14), onclick: () => void commands.execute('debug.removeAllBreakpoints') })] : [] }),
  );
}

export function registerDebug(): void {
  loadBps();
  statusIt = shell.statusItem({ id: 'debug', align: 'left', priority: 95, icon: 'bug', text: '', onClick: () => shell.showView('debug') });
  statusIt.update({ hidden: true });

  toolbar = h('div.dbg-toolbar', null,
    ...([['play', 'Продолжить (F5)', 'continue', true], ['pause', 'Пауза (F6)', 'pause', false], ['stepOver', 'Шаг с обходом (F10)', 'next', true], ['stepInto', 'Шаг внутрь (F11)', 'stepIn', true], ['stepOut', 'Шаг наружу (Shift+F11)', 'stepOut', true], ['refresh', 'Перезапустить (Ctrl+Shift+F5)', 'restart', false], ['stop', 'Остановить (Shift+F5)', 'stop', false]] as const)
      .map(([ic, title, act, needs]) => h('button', { class: `icon-btn dbg-btn ${act === 'stop' ? 'stop' : ''}`, title, innerHTML: icon(ic, 16), ...(needs ? { 'data-needs-stop': '' } : {}), ...(act === 'pause' ? { 'data-pause': '' } : {}), onclick: () => void control(act) })));
  toolbar.style.display = 'none';
  shell.main.append(toolbar);

  shell.registerView({
    id: 'debug', title: 'Запуск и отладка', icon: 'bug', order: 35,
    create(host) {
      const root = h('div.debug-view');
      host.append(root);
      const redraw = () => renderView(root);
      changed.on(redraw);
      editors.activeChanged.on(redraw);
      redraw();
    },
  });

  shell.registerPanel({
    id: 'debug', title: 'Консоль отладки', order: 15,
    create(host, api) {
      consoleEl = h('div.dbg-console');
      const input = h('input.dbg-input', { placeholder: 'Выражение для вычисления на точке останова…', spellcheck: false });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) { void evaluateRepl(input.value.trim()); input.value = ''; } e.stopPropagation(); });
      host.append(consoleEl, h('div.dbg-input-row', null, h('span', { innerHTML: icon('chevronRight', 14) }), input));
      for (const l of consoleLines) consoleEl.append(h('div', { class: `dc-line ${l.kind}` }, l.text));
      api.setActions([h('button.icon-btn', { title: 'Очистить', innerHTML: icon('trash', 15), onclick: () => { consoleLines.length = 0; consoleEl?.replaceChildren(); } })]);
    },
  });

  const C = (id: string, title: string, run: () => unknown, kb?: string, when?: () => boolean) => commands.register({ id, title, category: 'Отладка', keybinding: kb, when, run });
  C('debug.start', 'Начать отладку / продолжить', startDebug, 'f5');
  C('debug.stop', 'Остановить отладку', () => control('stop'), 'shift+f5', isDebugging);
  C('debug.restart', 'Перезапустить отладку', () => control('restart'), 'ctrl+shift+f5');
  C('debug.continue', 'Продолжить', () => control('continue'));
  C('debug.pause', 'Приостановить', () => control('pause'), 'f6', isDebugging);
  C('debug.stepOver', 'Шаг с обходом', () => control('next'), 'f10', isDebugging);
  C('debug.stepInto', 'Шаг внутрь', () => control('stepIn'), 'f11', isDebugging);
  C('debug.stepOut', 'Шаг наружу', () => control('stepOut'), 'shift+f11', isDebugging);
  C('debug.toggleBreakpoint', 'Поставить / убрать точку останова', () => { const { doc, editor } = editors.active(); const line = editor?.getPosition()?.lineNumber; if (doc?.path && line) setBp(doc.path, line, 'toggle'); }, 'f9');
  C('debug.addConditional', 'Условная точка останова…', async () => { const { doc, editor } = editors.active(); const line = editor?.getPosition()?.lineNumber; if (!doc?.path || !line) return; const c = await inputBox({ title: `Остановиться на строке ${line}, если выражение истинно`, placeholder: 'i == 5' }); if (c) setBp(doc.path, line, { condition: c }); });
  C('debug.removeAllBreakpoints', 'Убрать все точки останова', () => { const paths = [...breakpoints.values()].map((r) => r.path); breakpoints.clear(); saveBps(); paintDecorations(); changed.fire(); for (const p of paths) void pushBreakpoints(p); });
  C('debug.addWatch', 'Добавить выражение в наблюдение…', async () => { const e = await inputBox({ title: 'Выражение для наблюдения', placeholder: 'len(items)' }); if (e?.trim()) { watches.push(e.trim()); saveBps(); await evalWatches(); changed.fire(); shell.showView('debug'); } });
  C('debug.openConsole', 'Показать консоль отладки', () => shell.showPanel('debug'));
  C('debug.installDebugpy', 'Python: установить отладчик debugpy', async () => { await ensureModule(await effectivePython(), 'debugpy'); });

  editors.editorCreated.on((ed) => { hookEditor(ed); paintDecorations(); });
  for (const ed of editors.allEditors()) hookEditor(ed);
  editors.activeChanged.on(() => paintDecorations());
  editors.tabsChanged.on(() => paintDecorations());
  docs.onChange.on(() => syncFromDecorations());
  app.rootChanged.on(() => { if (session) return; loadBps(); paintDecorations(); changed.fire(); });
  settings.changed.on((k) => { if (k.includes('debug.adapters')) changed.fire(); });
}
