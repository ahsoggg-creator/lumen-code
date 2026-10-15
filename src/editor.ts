import type * as Mn from 'monaco-editor';
import { app, monaco as M } from './app';
import { commands } from './commands';
import { icon, fileIconInfo } from './icons';
import { ipc, errText } from './ipc';
import { settings, cfg } from './settings';
import { dialog, notify, showMenu } from './ui';
import { Emitter, basename, dirname, extname, h, key, norm, relative, uid } from './util';

// ================================================================= documents
export interface Doc {
  id: string;
  path: string | null;
  name: string;
  model: Mn.editor.ITextModel;
  encoding: string;
  mtime: number;
  savedVersion: number;
  dirty: boolean;
  /** Last disk mtime for which the "changed on disk" notice was shown. */
  warnedMtime: number;
}

const SPECIAL_LANG: Record<string, string> = {
  luau: 'lua', vue: 'html', svelte: 'html', env: 'ini', tscn: 'ini', tres: 'ini', godot: 'ini', cfg: 'ini', gdshader: 'cpp', jsonc: 'json', mdx: 'markdown',
  mjs: 'javascript', cjs: 'javascript', pyw: 'python', pyi: 'python', rbxlx: 'xml', csproj: 'xml', props: 'xml', gradle: 'java', toml: 'toml', gd: 'gdscript',
};
let extLang: Map<string, string> | null = null;
let nameLang: Map<string, string> | null = null;

export function languageFor(path: string): string {
  const mo = M();
  if (!extLang || !nameLang) {
    extLang = new Map();
    nameLang = new Map();
    for (const l of mo.languages.getLanguages()) {
      for (const e of l.extensions ?? []) if (!extLang.has(e.slice(1).toLowerCase())) extLang.set(e.slice(1).toLowerCase(), l.id);
      for (const f of l.filenames ?? []) nameLang.set(f.toLowerCase(), l.id);
    }
  }
  const name = basename(path).toLowerCase();
  const ext = extname(path);
  return nameLang.get(name) ?? SPECIAL_LANG[ext] ?? (name.startsWith('.env') ? 'ini' : undefined) ?? extLang.get(ext) ?? 'plaintext';
}

export const langLabel = (id: string): string => M().languages.getLanguages().find((l) => l.id === id)?.aliases?.[0] ?? id;

class Documents {
  readonly map = new Map<string, Doc>();
  untitled = 0;
  readonly onOpen = new Emitter<Doc>();
  readonly onClose = new Emitter<Doc>();
  readonly onSave = new Emitter<Doc>();
  readonly onDirty = new Emitter<Doc>();
  readonly onChange = new Emitter<Doc>();

  find(path: string): Doc | undefined { return this.map.get(key(path)); }
  all(): Doc[] { return [...this.map.values()]; }

  private track(doc: Doc): void {
    doc.model.onDidChangeContent(() => {
      const dirty = doc.model.getAlternativeVersionId() !== doc.savedVersion;
      this.onChange.fire(doc);
      if (dirty !== doc.dirty) {
        doc.dirty = dirty;
        this.onDirty.fire(doc);
      }
      if (dirty) this.scheduleAutoSave(doc);
    });
  }

  private timers = new Map<string, number>();
  private scheduleAutoSave(doc: Doc): void {
    if (cfg('files.autoSave') !== 'afterDelay' || !doc.path) return;
    clearTimeout(this.timers.get(doc.id));
    this.timers.set(doc.id, window.setTimeout(() => { if (doc.dirty) void this.save(doc); }, cfg<number>('files.autoSaveDelay')));
  }

  async open(path: string, encoding?: string): Promise<Doc | 'binary'> {
    const existing = this.find(path);
    if (existing) return existing;
    const data = await ipc.readFile(path, encoding);
    if (data.binary) return 'binary';
    const mo = M();
    const model = mo.editor.createModel(data.content, languageFor(path), mo.Uri.file(path));
    const doc: Doc = { id: uid('doc'), path: norm(path), name: basename(path), model, encoding: data.encoding, mtime: data.mtime, savedVersion: model.getAlternativeVersionId(), dirty: false, warnedMtime: 0 };
    this.map.set(key(path), doc);
    this.track(doc);
    this.onOpen.fire(doc);
    return doc;
  }

  createUntitled(text = '', language = 'plaintext'): Doc {
    const mo = M();
    const name = `Untitled-${++this.untitled}`;
    const model = mo.editor.createModel(text, language, mo.Uri.parse(`untitled:${name}`));
    const eol = cfg<string>('files.eol');
    if (eol === '\n' || eol === '\r\n') model.setEOL(eol === '\n' ? mo.editor.EndOfLineSequence.LF : mo.editor.EndOfLineSequence.CRLF);
    const doc: Doc = { id: uid('doc'), path: null, name, model, encoding: 'utf8', mtime: 0, savedVersion: model.getAlternativeVersionId(), dirty: text.length > 0, warnedMtime: 0 };
    this.map.set(`untitled:${name}`, doc);
    this.track(doc);
    this.onOpen.fire(doc);
    return doc;
  }

