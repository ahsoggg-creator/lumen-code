import type * as M from 'monaco-editor';
import { app, monaco } from '../app';
import { docs, editors } from '../editor';
import { errText, ipc } from '../ipc';
import { log, revealChannel } from '../panels';
import { cfg, settings } from '../settings';
import { shell } from '../shell';
import { runTask } from '../tasks';
import { hasTool, rescanTools } from '../toolchains';
import { confirmDialog, notify, quickPick } from '../ui';
import { dirname, isUnder, join, key, uid } from '../util';
import { effectivePython, pythonChanged } from '../views/python';
import { LspClient, type Json } from './client';
import * as C from './convert';
import { BUILTIN_SERVERS, mergeServers, sectionOf, serverForLanguage, type ServerDef, type ServerOverride } from './servers';

type Status = 'starting' | 'ready' | 'error' | 'stopped';

interface OpenDoc { model: M.editor.ITextModel; version: number; opened: boolean; timer: number; subs: M.IDisposable[] }

interface Session {
  id: string;
  def: ServerDef;
  root: string;
  client: LspClient | null;
  status: Status;
  detail: string;
  caps: Json;
  settings: Record<string, unknown>;
  open: Map<string, OpenDoc>;
  diagnostics: Map<string, Json[]>;
  ready: Promise<void>;
}

const sessions = new Map<string, Session>();
const modelSession = new Map<string, Session>();
const providersFor = new Set<string>();
const offered = new Set<string>();
const attached = new Set<string>();
let statusItem: ReturnType<typeof shell.statusItem> | null = null;
let installing = false;

const channelOf = (def: ServerDef): string => `LSP: ${def.name}`;
const mo = (): typeof M => monaco();
const uriOf = (m: M.editor.ITextModel): string => m.uri.toString();
const serverDefs = (): ServerDef[] => mergeServers(cfg<Record<string, ServerOverride>>('lsp.servers'));

// ------------------------------------------------------------------ attaching documents

/** Starts tracking a model (and its server) if a language server exists for its language. */
export function attach(model: M.editor.ITextModel): void {
  if (!cfg('lsp.enabled') || model.uri.scheme !== 'file') return;
  const uri = uriOf(model);
  if (attached.has(uri)) return;
  const def = serverForLanguage(serverDefs(), model.getLanguageId());
  if (!def) return;
  attached.add(uri);
  ensureProviders(model.getLanguageId());
  const path = model.uri.fsPath;
  const root = app.root && isUnder(app.root, path) ? app.root : dirname(path);
  const s = sessionFor(def, root);
  const od: OpenDoc = { model, version: 1, opened: false, timer: 0, subs: [] };
  s.open.set(uri, od);
  modelSession.set(uri, s);
  od.subs.push(
    model.onDidChangeContent(() => { od.version++; clearTimeout(od.timer); od.timer = window.setTimeout(() => flush(s, od), 150); }),
    model.onDidChangeLanguage(() => { detach(model); attach(model); }),
  );
  if (s.status === 'ready') sendOpen(s, od);
  paintStatus();
}

export function detach(model: M.editor.ITextModel): void {
  const uri = uriOf(model);
  if (!attached.delete(uri)) return;
  const s = modelSession.get(uri);
  modelSession.delete(uri);
  const od = s?.open.get(uri);
  if (!s || !od) return;
  clearTimeout(od.timer);
  for (const d of od.subs) d.dispose();
  s.open.delete(uri);
  s.diagnostics.delete(uri);
  mo().editor.setModelMarkers(model, owner(s), []);
  if (od.opened && s.client?.alive) s.client.notify('textDocument/didClose', { textDocument: { uri } });
}

function sendOpen(s: Session, od: OpenDoc): void {
  if (od.opened || !s.client?.alive) return;
  od.opened = true;
  s.client.notify('textDocument/didOpen', { textDocument: { uri: uriOf(od.model), languageId: od.model.getLanguageId(), version: od.version, text: od.model.getValue() } });
}

function flush(s: Session, od: OpenDoc): void {
  if (!od.timer) return;
  clearTimeout(od.timer);
  od.timer = 0;
  if (!od.opened || !s.client?.alive) return;
  s.client.notify('textDocument/didChange', { textDocument: { uri: uriOf(od.model), version: od.version }, contentChanges: [{ text: od.model.getValue() }] });
}