  async reload(doc: Doc, encoding?: string): Promise<void> {
    if (!doc.path) return;
    const data = await ipc.readFile(doc.path, encoding);
    if (data.binary) return;
    const full = doc.model.getFullModelRange();
    doc.model.pushEditOperations([], [{ range: full, text: data.content }], () => null);
    doc.encoding = data.encoding;
    doc.mtime = data.mtime;
    doc.savedVersion = doc.model.getAlternativeVersionId();
    doc.dirty = false;
    this.onDirty.fire(doc);
  }

  async save(doc: Doc, saveAsPath?: string): Promise<boolean> {
    let path = saveAsPath ?? doc.path;
    if (!path) {
      const picked = await pickSavePath(doc.name);
      if (!picked) return false;
      path = picked;
    }
    const mo = M();
    const m = doc.model;
    if (cfg('editor.trimTrailingWhitespace')) {
      const edits: Mn.editor.IIdentifiedSingleEditOperation[] = [];
      for (let i = 1; i <= m.getLineCount(); i++) {
        const last = m.getLineMaxColumn(i);
        const first = m.getLineLastNonWhitespaceColumn(i);
        if (first < last) edits.push({ range: new mo.Range(i, first, i, last), text: '' });
      }
      if (edits.length) m.pushEditOperations([], edits, () => null);
    }
    if (cfg('editor.insertFinalNewline')) {
      const n = m.getLineCount();
      if (m.getLineLength(n) > 0) m.pushEditOperations([], [{ range: new mo.Range(n, m.getLineMaxColumn(n), n, m.getLineMaxColumn(n)), text: m.getEOL() }], () => null);
    }
    try {
      const mtime = await ipc.writeFile(path, m.getValue(), doc.encoding);
      doc.mtime = mtime;
    } catch (e) {
      notify(`Не удалось сохранить: ${errText(e)}`, { kind: 'error' });
      return false;
    }
    if (!doc.path || key(doc.path) !== key(path)) await this.rebind(doc, path);
    doc.savedVersion = doc.model.getAlternativeVersionId();
    doc.dirty = false;
    this.onDirty.fire(doc);
    this.onSave.fire(doc);
    return true;
  }

  /** Moves a document to another path (save-as of an untitled doc, or a rename). */
  async rebind(doc: Doc, newPath: string): Promise<void> {
    const mo = M();
    const oldKey = doc.path ? key(doc.path) : `untitled:${doc.name}`;
    const text = doc.model.getValue();
    const eol = doc.model.getEOL();
    const old = doc.model;
    const model = mo.editor.createModel(text, languageFor(newPath), mo.Uri.file(newPath));
    model.setEOL(eol === '\n' ? mo.editor.EndOfLineSequence.LF : mo.editor.EndOfLineSequence.CRLF);
    this.map.delete(oldKey);
    doc.model = model;
    doc.path = norm(newPath);
    doc.name = basename(newPath);
    doc.savedVersion = model.getAlternativeVersionId();
    this.map.set(key(newPath), doc);
    this.track(doc);
    editors.swapModel(old, model);
    old.dispose();
    this.onChange.fire(doc);
  }

  dispose(doc: Doc): void {
    clearTimeout(this.timers.get(doc.id));
    this.map.delete(doc.path ? key(doc.path) : `untitled:${doc.name}`);
    doc.model.dispose();
    this.onClose.fire(doc);
  }
}

export const docs = new Documents();

async function pickSavePath(suggest: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const r = await save({ defaultPath: app.root ? `${app.root}\\${suggest}` : suggest });
  return r ?? null;
}

// ================================================================= tabs and groups
export interface ViewSpec {
  key: string;
  title: string;
  icon?: string;
  render: (host: HTMLElement) => void | (() => void);
}

interface Tab {
  id: string;
  kind: 'doc' | 'view' | 'diff';
  doc?: Doc;
  view?: ViewSpec;
  diff?: DiffSpec;
  preview: boolean;
  viewEl?: HTMLElement;
  viewDispose?: () => void;
  state?: Mn.editor.ICodeEditorViewState | null;
}

export interface DiffSpec {
  key: string;
  title: string;
  original: string;
  modifiedDoc?: Doc;
  modifiedText?: string;
  language: string;
  path?: string;
}

const tabKey = (t: Tab): string => (t.kind === 'doc' ? `doc:${t.doc!.id}` : t.kind === 'view' ? `view:${t.view!.key}` : `diff:${t.diff!.key}`);