/** Makes sure the server has seen the latest text before a request. */
function sync(s: Session, model: M.editor.ITextModel): void {
  const od = s.open.get(uriOf(model));
  if (od) flush(s, od);
}

function readySession(model: M.editor.ITextModel): Session | null {
  const s = modelSession.get(uriOf(model));
  if (!s || s.status !== 'ready' || !s.client?.alive) return null;
  sync(s, model);
  return s;
}

const owner = (s: Session): string => `lsp:${s.def.id}`;

// ------------------------------------------------------------------ sessions

function sessionFor(def: ServerDef, root: string): Session {
  const k = `${def.id}|${key(root)}`;
  let s = sessions.get(k);
  if (s) return s;
  s = { id: k, def, root, client: null, status: 'starting', detail: '', caps: {}, settings: {}, open: new Map(), diagnostics: new Map(), ready: Promise.resolve() };
  sessions.set(k, s);
  const session = s;
  s.ready = start(session).catch((e) => { fail(session, errText(e)); });
  return s;
}

function fail(s: Session, why: string): void {
  s.status = 'error';
  s.detail = why;
  log(channelOf(s.def), `Ошибка: ${why}`);
  paintStatus();
}

async function resolveCommand(def: ServerDef): Promise<string | null> {
  const dirs: string[] = [];
  if (def.pythonScripts) {
    const d = dirname(await effectivePython());
    dirs.push(d, join(d, 'Scripts'));
  }
  for (const h of def.homeDirs ?? []) dirs.push(join(app.paths.home, h));
  for (const name of def.commands) {
    if (/[\\/]/.test(name)) { if (await ipc.exists(name)) return name; continue; }
    for (const dir of dirs) {
      for (const ext of ['.exe', '.cmd', '']) {
        const p = join(dir, name + ext);
        if (await ipc.exists(p)) return p;
      }
    }
    if (await hasTool(name)) return name;
  }
  return null;
}

const CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    completion: { contextSupport: true, completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], deprecatedSupport: true, preselectSupport: true, insertReplaceSupport: true, labelDetailsSupport: true, resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] } } },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: false }, activeParameterSupport: true } },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentHighlight: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    formatting: {},
    rangeFormatting: {},
    rename: { prepareSupport: true },
    codeAction: { isPreferredSupport: true, resolveSupport: { properties: ['edit'] }, codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] } } },
    publishDiagnostics: { tagSupport: { valueSet: [1, 2] }, versionSupport: true },
  },
  workspace: { configuration: true, workspaceFolders: true, applyEdit: true, workspaceEdit: { documentChanges: true } },
  window: { workDoneProgress: true },
  general: { positionEncodings: ['utf-16'] },
};

async function start(s: Session): Promise<void> {
  const def = s.def;
  const program = await resolveCommand(def);
  if (!program) {
    fail(s, `не найден ${def.commands[0]}`);
    void offerInstall(def);
    return;
  }
  const user = cfg<Record<string, ServerOverride>>('lsp.servers')?.[def.id]?.settings;
  s.settings = { ...def.settings, ...(user ?? {}) };
  if (def.id === 'python') s.settings = { ...s.settings, python: { ...(s.settings.python as object), pythonPath: await effectivePython() } };

  const client = new LspClient(uid('lsp'));
  s.client = client;
  const channel = channelOf(def);
  client.log.on((line) => log(channel, line));
  client.closed.on(() => {
    const planned = !client.alive;
    client.markDead();
    clearMarkers(s);
    if (s.status !== 'error') s.status = 'stopped';
    paintStatus();
    if (!planned) notify(`Языковой сервер «${def.name}» завершился.`, { kind: 'warn', actions: [{ label: 'Перезапустить', run: () => restart(def.id) }] });
  });
  const folder = { uri: mo().Uri.file(s.root).toString(), name: s.root.split('\\').pop() || s.root };
  client.onNotification('textDocument/publishDiagnostics', (p) => publishDiagnostics(s, p));
  client.onNotification('window/logMessage', (p) => log(channel, p.message));
  client.onNotification('window/showMessage', (p) => log(channel, p.message));
  client.onNotification('$/progress', (p) => progress(s, p.value));
  client.onRequest('workspace/configuration', (p) => (p.items ?? []).map((i: Json) => sectionOf(s.settings, i.section)));
  client.onRequest('workspace/workspaceFolders', () => [folder]);
  client.onRequest('client/registerCapability', () => null);
  client.onRequest('client/unregisterCapability', () => null);
  client.onRequest('window/workDoneProgress/create', () => null);
  client.onRequest('window/showMessageRequest', () => null);
  client.onRequest('workspace/applyEdit', async (p) => ({ applied: await applyWorkspaceEdit(p.edit) }));

  log(channel, `Запуск: ${program} ${def.args.join(' ')} (${s.root})`);
  paintStatus();
  await client.spawn(program, def.args, s.root);
  const init = await client.request('initialize', {
    processId: null,
    clientInfo: { name: 'Lumen Code', version: app.version },
    rootUri: folder.uri,
    rootPath: s.root,
    workspaceFolders: [folder],
    capabilities: CAPABILITIES,
    locale: 'ru',
  }, 60000);
  s.caps = init?.capabilities ?? {};
  client.notify('initialized', {});
  if (Object.keys(s.settings).length) client.notify('workspace/didChangeConfiguration', { settings: s.settings });
  s.status = 'ready';
  s.detail = '';
  for (const od of s.open.values()) sendOpen(s, od);
  log(channel, 'Сервер готов');
  paintStatus();
}

function progress(s: Session, v: Json): void {
  if (!v) return;
  s.detail = v.kind === 'end' ? '' : [v.title, v.message].filter(Boolean).join(' ') || s.detail;
  paintStatus();
}

function clearMarkers(s: Session): void {
  for (const od of s.open.values()) { od.opened = false; mo().editor.setModelMarkers(od.model, owner(s), []); }
  s.diagnostics.clear();
}

async function stopSession(s: Session): Promise<void> {
  sessions.delete(s.id);
  const c = s.client;
  s.status = 'stopped';
  clearMarkers(s);
  for (const od of s.open.values()) { clearTimeout(od.timer); for (const d of od.subs) d.dispose(); attached.delete(uriOf(od.model)); modelSession.delete(uriOf(od.model)); }
  await c?.stop();
}

/** Stops sessions (all, or those of one server) and attaches the open files again, which starts fresh servers. */
export async function restart(serverId?: string): Promise<void> {
  const victims = [...sessions.values()].filter((s) => !serverId || s.def.id === serverId);
  const models = victims.flatMap((s) => [...s.open.values()].map((o) => o.model));
  await Promise.all(victims.map(stopSession));
  for (const m of models) if (!m.isDisposed()) attach(m);
  paintStatus();
}

function publishDiagnostics(s: Session, p: Json): void {
  const model = mo().editor.getModel(mo().Uri.parse(p.uri));
  if (!model || !s.open.has(uriOf(model))) return;
  s.diagnostics.set(uriOf(model), p.diagnostics ?? []);
  mo().editor.setModelMarkers(model, owner(s), (p.diagnostics ?? []).map(C.toMarker));
}

// ------------------------------------------------------------------ install

async function offerInstall(def: ServerDef): Promise<void> {
  if (offered.has(def.id) || cfg<string[]>('lsp.dismissed').includes(def.id)) return;
  offered.add(def.id);
  const dismiss = { label: 'Не предлагать', run: () => settings.set('lsp.dismissed', [...cfg<string[]>('lsp.dismissed'), def.id]) };
  if (!def.install) {
    notify(`Языковой сервер «${def.name}» не найден: ${def.commands[0]}. Проверьте настройку lsp.servers.`, { kind: 'warn', actions: def.url ? [{ label: 'Открыть страницу', run: () => void ipc.openUrl(def.url!) }, dismiss] : [dismiss] });
    return;
  }
  notify(`Для ${def.languages.join(', ')} можно установить языковой сервер «${def.install.label}»: автодополнение, подсказки, переход к определению, проверка кода.`, {
    timeout: 0,
    actions: [{ label: 'Установить', run: () => void installServer(def) }, dismiss],
  });
}