function editorOptions(): Mn.editor.IEditorOptions & Mn.editor.IGlobalEditorOptions {
  const fs = cfg<number>('editor.fontSize');
  const lh = cfg<number>('editor.lineHeight');
  const smooth = cfg<boolean>('editor.smoothScrolling');
  return {
    fontFamily: cfg('editor.fontFamily'),
    fontSize: fs,
    fontLigatures: cfg('editor.fontLigatures'),
    lineHeight: lh > 0 ? lh : Math.round(fs * 1.6),
    letterSpacing: cfg('editor.letterSpacing'),
    tabSize: cfg('editor.tabSize'),
    insertSpaces: cfg('editor.insertSpaces'),
    detectIndentation: cfg('editor.detectIndentation'),
    wordWrap: cfg('editor.wordWrap'),
    lineNumbers: cfg('editor.lineNumbers'),
    minimap: { enabled: cfg('editor.minimap'), showSlider: 'mouseover', renderCharacters: false, maxColumn: 90, scale: 1 },
    renderWhitespace: cfg('editor.renderWhitespace'),
    renderLineHighlight: cfg('editor.renderLineHighlight'),
    rulers: cfg('editor.rulers'),
    cursorStyle: cfg('editor.cursorStyle'),
    cursorBlinking: cfg('editor.cursorBlinking'),
    cursorSmoothCaretAnimation: cfg('editor.smoothCaret') ? 'on' : 'off',
    smoothScrolling: smooth,
    bracketPairColorization: { enabled: cfg('editor.bracketPairColorization') },
    guides: { indentation: cfg('editor.guides'), bracketPairs: cfg('editor.guides') ? 'active' : false },
    stickyScroll: { enabled: cfg('editor.stickyScroll') },
    folding: cfg('editor.folding'),
    mouseWheelZoom: cfg('editor.mouseWheelZoom'),
    quickSuggestions: cfg<boolean>('editor.quickSuggestions') ? { other: true, comments: false, strings: false } : false,
    linkedEditing: cfg('editor.linkedEditing'),
    scrollBeyondLastLine: cfg('editor.scrollBeyondLastLine'),
    padding: { top: cfg<number>('editor.padding'), bottom: cfg<number>('editor.padding') },
    glyphMargin: false,
    lineDecorationsWidth: 10,
    roundedSelection: true,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
    overviewRulerBorder: false,
    contextmenu: true,
    dragAndDrop: true,
    multiCursorModifier: 'alt',
    unicodeHighlight: { ambiguousCharacters: false },
    accessibilitySupport: 'off',
    largeFileOptimizations: true,
  };
}

class Group {
  tabs: Tab[] = [];
  active: Tab | null = null;
  readonly el: HTMLElement;
  readonly tabbar: HTMLElement;
  readonly tabsEl: HTMLElement;
  readonly actionsEl: HTMLElement;
  readonly crumbs: HTMLElement;
  readonly body: HTMLElement;
  readonly host: HTMLElement;
  readonly viewHost: HTMLElement;
  readonly empty: HTMLElement;
  editor: Mn.editor.IStandaloneCodeEditor | null = null;
  diffEditor: Mn.editor.IStandaloneDiffEditor | null = null;
  diffModels: Mn.editor.ITextModel[] = [];
  gutter: Mn.editor.IEditorDecorationsCollection | null = null;