export async function installServer(def: ServerDef): Promise<void> {
  const inst = def.install;
  if (!inst || installing) return;
  const python = await effectivePython();
  const steps = inst.steps.map((st) => ({ program: st.program === '${python}' ? python : st.program, args: st.args }));
  const need = inst.needs === 'python' ? python : inst.needs;
  if (inst.needs !== 'python' && !(await hasTool(need))) {
    notify(`Для установки «${inst.label}» нужен ${need}, но он не найден.`, { kind: 'warn' });
    return;
  }
  const text = steps.map((st) => `${st.program} ${st.args.join(' ')}`).join('\n');
  if (!(await confirmDialog(`Установка: ${inst.label}`, `Будет выполнено:\n${text}\n\nПродолжить?`, 'Установить'))) return;
  installing = true;
  const toast = notify(`Установка «${inst.label}»…`, { progress: true, timeout: 0 });
  const channel = channelOf(def);
  try {
    for (const st of steps) {
      log(channel, `> ${st.program} ${st.args.join(' ')}`);
      const code = await runTask(st.program, st.args, { onLine: (line) => log(channel, line) }).done;
      if (code !== 0) throw new Error(`команда завершилась с кодом ${code}`);
    }
    await rescanTools();
    toast.close();
    notify(`«${inst.label}» установлен.`);
    offered.delete(def.id);
    await restart(def.id);
  } catch (e) {
    toast.close();
    notify(`Не удалось установить «${inst.label}»: ${errText(e)}`, { kind: 'error', actions: [{ label: 'Показать журнал', run: () => revealChannel(channel) }] });
  } finally {
    installing = false;
  }
}

// ------------------------------------------------------------------ workspace edits

/** Applies an LSP WorkspaceEdit: open files through Monaco (undoable), the others directly on disk. */
export async function applyWorkspaceEdit(we: Json): Promise<boolean> {
  const byUri = new Map<string, Json[]>();
  for (const [u, edits] of Object.entries<Json[]>(we?.changes ?? {})) byUri.set(u, [...(byUri.get(u) ?? []), ...edits]);
  for (const dc of we?.documentChanges ?? []) {
    if (dc.textDocument) byUri.set(dc.textDocument.uri, [...(byUri.get(dc.textDocument.uri) ?? []), ...dc.edits]);
    else log('Lumen Code', `LSP: операция «${dc.kind}» над файлами не поддерживается`);
  }
  try {
    for (const [u, edits] of byUri) {
      const uri = mo().Uri.parse(u);
      const model = mo().editor.getModel(uri);
      if (model) model.pushEditOperations([], C.toTextEdits(edits).map((e) => ({ range: e.range, text: e.text })), () => null);
      else {
        const f = await ipc.readFile(uri.fsPath);
        if (f.binary) continue;
        await ipc.writeFile(uri.fsPath, C.applyTextEdits(f.content, edits), f.encoding);
      }
    }
    return true;
  } catch (e) {
    notify(`Не удалось применить правки: ${errText(e)}`, { kind: 'error' });
    return false;
  }
}

/** For Monaco providers: only the open files go back to Monaco; edits to files on disk are written right away. */
async function monacoEdit(we: Json): Promise<{ edits: Json[] }> {
  const open: Json[] = [];
  const closed: Json = { changes: {} };
  const add = (u: string, edits: Json[]) => {
    const model = mo().editor.getModel(mo().Uri.parse(u));
    if (model) for (const e of C.toTextEdits(edits)) open.push({ resource: model.uri, textEdit: { range: e.range, text: e.text }, versionId: undefined });
    else closed.changes[u] = [...(closed.changes[u] ?? []), ...edits];
  };
  for (const [u, edits] of Object.entries<Json[]>(we?.changes ?? {})) add(u, edits);
  for (const dc of we?.documentChanges ?? []) if (dc.textDocument) add(dc.textDocument.uri, dc.edits);
  if (Object.keys(closed.changes).length) await applyWorkspaceEdit(closed);
  return { edits: open };
}

// ------------------------------------------------------------------ Monaco providers

const td = (model: M.editor.ITextModel) => ({ uri: uriOf(model) });
const pos = (p: M.Position) => C.fromPosition(p.lineNumber, p.column);

function locations(r: Json): Json[] {
  const list: Json[] = !r ? [] : Array.isArray(r) ? r : [r];
  return list.map((l) => ({ uri: mo().Uri.parse(l.targetUri ?? l.uri), range: C.toRange(l.targetSelectionRange ?? l.range) }));
}

function ensureProviders(lang: string): void {
  if (providersFor.has(lang)) return;
  providersFor.add(lang);
  const L = mo().languages;
  const ask = async <T>(model: M.editor.ITextModel, cap: string, method: string, params: Json): Promise<T | null> => {
    const s = readySession(model);
    if (!s || !s.caps[cap]) return null;
    try { return (await s.client!.request<T>(method, params)) ?? null; } catch (e) { log(channelOf(s.def), `${method}: ${errText(e)}`); return null; }
  };

  L.registerCompletionItemProvider(lang, {
    triggerCharacters: ['.', ':', '>', '<', '"', "'", '/', '@', '#'],
    async provideCompletionItems(model, position, context) {
      const s = readySession(model);
      if (!s || !s.caps.completionProvider) return null;
      if (context.triggerKind === 1 && !(s.caps.completionProvider.triggerCharacters ?? []).includes(context.triggerCharacter)) return null;
      const w = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
      try {
        const r = await s.client!.request<Json>('textDocument/completion', {
          textDocument: td(model), position: pos(position),
          // Monaco: Invoke 0, TriggerCharacter 1, Incomplete 2; LSP counts from 1.
          context: context.triggerKind === 1 ? { triggerKind: 2, triggerCharacter: context.triggerCharacter } : { triggerKind: context.triggerKind + 1 },
        });
        const items: Json[] = Array.isArray(r) ? r : r?.items ?? [];
        return { suggestions: items.map((i) => C.toCompletionItem(i, range)) as unknown as M.languages.CompletionItem[], incomplete: !!r?.isIncomplete };
      } catch { return null; }
    },
    async resolveCompletionItem(item) {
      const raw = (item as Json)._lsp;
      const s = [...sessions.values()].find((x) => x.status === 'ready' && x.def.languages.includes(lang));
      if (!raw || !s?.caps.completionProvider?.resolveProvider) return item;
      try {
        const r = await s.client!.request<Json>('completionItem/resolve', raw);
        if (r?.documentation) item.documentation = C.markdown(r.documentation);
        if (r?.detail) item.detail = r.detail;
        if (r?.additionalTextEdits) item.additionalTextEdits = C.toTextEdits(r.additionalTextEdits);
      } catch { /* keep the item as is */ }
      return item;
    },
  });

  L.registerHoverProvider(lang, {
    async provideHover(model, position) {
      const r = await ask<Json>(model, 'hoverProvider', 'textDocument/hover', { textDocument: td(model), position: pos(position) });
      const md = C.markdown(r?.contents);
      return md ? { range: r.range ? C.toRange(r.range) : undefined, contents: [md] } : null;
    },
  });

  L.registerSignatureHelpProvider(lang, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, position) {
      const r = await ask<Json>(model, 'signatureHelpProvider', 'textDocument/signatureHelp', { textDocument: td(model), position: pos(position) });
      return r?.signatures?.length ? { value: C.toSignatureHelp(r), dispose() { /* nothing to free */ } } : null;
    },
  });

  const nav = (cap: string, method: string) => async (model: M.editor.ITextModel, position: M.Position) =>
    locations(await ask<Json>(model, cap, method, { textDocument: td(model), position: pos(position) })) as unknown as M.languages.Location[];
  L.registerDefinitionProvider(lang, { provideDefinition: nav('definitionProvider', 'textDocument/definition') });
  L.registerTypeDefinitionProvider(lang, { provideTypeDefinition: nav('typeDefinitionProvider', 'textDocument/typeDefinition') });
  L.registerImplementationProvider(lang, { provideImplementation: nav('implementationProvider', 'textDocument/implementation') });
  L.registerReferenceProvider(lang, {
    async provideReferences(model, position, context) {
      return locations(await ask<Json>(model, 'referencesProvider', 'textDocument/references', { textDocument: td(model), position: pos(position), context: { includeDeclaration: context.includeDeclaration } })) as unknown as M.languages.Location[];
    },
  });

  L.registerDocumentHighlightProvider(lang, {
    async provideDocumentHighlights(model, position) {
      const r = await ask<Json[]>(model, 'documentHighlightProvider', 'textDocument/documentHighlight', { textDocument: td(model), position: pos(position) });
      return r?.map((h) => ({ range: C.toRange(h.range), kind: Math.max(0, (h.kind ?? 1) - 1) })) ?? null;
    },
  });

  L.registerDocumentSymbolProvider(lang, {
    async provideDocumentSymbols(model) {
      const r = await ask<Json[]>(model, 'documentSymbolProvider', 'textDocument/documentSymbol', { textDocument: td(model) });
      return r ? (C.toDocumentSymbols(r) as unknown as M.languages.DocumentSymbol[]) : null;
    },
  });

  const fmt = (model: M.editor.ITextModel, o: M.languages.FormattingOptions) => ({ textDocument: td(model), options: { tabSize: o.tabSize, insertSpaces: o.insertSpaces } });
  L.registerDocumentFormattingEditProvider(lang, {
    async provideDocumentFormattingEdits(model, o) {
      return C.toTextEdits(await ask<Json[]>(model, 'documentFormattingProvider', 'textDocument/formatting', fmt(model, o)));
    },
  });
  L.registerDocumentRangeFormattingEditProvider(lang, {
    async provideDocumentRangeFormattingEdits(model, range, o) {
      return C.toTextEdits(await ask<Json[]>(model, 'documentRangeFormattingProvider', 'textDocument/rangeFormatting', { ...fmt(model, o), range: C.fromRange(range) }));
    },
  });

  L.registerRenameProvider(lang, {
    async provideRenameEdits(model, position, newName) {
      const r = await ask<Json>(model, 'renameProvider', 'textDocument/rename', { textDocument: td(model), position: pos(position), newName });
      return r ? ((await monacoEdit(r)) as unknown as M.languages.WorkspaceEdit) : { edits: [], rejectReason: 'Сервер не смог переименовать этот символ' };
    },
    async resolveRenameLocation(model, position) {
      const s = readySession(model);
      if (!s?.caps.renameProvider?.prepareProvider) {
        const w = model.getWordAtPosition(position);
        if (!w) return { range: new (mo().Range)(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: 'Здесь нечего переименовывать' };
        return { range: new (mo().Range)(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn), text: w.word };
      }
      const r = await ask<Json>(model, 'renameProvider', 'textDocument/prepareRename', { textDocument: td(model), position: pos(position) });
      const range = r?.range ?? r;
      if (!range?.start) return { range: new (mo().Range)(1, 1, 1, 1), text: '', rejectReason: 'Здесь нечего переименовывать' };
      const mr = C.toRange(range);
      return { range: mr, text: r.placeholder ?? model.getValueInRange(mr) };
    },
  });

  L.registerCodeActionProvider(lang, {
    async provideCodeActions(model, range, context) {
      const s = readySession(model);
      if (!s || !s.caps.codeActionProvider) return null;
      const r = C.fromRange(range);
      const inside = (s.diagnostics.get(uriOf(model)) ?? []).filter((d) => d.range.start.line <= r.end.line && d.range.end.line >= r.start.line);
      let list: Json[] | null;
      try {
        list = await s.client!.request<Json[]>('textDocument/codeAction', { textDocument: td(model), range: r, context: { diagnostics: inside, only: context.only ? [context.only] : undefined, triggerKind: context.trigger } });
      } catch { return null; }
      const actions: M.languages.CodeAction[] = [];
      for (const a of list ?? []) {
        if (!C.codeActionKindOk(a.kind, context.only)) continue;
        let act = a;
        if (!act.edit && !act.command?.command && act.data !== undefined && s.caps.codeActionProvider.resolveProvider) act = await s.client!.request<Json>('codeAction/resolve', act).catch(() => a);
        const action: M.languages.CodeAction = { title: act.title, kind: act.kind, isPreferred: act.isPreferred };
        if (act.edit) action.edit = (await monacoEdit(act.edit)) as unknown as M.languages.WorkspaceEdit;
        const cmd = act.command?.command ? act.command : typeof act.command === 'string' ? act : null;
        if (cmd) action.command = { id: 'lumen.lsp.exec', title: act.title, arguments: [s.id, cmd.command, cmd.arguments] };
        if (action.edit || action.command) actions.push(action);
      }
      return { actions, dispose() { /* nothing to free */ } };
    },
  });
}