  constructor(readonly area: EditorArea) {
    this.tabsEl = h('div.tabs');
    this.actionsEl = h('div.tab-actions');
    this.tabbar = h('div.tabbar', null, this.tabsEl, this.actionsEl);
    this.crumbs = h('div.crumbs');
    this.host = h('div.monaco-host');
    this.viewHost = h('div.view-host');
    this.empty = h('div.empty-editor');
    this.body = h('div.group-body', null, this.host, this.viewHost, this.empty);
    this.el = h('div.group', { onmousedown: () => area.setActive(this) }, this.tabbar, this.crumbs, this.body);
    this.tabsEl.addEventListener('wheel', (e) => { this.tabsEl.scrollLeft += e.deltaY + e.deltaX; e.preventDefault(); }, { passive: false });
    this.tabbar.addEventListener('dblclick', (e) => { if (e.target === this.tabsEl || e.target === this.tabbar) void commands.execute('file.newUntitled'); });
    for (const el of [this.tabbar, this.body]) {
      el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('application/x-lumen-tab')) { e.preventDefault(); this.el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => this.el.classList.remove('drop'));
      el.addEventListener('drop', (e) => { this.el.classList.remove('drop'); area.dropTab(e, this, null); });
    }
  }

  ensureEditor(): Mn.editor.IStandaloneCodeEditor {
    if (this.editor) return this.editor;
    const mo = M();
    const ed = mo.editor.create(this.host, { model: null, ...editorOptions() });
    ed.onDidFocusEditorText(() => this.area.setActive(this));
    ed.onDidChangeCursorPosition(() => this.area.cursorMoved.fire(this));
    ed.onDidChangeCursorSelection(() => this.area.cursorMoved.fire(this));
    ed.onDidChangeModelContent(() => { const t = this.active; if (t?.preview) { t.preview = false; this.renderTabs(); } });
    ed.onMouseDown((e) => { if (e.event.ctrlKey && e.event.rightButton) e.event.preventDefault(); });
    this.editor = ed;
    this.area.editorCreated.fire(ed);
    return ed;
  }

  disposeDiff(): void {
    this.diffEditor?.dispose();
    this.diffEditor = null;
    for (const m of this.diffModels) if (!m.isDisposed() && !docsOwn(m)) m.dispose();
    this.diffModels = [];
  }

  show(tab: Tab | null, focus = true): void {
    if (this.active && this.active !== tab) this.saveState(this.active);
    this.active = tab;
    this.viewHost.replaceChildren();
    this.disposeDiff();
    this.host.style.display = 'none';
    this.viewHost.style.display = 'none';
    this.empty.style.display = 'none';
    if (!tab) {
      this.editor?.setModel(null);
      this.empty.style.display = '';
    } else if (tab.kind === 'doc') {
      this.host.style.display = '';
      const ed = this.ensureEditor();
      ed.setModel(tab.doc!.model);
      if (tab.state) ed.restoreViewState(tab.state);
      ed.layout();
      if (focus) ed.focus();
      void this.area.refreshGutter(this, tab.doc!);
    } else if (tab.kind === 'view') {
      this.viewHost.style.display = '';
      if (!tab.viewEl) {
        tab.viewEl = h('div.view');
        const d = tab.view!.render(tab.viewEl);
        if (typeof d === 'function') tab.viewDispose = d;
      }
      this.viewHost.append(tab.viewEl);
    } else {
      this.viewHost.style.display = '';
      this.mountDiff(tab);
    }
    this.renderTabs();
    this.renderCrumbs();
    this.area.activeChanged.fire(this);
  }

  private mountDiff(tab: Tab): void {
    const mo = M();
    const d = tab.diff!;
    const host = h('div.diff-host');
    this.viewHost.append(host);
    const orig = mo.editor.createModel(d.original, d.language);
    const mod = d.modifiedDoc ? d.modifiedDoc.model : mo.editor.createModel(d.modifiedText ?? '', d.language);
    this.diffModels = [orig, mod];
    const de = mo.editor.createDiffEditor(host, { ...editorOptions(), renderSideBySide: true, originalEditable: false, readOnly: !d.modifiedDoc, automaticLayout: true, renderOverviewRuler: false, ignoreTrimWhitespace: false });
    de.setModel({ original: orig, modified: mod });
    this.diffEditor = de;
    de.getModifiedEditor().onDidFocusEditorText(() => this.area.setActive(this));
  }

  saveState(tab: Tab): void {
    if (tab.kind === 'doc' && this.editor && this.editor.getModel() === tab.doc!.model) tab.state = this.editor.saveViewState();
  }

  renderCrumbs(): void {
    const t = this.active;
    this.crumbs.replaceChildren();
    const show = cfg<boolean>('workbench.breadcrumbs') && t?.kind === 'doc' && t.doc!.path;
    this.crumbs.style.display = show ? '' : 'none';
    if (!show) return;
    const p = t!.doc!.path!;
    const rel = app.root ? relative(app.root, p) : p;
    const parts = rel.split('\\');
    let acc = app.root && rel !== p ? app.root : '';
    parts.forEach((seg, i) => {
      acc = acc ? `${acc}\\${seg}` : seg;
      const target = acc;
      const last = i === parts.length - 1;
      this.crumbs.append(h('span', { class: `crumb ${last ? 'last' : ''}`, onclick: () => app.revealRequest.fire(target) }, seg));
      if (!last) this.crumbs.append(h('span.crumb-sep', { innerHTML: icon('chevronRight', 11) }));
    });
  }

  renderTabs(): void {
    const names = new Map<string, number>();
    for (const t of this.tabs) names.set(this.title(t), (names.get(this.title(t)) ?? 0) + 1);
    this.tabsEl.replaceChildren(...this.tabs.map((t) => this.tabEl(t, (names.get(this.title(t)) ?? 0) > 1)));
    this.tabsEl.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.renderActions();
  }

  title(t: Tab): string {
    return t.kind === 'doc' ? t.doc!.name : t.kind === 'view' ? t.view!.title : t.diff!.title;
  }

  private tabEl(t: Tab, ambiguous: boolean): HTMLElement {
    const doc = t.doc;
    const ic = t.kind === 'doc' ? fileIconInfo(doc!.name) : { icon: t.kind === 'diff' ? 'split' : t.view!.icon ?? 'file', color: 'text' };
    const dirty = !!doc?.dirty;
    const close = h('button', { class: `tab-close ${dirty ? 'dirty' : ''}`, title: 'Закрыть (Ctrl+W)', innerHTML: dirty ? '<i class="dot"></i>' + icon('x', 13) : icon('x', 13), onmousedown: (e: Event) => e.stopPropagation(), onclick: (e: Event) => { e.stopPropagation(); void this.area.closeTab(this, t); } });
    const el = h('div', {
      class: `tab ${t === this.active ? 'active' : ''} ${t.preview ? 'preview' : ''} ${this.area.activeGroup === this ? 'focused' : ''}`,
      draggable: true,
      title: doc?.path ?? this.title(t),
      onmousedown: (e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); void this.area.closeTab(this, t); } },
      onclick: () => { this.area.setActive(this); this.show(t); },
      ondblclick: () => { t.preview = false; this.renderTabs(); },
      oncontextmenu: (e: MouseEvent) => { e.preventDefault(); this.area.tabMenu(e, this, t); },
      ondragstart: (e: DragEvent) => { e.dataTransfer?.setData('application/x-lumen-tab', `${this.area.groups.indexOf(this)}:${t.id}`); e.dataTransfer!.effectAllowed = 'move'; },
      ondragover: (e: DragEvent) => { if (e.dataTransfer?.types.includes('application/x-lumen-tab')) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop-before'); } },
      ondragleave: () => el.classList.remove('drop-before'),
      ondrop: (e: DragEvent) => { el.classList.remove('drop-before'); e.stopPropagation(); this.area.dropTab(e, this, t); },
    },
      h('span', { class: `tab-ic c-${ic.color}`, innerHTML: icon(ic.icon, 14) }),
      h('span.tab-label', null, this.title(t)),
      ambiguous && doc?.path ? h('span.tab-dir', null, basename(dirname(doc.path))) : null,
      close);
    return el;
  }

  renderActions(): void {
    this.actionsEl.replaceChildren();
    const t = this.active;
    const btn = (ic: string, title: string, fn: () => void) => h('button.icon-btn', { title, innerHTML: icon(ic, 15), onclick: fn });
    if (t?.kind === 'doc') {
      const lang = t.doc!.model.getLanguageId();
      if (['python', 'javascript', 'typescript', 'lua', 'powershell', 'bat', 'go', 'rust', 'shell', 'ruby', 'php'].includes(lang) || cfg<Record<string, string>>('run.commands')[lang]) {
        this.actionsEl.append(btn('play', 'Запустить файл (F5)', () => void commands.execute('run.file')));
      }
      if (lang === 'markdown') this.actionsEl.append(btn('eye', 'Предпросмотр (Ctrl+Shift+V)', () => void commands.execute('markdown.preview')));
    }
    this.actionsEl.append(btn('split', 'Разделить редактор (Ctrl+\\)', () => this.area.splitRight()), btn('more', 'Ещё', () => { const r = this.actionsEl.getBoundingClientRect(); this.area.groupMenu(r.right - 180, r.bottom, this); }));
  }

  dispose(): void {
    this.disposeDiff();
    for (const t of this.tabs) t.viewDispose?.();
    this.editor?.dispose();
    this.el.remove();
  }
}

function docsOwn(m: Mn.editor.ITextModel): boolean {
  return docs.all().some((d) => d.model === m);
}

// ================================================================= editor area
export interface OpenOpts { line?: number; col?: number; endLine?: number; endCol?: number; preview?: boolean; focus?: boolean; group?: number }

class EditorArea {
  readonly el = h('div.groups');
  groups: Group[] = [];
  activeGroup!: Group;
  readonly activeChanged = new Emitter<Group>();
  readonly cursorMoved = new Emitter<Group>();
  readonly editorCreated = new Emitter<Mn.editor.IStandaloneCodeEditor>();
  readonly tabsChanged = new Emitter<void>();
  readonly gutterRequest = new Emitter<{ doc: Doc; editor: Mn.editor.IStandaloneCodeEditor; group: Group }>();
  private ready = false;

  init(): void {
    this.addGroup();
    this.ready = true;
    docs.onDirty.on((d) => { this.groups.forEach((g) => g.renderTabs()); this.tabsChanged.fire(); void d; });
    docs.onChange.on(() => { this.groups.forEach((g) => { g.renderTabs(); g.renderCrumbs(); }); });
    docs.onSave.on((d) => { for (const g of this.groups) if (g.active?.doc === d) void this.refreshGutter(g, d); });
    settings.changed.on((keys) => {
      if (keys.some((k) => k.startsWith('editor.') || k === 'keybindings')) this.applyOptions();
      if (keys.includes('workbench.breadcrumbs')) this.groups.forEach((g) => g.renderCrumbs());
    });
    window.addEventListener('blur', () => {
      if (cfg('files.autoSave') === 'onFocusChange') for (const d of docs.all()) if (d.dirty && d.path) void docs.save(d);
    });
  }