// ------------------------------------------------------------------ status bar and commands

function activeSession(): Session | null {
  const m = editors.activeDoc()?.model;
  return m ? modelSession.get(uriOf(m)) ?? null : null;
}

export function paintStatus(): void {
  if (!statusItem) return;
  const s = activeSession();
  if (!s) { statusItem.update({ hidden: true }); return; }
  const text = s.status === 'ready' ? `${s.def.name.split(' ')[0]}` : s.status === 'starting' ? `${s.def.name.split(' ')[0]}…` : s.status === 'error' ? `${s.def.name.split(' ')[0]}: нет` : `${s.def.name.split(' ')[0]}: остановлен`;
  const tip = { ready: 'Языковой сервер работает', starting: 'Языковой сервер запускается', error: s.detail || 'Языковой сервер не запущен', stopped: 'Языковой сервер остановлен' }[s.status];
  statusItem.update({ hidden: false, text, tooltip: `${s.def.name}\n${tip}${s.status === 'ready' && s.detail ? `\n${s.detail}` : ''}\nНажмите для действий`, color: s.status === 'error' ? 'var(--red, #f38ba8)' : '' });
}

async function menu(): Promise<void> {
  const s = activeSession();
  if (!s) return;
  const items = [
    { label: 'Перезапустить сервер', value: 'restart', icon: 'refresh' },
    { label: 'Показать журнал', value: 'log', icon: 'terminal' },
    ...(s.status === 'error' && s.def.install ? [{ label: `Установить «${s.def.install.label}»`, value: 'install', icon: 'download' }] : []),
  ];
  const pick = await quickPick(items, { placeholder: s.def.name });
  if (pick?.value === 'restart') await restart(s.def.id);
  else if (pick?.value === 'log') revealChannel(channelOf(s.def));
  else if (pick?.value === 'install') await installServer(s.def);
}

let started = false;

/** Called once, when the first file with a known server appears. */
export function startManager(): void {
  if (started) return;
  started = true;
  const m = mo();
  statusItem = shell.statusItem({ id: 'lsp', align: 'right', priority: 45, icon: 'zap', text: 'LSP', onClick: () => void menu() });
  statusItem.update({ hidden: true });
  m.editor.onDidCreateModel(attach);
  m.editor.onWillDisposeModel(detach);
  for (const model of m.editor.getModels()) attach(model);
  m.editor.registerCommand('lumen.lsp.exec', async (_accessor, sid: string, command: string, args: unknown[]) => {
    const s = sessions.get(sid);
    try { await s?.client?.request('workspace/executeCommand', { command, arguments: args ?? [] }); } catch (e) { notify(`Команда сервера не выполнена: ${errText(e)}`, { kind: 'error' }); }
  });
  // Go to a definition in a file that is not open: Monaco asks the host to open it.
  m.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selection) {
      if (resource.scheme !== 'file') return false;
      const sel = selection as M.IRange | undefined;
      void editors.openFile(resource.fsPath, { line: sel?.startLineNumber ?? (selection as M.IPosition | undefined)?.lineNumber, col: sel?.startColumn ?? (selection as M.IPosition | undefined)?.column });
      return true;
    },
  });
  editors.activeChanged.on(paintStatus);
  docs.onSave.on((d) => {
    const s = modelSession.get(uriOf(d.model));
    if (s?.status === 'ready') { sync(s, d.model); s.client!.notify('textDocument/didSave', { textDocument: td(d.model), text: d.model.getValue() }); }
  });
  app.rootChanged.on(() => void restart());
  pythonChanged.on(() => void restart('python'));
  settings.changed.on((keys) => { if (keys.some((k) => k === 'lsp.servers' || k === 'lsp.enabled')) void restart(); });
}

export const serverIds = (): string[] => BUILTIN_SERVERS.map((s) => s.id);