  applyOptions(): void {
    const o = editorOptions();
    const mo = M();
    for (const g of this.groups) {
      g.editor?.updateOptions(o);
      g.diffEditor?.updateOptions(o);
    }
    mo.editor.getModels().forEach((m) => m.updateOptions({ tabSize: cfg('editor.tabSize'), insertSpaces: cfg('editor.insertSpaces') }));
    const ts = mo.typescript;
    const semantic = cfg<boolean>('editor.semanticValidation');
    for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) d.setDiagnosticsOptions({ noSemanticValidation: !semantic, noSyntaxValidation: false });
  }

  private addGroup(afterIndex = this.groups.length - 1): Group {
    const g = new Group(this);
    this.groups.splice(afterIndex + 1, 0, g);
    this.layoutGroups();
    if (this.ready || this.groups.length === 1) this.activeGroup = this.activeGroup ?? g;
    g.show(null, false);
    return g;
  }

  private layoutGroups(): void {
    this.el.replaceChildren();
    this.groups.forEach((g, i) => {
      if (i > 0) {
        const grip = h('div.grip', { onmousedown: (e: MouseEvent) => this.dragGrip(e, this.groups[i - 1]!, g) });
        this.el.append(grip);
      }
      this.el.append(g.el);
    });
    this.el.classList.toggle('multi', this.groups.length > 1);
  }

  private dragGrip(e: MouseEvent, a: Group, b: Group): void {
    e.preventDefault();
    const startX = e.clientX;
    const wa = a.el.getBoundingClientRect().width;
    const wb = b.el.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      const d = Math.max(-wa + 160, Math.min(wb - 160, ev.clientX - startX));
      a.el.style.flex = `0 0 ${wa + d}px`;
      b.el.style.flex = `1 1 0`;
      b.el.style.width = '';
    };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  }

  setActive(g: Group): void {
    if (this.activeGroup === g) return;
    this.activeGroup = g;
    this.groups.forEach((x) => { x.el.classList.toggle('active-group', x === g); x.renderTabs(); });
    this.activeChanged.fire(g);
  }

  active(): { group: Group; tab: Tab | null; editor: Mn.editor.IStandaloneCodeEditor | null; doc: Doc | null } {
    const g = this.activeGroup;
    const doc = g.active?.kind === 'doc' ? g.active.doc! : null;
    return { group: g, tab: g.active, editor: doc ? g.editor : g.active?.kind === 'diff' ? g.diffEditor?.getModifiedEditor() ?? null : null, doc };
  }

  activeEditor(): Mn.editor.IStandaloneCodeEditor | null { return this.active().editor; }
  activeDoc(): Doc | null { return this.active().doc; }
  allEditors(): Mn.editor.IStandaloneCodeEditor[] { return this.groups.flatMap((g) => (g.editor ? [g.editor] : [])); }
  openDocs(): Doc[] { return [...new Set(this.groups.flatMap((g) => g.tabs.filter((t) => t.doc).map((t) => t.doc!)))]; }

  swapModel(oldM: Mn.editor.ITextModel, newM: Mn.editor.ITextModel): void {
    for (const g of this.groups) if (g.editor?.getModel() === oldM) { g.editor.setModel(newM); }
  }

  private findTab(k: string): { g: Group; t: Tab } | null {
    for (const g of this.groups) for (const t of g.tabs) if (tabKey(t) === k) return { g, t };
    return null;
  }

  private addTab(g: Group, tab: Tab, focus = true): void {
    if (tab.preview) {
      const old = g.tabs.find((t) => t.preview && !(t.doc?.dirty));
      if (old && old !== tab) { this.removeTab(g, old, false); }
    }
    const idx = g.active ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
    g.tabs.splice(idx, 0, tab);
    this.setActive(g);
    g.show(tab, focus);
    this.tabsChanged.fire();
  }

  async openFile(path: string, o: OpenOpts = {}): Promise<Doc | null> {
    const k = key(path);
    let existing: { g: Group; t: Tab } | null = null;
    for (const g of this.groups) for (const t of g.tabs) if (t.doc && t.doc.path && key(t.doc.path) === k) existing ??= { g, t };
    let doc: Doc;
    if (existing) {
      doc = existing.t.doc!;
      this.setActive(existing.g);
      if (o.preview === false) existing.t.preview = false;
      existing.g.show(existing.t, o.focus !== false);
    } else {
      let r: Doc | 'binary';
      try { r = await docs.open(path); } catch (e) { notify(`Не удалось открыть файл: ${errText(e)}`, { kind: 'error' }); return null; }
      if (r === 'binary') { this.openBinary(path); return null; }
      doc = r;
      const g = o.group != null ? this.groups[o.group] ?? this.activeGroup : this.activeGroup;
      this.addTab(g, { id: uid('tab'), kind: 'doc', doc, preview: !!o.preview }, o.focus !== false);
    }
    if (o.line) this.reveal(o.line, o.col ?? 1, o.endLine, o.endCol);
    return doc;
  }

  reveal(line: number, col = 1, endLine?: number, endCol?: number): void {
    const ed = this.active().editor;
    if (!ed) return;
    const mo = M();
    const range = new mo.Range(line, col, endLine ?? line, endCol ?? col);
    ed.setSelection(range);
    ed.revealRangeInCenterIfOutsideViewport(range, mo.editor.ScrollType.Smooth);
    ed.focus();
  }

  openDoc(doc: Doc, preview = false): void {
    for (const g of this.groups) { const t = g.tabs.find((x) => x.doc === doc); if (t) { this.setActive(g); g.show(t); return; } }
    this.addTab(this.activeGroup, { id: uid('tab'), kind: 'doc', doc, preview });
  }

  openView(spec: ViewSpec): void {
    const hit = this.findTab(`view:${spec.key}`);
    if (hit) { this.setActive(hit.g); hit.g.show(hit.t); return; }
    this.addTab(this.activeGroup, { id: uid('tab'), kind: 'view', view: spec, preview: false });
  }

  openDiff(spec: DiffSpec): void {
    const hit = this.findTab(`diff:${spec.key}`);
    if (hit) { hit.t.diff = spec; this.setActive(hit.g); hit.g.show(hit.t); return; }
    this.addTab(this.activeGroup, { id: uid('tab'), kind: 'diff', diff: spec, preview: true });
  }

  newUntitled(text = '', language = 'plaintext'): Doc {
    const doc = docs.createUntitled(text, language);
    this.addTab(this.activeGroup, { id: uid('tab'), kind: 'doc', doc, preview: false });
    return doc;
  }

  private async openBinary(path: string): Promise<void> {
    const ext = extname(path);
    const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp', svg: 'image/svg+xml' };
    if (mime[ext]) {
      try {
        const b64 = await ipc.readB64(path);
        this.openView({ key: `img:${key(path)}`, title: basename(path), icon: 'image', render: (host) => renderImage(host, path, `data:${mime[ext]};base64,${b64}`) });
      } catch (e) { notify(errText(e), { kind: 'error' }); }
      return;
    }
    this.openView({
      key: `bin:${key(path)}`, title: basename(path), icon: 'file',
      render: (host) => {
        host.append(h('div.binary', null, h('div.big', null, 'Двоичный файл'), h('div.dim', null, path),
          h('button.btn', { onclick: async () => { const d = await docs.open(path, 'windows1252'); if (d !== 'binary') this.openDoc(d); } }, 'Открыть как текст')));
      },
    });
  }

  async closeTab(g: Group, t: Tab, force = false): Promise<boolean> {
    if (t.kind === 'doc' && t.doc!.dirty && !force && this.docTabCount(t.doc!) === 1) {
      const r = await dialog('Несохранённые изменения', `Сохранить изменения в «${t.doc!.name}»?`, [{ label: 'Сохранить', primary: true }, { label: 'Не сохранять', danger: true }, { label: 'Отмена' }]);
      if (r === 0) { if (!(await docs.save(t.doc!))) return false; }
      else if (r !== 1) return false;
    }
    this.removeTab(g, t, true);
    return true;
  }

  private docTabCount(d: Doc): number {
    return this.groups.reduce((n, g) => n + g.tabs.filter((t) => t.doc === d).length, 0);
  }

  private removeTab(g: Group, t: Tab, activateNext: boolean): void {
    const i = g.tabs.indexOf(t);
    if (i < 0) return;
    if (g.active === t) g.saveState(t);
    g.tabs.splice(i, 1);
    t.viewDispose?.();
    if (t.doc && this.docTabCount(t.doc) === 0) docs.dispose(t.doc);
    if (g.active === t) {
      const next = activateNext ? g.tabs[Math.min(i, g.tabs.length - 1)] ?? null : null;
      g.active = null;
      if (next || activateNext) g.show(next, g === this.activeGroup);
    } else g.renderTabs();
    if (!g.tabs.length && this.groups.length > 1 && activateNext) this.closeGroup(g);
    this.tabsChanged.fire();
  }

  closeGroup(g: Group): void {
    const i = this.groups.indexOf(g);
    if (i < 0 || this.groups.length === 1) return;
    this.groups.splice(i, 1);
    g.dispose();
    this.layoutGroups();
    this.groups.forEach((x) => { x.el.style.flex = ''; });
    this.setActive(this.groups[Math.max(0, i - 1)]!);
    this.activeGroup.show(this.activeGroup.active, true);
  }

  async closeActive(): Promise<void> {
    const g = this.activeGroup;
    if (g.active) await this.closeTab(g, g.active);
    else if (this.groups.length > 1) this.closeGroup(g);
  }

  async closeMany(g: Group, pred: (t: Tab) => boolean): Promise<void> {
    for (const t of [...g.tabs].filter(pred)) if (!(await this.closeTab(g, t))) return;
  }

  async closeAll(): Promise<boolean> {
    for (const g of [...this.groups]) for (const t of [...g.tabs]) if (!(await this.closeTab(g, t))) return false;
    return true;
  }

  async saveAll(): Promise<void> {
    for (const d of docs.all()) if (d.dirty) await docs.save(d);
  }

  cycle(dir: 1 | -1): void {
    const g = this.activeGroup;
    if (g.tabs.length < 2 || !g.active) return;
    const i = (g.tabs.indexOf(g.active) + dir + g.tabs.length) % g.tabs.length;
    g.show(g.tabs[i]!);
  }

  splitRight(): void {
    const cur = this.activeGroup;
    const t = cur.active;
    const g = this.addGroup(this.groups.indexOf(cur));
    this.groups.forEach((x) => { x.el.style.flex = ''; });
    this.setActive(g);
    if (t?.kind === 'doc') this.addTab(g, { id: uid('tab'), kind: 'doc', doc: t.doc!, preview: false });
    else if (t?.kind === 'view') { /* views are single-instance; leave the new group empty */ }
  }

  focusGroup(delta: number): void {
    const i = this.groups.indexOf(this.activeGroup) + delta;
    const g = this.groups[i];
    if (g) { this.setActive(g); g.show(g.active, true); }
  }

  dropTab(e: DragEvent, target: Group, before: Tab | null): void {
    const data = e.dataTransfer?.getData('application/x-lumen-tab');
    if (!data) return;
    e.preventDefault();
    const [gi, tid] = data.split(':');
    const src = this.groups[Number(gi)];
    const tab = src?.tabs.find((t) => t.id === tid);
    if (!src || !tab) return;
    if (src === target) {
      src.tabs.splice(src.tabs.indexOf(tab), 1);
      const idx = before ? src.tabs.indexOf(before) : src.tabs.length;
      src.tabs.splice(idx, 0, tab);
      src.renderTabs();
      return;
    }
    if (tab.kind === 'view' && tab.viewEl) tab.viewEl = undefined;
    src.tabs.splice(src.tabs.indexOf(tab), 1);
    if (src.active === tab) { src.active = null; src.show(src.tabs[0] ?? null, false); }
    const idx = before ? target.tabs.indexOf(before) : target.tabs.length;
    target.tabs.splice(idx, 0, tab);
    this.setActive(target);
    target.show(tab);
    if (!src.tabs.length && this.groups.length > 1) this.closeGroup(src);
  }

  tabMenu(e: MouseEvent, g: Group, t: Tab): void {
    const path = t.doc?.path;
    showMenu(e.clientX, e.clientY, [
      { label: 'Закрыть', run: () => void this.closeTab(g, t), keybinding: 'ctrl+w' },
      { label: 'Закрыть остальные', run: () => void this.closeMany(g, (x) => x !== t) },
      { label: 'Закрыть справа', run: () => { const i = g.tabs.indexOf(t); void this.closeMany(g, (x) => g.tabs.indexOf(x) > i); } },
      { label: 'Закрыть все', run: () => void this.closeMany(g, () => true) },
      { separator: true },
      { label: t.preview ? 'Закрепить вкладку' : 'Вкладка закреплена', disabled: !t.preview, run: () => { t.preview = false; g.renderTabs(); } },
      { label: 'Разделить вправо', run: () => { this.setActive(g); g.show(t); this.splitRight(); }, disabled: t.kind !== 'doc' },
      { separator: true },
      { label: 'Копировать путь', disabled: !path, run: () => void navigator.clipboard.writeText(path!) },
      { label: 'Показать в проводнике Windows', disabled: !path, run: () => void ipc.reveal(path!) },
      { label: 'Показать в боковой панели', disabled: !path, run: () => app.revealRequest.fire(path!) },
    ]);
  }

  groupMenu(x: number, y: number, g: Group): void {
    showMenu(x, y, [
      { label: 'Закрыть все', run: () => void this.closeMany(g, () => true) },
      { label: 'Сохранить все', command: 'file.saveAll' },
      { separator: true },
      { label: 'Разделить вправо', run: () => { this.setActive(g); this.splitRight(); } },
      { label: 'Закрыть группу', disabled: this.groups.length < 2, run: () => this.closeGroup(g) },
    ]);
  }

  async refreshGutter(g: Group, doc: Doc): Promise<void> {
    const ed = g.editor;
    if (!ed || !doc.path) return;
    this.gutterRequest.fire({ doc, editor: ed, group: g });
  }

  /** Reacts to file-system events: reloads clean documents changed on disk, warns about dirty ones. */
  async onDiskChange(paths: string[]): Promise<void> {
    const changed = new Set(paths.map(key));
    for (const d of docs.all()) {
      if (!d.path || !changed.has(key(d.path))) continue;
      try {
        const data = await ipc.readFile(d.path);
        if (data.binary || data.mtime === d.mtime) continue;
        if (!d.dirty) { await docs.reload(d); }
        else if (d.warnedMtime !== data.mtime) {
          d.warnedMtime = data.mtime;
          notify(`«${d.name}» изменён на диске, а у вас есть несохранённые правки.`, { kind: 'warn', actions: [{ label: 'Загрузить с диска', run: () => void docs.reload(d) }, { label: 'Оставить мои', run: () => { d.mtime = data.mtime; } }], timeout: 0 });
        }
      } catch { /* deleted: keep the tab, the user may re-save */ }
    }
  }

  snapshot(): { groups: { tabs: string[]; active: number }[]; activeGroup: number } {
    return {
      groups: this.groups.map((g) => ({ tabs: g.tabs.filter((t) => t.doc?.path).map((t) => t.doc!.path!), active: Math.max(0, g.tabs.filter((t) => t.doc?.path).findIndex((t) => t === g.active)) })),
      activeGroup: this.groups.indexOf(this.activeGroup),
    };
  }

  async restore(s: ReturnType<EditorArea['snapshot']>): Promise<void> {
    for (let gi = 0; gi < s.groups.length; gi++) {
      if (gi > 0) { const g = this.addGroup(); this.setActive(g); }
      const sg = s.groups[gi]!;
      for (let i = 0; i < sg.tabs.length; i++) {
        if (!(await ipc.exists(sg.tabs[i]!))) continue;
        await this.openFile(sg.tabs[i]!, { focus: false, preview: false });
      }
      const g = this.groups[gi]!;
      const act = g.tabs[Math.min(sg.active, g.tabs.length - 1)];
      if (act) g.show(act, false);
    }
    const ag = this.groups[Math.min(s.activeGroup, this.groups.length - 1)];
    if (ag) this.setActive(ag);
  }

  rename(oldPath: string, newPath: string): void {
    const ok = key(oldPath);
    for (const d of docs.all()) {
      if (!d.path) continue;
      const dk = key(d.path);
      if (dk === ok || dk.startsWith(ok + '\\')) void docs.rebind(d, newPath + d.path.slice(oldPath.length));
    }
  }

  removed(path: string): void {
    const pk = key(path);
    for (const g of [...this.groups]) {
      for (const t of [...g.tabs]) {
        const p = t.doc?.path;
        if (p && (key(p) === pk || key(p).startsWith(pk + '\\')) && !t.doc!.dirty) this.removeTab(g, t, true);
      }
    }
  }
}

export const editors = new EditorArea();

function renderImage(host: HTMLElement, path: string, src: string): void {
  const info = h('span.dim');
  let fit = true;
  const img = h('img', { src, onload: () => { info.textContent = `${img.naturalWidth}×${img.naturalHeight}`; } });
  const wrap = h('div.img-wrap', null, img);
  const toggle = () => { fit = !fit; img.classList.toggle('fit', fit); };
  img.classList.add('fit');
  img.addEventListener('click', toggle);
  host.append(h('div.img-view', null, h('div.img-bar', null, h('span', null, basename(path)), info, h('button.btn', { onclick: toggle }, 'Размер: вписать / 100%')), wrap));
}

