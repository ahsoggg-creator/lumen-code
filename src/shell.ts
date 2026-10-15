import { getCurrentWindow } from '@tauri-apps/api/window';
import { app } from './app';
import { bindingFor, commands } from './commands';
import { icon } from './icons';
import { settings, cfg } from './settings';
import { closeMenus, showMenu, type MenuItem } from './ui';
import { Emitter, basename, disposable, h, type Disposable } from './util';

// ================================================================= views (sidebar) and panels
export interface SideView {
  id: string;
  title: string;
  icon: string;
  location?: 'primary' | 'secondary';
  order?: number;
  create: (host: HTMLElement, api: { setActions(actions: HTMLElement[]): void; setBadge(n: number | string | null): void }) => void | (() => void);
  onShow?: () => void;
}

export interface PanelView {
  id: string;
  title: string;
  order?: number;
  create: (host: HTMLElement, api: { setActions(actions: HTMLElement[]): void; setBadge(n: number | string | null): void }) => void;
  onShow?: () => void;
}

const LS = {
  get(k: string, d: string): string { try { return localStorage.getItem(`lumen.${k}`) ?? d; } catch { return d; } },
  set(k: string, v: string): void { try { localStorage.setItem(`lumen.${k}`, v); } catch { /* private mode */ } },
};
export const ls = LS;

class Shell {
  readonly root = h('div#shell');
  readonly titlebar = h('div.titlebar', { 'data-tauri-drag-region': '' });
  readonly menubar = h('div.menubar');
  readonly activity = h('div.activitybar');
  readonly activityTop = h('div.act-top');
  readonly activityBottom = h('div.act-bottom');
  readonly sidebar = h('div.sidebar');
  readonly sideHead = h('div.side-head');
  readonly sideTitle = h('span.side-title');
  readonly sideActions = h('span.side-actions');
  readonly sideBody = h('div.side-body');
  readonly sidebar2 = h('div.sidebar.secondary');
  readonly side2Head = h('div.side-head');
  readonly side2Title = h('span.side-title');
  readonly side2Actions = h('span.side-actions');
  readonly side2Body = h('div.side-body');
  readonly main = h('div.main');
  readonly editorHost = h('div.editor-host');
  readonly panel = h('div.panel');
  readonly panelTabs = h('div.panel-tabs');
  readonly panelActions = h('span.panel-actions');
  readonly panelBody = h('div.panel-body');
  readonly statusLeft = h('div.status-left');
  readonly statusRight = h('div.status-right');
  readonly statusbar = h('div.statusbar', null, this.statusLeft, h('div.status-spacer'), this.statusRight);
  readonly centerText = h('span.cc-text');
  readonly titleRight = h('div.title-right');
  readonly workbench = h('div.workbench');

  private views = new Map<string, SideView>();
  private viewHosts = new Map<string, HTMLElement>();
  private viewActions = new Map<string, HTMLElement[]>();
  private viewBadges = new Map<string, HTMLElement>();
  private actBtns = new Map<string, HTMLElement>();
  private panels = new Map<string, PanelView>();
  private panelHosts = new Map<string, HTMLElement>();
  private panelBadges = new Map<string, HTMLElement>();
  private panelBtns = new Map<string, HTMLElement>();
  activeView: string | null = null;
  activeSecondary: string | null = null;
  activePanel: string | null = null;
  sidebarVisible = true;
  sidebar2Visible = false;
  panelVisible = false;
  zen = false;
  readonly layoutChanged = new Emitter<void>();
  readonly panelShown = new Emitter<string>();
  readonly viewShown = new Emitter<string>();

  build(): HTMLElement {
    this.buildTitlebar();
    this.activity.append(this.activityTop, this.activityBottom);
    this.sideHead.append(this.sideTitle, this.sideActions);
    this.sidebar.append(this.sideHead, this.sideBody);
    this.side2Head.append(this.side2Title, this.side2Actions);
    this.sidebar2.append(this.side2Head, this.side2Body);
    this.panel.append(h('div.panel-head', null, this.panelTabs, h('div.panel-spacer'), this.panelActions,
      h('button.icon-btn', { title: 'Развернуть панель', innerHTML: icon('chevronUp', 15), onclick: () => this.togglePanelMax() }),
      h('button.icon-btn', { title: 'Закрыть панель', innerHTML: icon('x', 15), onclick: () => this.setPanel(false) })), this.panelBody);
    const sash1 = this.sash(this.sidebar, 'v', 'sidebarW', 270, 160, 700, () => this.isRightSide());
    const sash2 = this.sash(this.sidebar2, 'v', 'sidebar2W', 380, 240, 800, () => !this.isRightSide());
    sash1.classList.add('s-side');
    sash2.classList.add('s-side2');
    const sash3 = this.sash(this.panel, 'h', 'panelH', 280, 90, 900);
    this.main.append(this.editorHost, sash3, this.panel);
    this.workbench.append(this.activity, this.sidebar, sash1, this.main, sash2, this.sidebar2);
    this.root.append(this.titlebar, this.workbench, this.statusbar);
    this.applyLayout();
    window.addEventListener('mousedown', (e) => { if (!(e.target as HTMLElement | null)?.closest?.('.menubar')) this.closeMenubar(); });
    return this.root;
  }

  private isRightSide(): boolean { return cfg('workbench.sidebarPosition') === 'right'; }

  // ---- sash
  private sash(target: HTMLElement, dir: 'v' | 'h', lsKey: string, def: number, min: number, max: number, invert: () => boolean = () => false): HTMLElement {
    const size = Number(LS.get(lsKey, String(def)));
    this.setSize(target, dir, size);
    const s = h('div', { class: `sash ${dir}` });
    s.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const start = dir === 'v' ? e.clientX : e.clientY;
      const startSize = dir === 'v' ? target.getBoundingClientRect().width : target.getBoundingClientRect().height;
      s.classList.add('drag');
      document.body.classList.add('dragging', dir === 'v' ? 'dragging-v' : 'dragging-h');
      const move = (ev: MouseEvent) => {
        const d = (dir === 'v' ? ev.clientX : ev.clientY) - start;
        const next = Math.max(min, Math.min(max, startSize + (dir === 'v' ? (invert() ? -d : d) : -d)));
        this.setSize(target, dir, next);
        LS.set(lsKey, String(Math.round(next)));
      };
      const up = () => {
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        s.classList.remove('drag');
        document.body.classList.remove('dragging', 'dragging-v', 'dragging-h');
        this.layoutChanged.fire();
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    s.addEventListener('dblclick', () => { this.setSize(target, dir, def); LS.set(lsKey, String(def)); this.layoutChanged.fire(); });
    return s;
  }

  private setSize(el: HTMLElement, dir: 'v' | 'h', n: number): void {
    if (dir === 'v') el.style.width = `${n}px`; else el.style.height = `${n}px`;
  }

  // ---- titlebar
  private buildTitlebar(): void {
    const win = getCurrentWindow();
    const winBtn = (cls: string, ic: string, title: string, fn: () => void) => h('button', { class: `win-btn ${cls}`, title, innerHTML: icon(ic, 14), onclick: fn });
    const maxBtn = winBtn('max', 'maximize', 'Развернуть', () => void win.toggleMaximize());
    const syncMax = async () => { const m = await win.isMaximized(); maxBtn.innerHTML = icon(m ? 'restore' : 'maximize', 12); };
    void win.onResized(() => void syncMax());
    void syncMax();
    const logo = h('span.logo', { innerHTML: icon('logo', 18), 'data-tauri-drag-region': '' });
    const cc = h('button.command-center', { title: 'Быстрый поиск (Ctrl+P)', onclick: () => void commands.execute('palette.quickOpen') }, h('span', { innerHTML: icon('search', 13) }), this.centerText);
    this.titleRight.append(
      this.tbToggle('play', 'Запустить файл (Ctrl+F5)', 'run.file'),
      this.tbToggle('bug', 'Отладка (F5)', 'debug.start'),
      this.tbToggle('sidebar', 'Боковая панель (Ctrl+B)', 'view.toggleSidebar'),
      this.tbToggle('panel', 'Нижняя панель (Ctrl+J)', 'view.togglePanel'),
      this.tbToggle('sidebarRight', 'Чат с ИИ (Ctrl+Alt+I)', 'ai.toggleChat'),
    );
    this.titlebar.append(logo, this.menubar, h('div.title-drag', { 'data-tauri-drag-region': '' }), cc, h('div.title-drag', { 'data-tauri-drag-region': '' }), this.titleRight,
      h('div.win-controls', null, winBtn('min', 'winMin', 'Свернуть', () => void win.minimize()), maxBtn, winBtn('close', 'x', 'Закрыть', () => void win.close())));
    this.titlebar.addEventListener('dblclick', (e) => { if ((e.target as HTMLElement).hasAttribute('data-tauri-drag-region')) void win.toggleMaximize(); });
  }

  private tbToggle(ic: string, title: string, cmd: string): HTMLElement {
    return h('button.icon-btn.tb-btn', { title, innerHTML: icon(ic, 16), onclick: () => void commands.execute(cmd) });
  }

  setCenterText(s: string): void { this.centerText.textContent = s; }

  // ---- menubar
  private menuOpen = false;
  private openBtn: HTMLElement | null = null;

  setMenus(defs: { label: string; items: () => MenuItem[] }[]): void {
    this.menubar.replaceChildren(...defs.map((d) => {
      const b = h('button.menu-btn', { onclick: () => this.openMenu(b, d.items), onmouseenter: () => { if (this.menuOpen && this.openBtn !== b) this.openMenu(b, d.items); } }, d.label);
      return b;
    }));
  }

  private openMenu(btn: HTMLElement, items: () => MenuItem[]): void {
    this.closeMenubar();
    const r = btn.getBoundingClientRect();
    btn.classList.add('open');
    this.openBtn = btn;
    this.menuOpen = true;
    showMenu(r.left, r.bottom + 2, items());
  }

  private closeMenubar(): void {
    this.menuOpen = false;
    this.openBtn?.classList.remove('open');
    this.openBtn = null;
    closeMenus();
  }

  // ---- activity bar and views
  registerView(v: SideView): Disposable {
    const loc = v.location ?? 'primary';
    this.views.set(v.id, v);
    if (loc === 'primary') {
      const badge = h('span.act-badge');
      badge.style.display = 'none';
      this.viewBadges.set(v.id, badge);
      const b = h('button', { class: 'act-btn', title: v.title, innerHTML: icon(v.icon, 22), onclick: () => this.toggleView(v.id) }, badge);
      this.actBtns.set(v.id, b);
      const sorted = [...this.views.values()].filter((x) => (x.location ?? 'primary') === 'primary').sort((a, c) => (a.order ?? 50) - (c.order ?? 50));
      this.activityTop.replaceChildren(...sorted.map((x) => this.actBtns.get(x.id)!));
    }
    return disposable(() => {
      this.views.delete(v.id);
      this.actBtns.get(v.id)?.remove();
      this.viewHosts.get(v.id)?.remove();
    });
  }

  private hostFor(v: SideView): HTMLElement {
    let host = this.viewHosts.get(v.id);
    if (!host) {
      host = h('div.view-content');
      this.viewHosts.set(v.id, host);
      const api = {
        setActions: (a: HTMLElement[]) => { this.viewActions.set(v.id, a); if (this.activeView === v.id || this.activeSecondary === v.id) this.renderViewActions(v.id); },
        setBadge: (n: number | string | null) => { const b = this.viewBadges.get(v.id); if (b) { b.textContent = n == null ? '' : String(n); b.style.display = n == null || n === 0 ? 'none' : ''; } },
      };
      v.create(host, api);
    }
    return host;
  }

  private renderViewActions(id: string): void {
    const target = (this.views.get(id)?.location ?? 'primary') === 'secondary' ? this.side2Actions : this.sideActions;
    target.replaceChildren(...(this.viewActions.get(id) ?? []));
  }

  showView(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    if ((v.location ?? 'primary') === 'secondary') {
      this.activeSecondary = id;
      this.side2Title.textContent = v.title.toUpperCase();
      this.side2Body.replaceChildren(this.hostFor(v));
      this.renderViewActions(id);
      this.setSidebar2(true);
      v.onShow?.();
      this.viewShown.fire(id);
      return;
    }
    this.activeView = id;
    this.sideTitle.textContent = v.title.toUpperCase();
    this.sideBody.replaceChildren(this.hostFor(v));
    this.renderViewActions(id);
    for (const [k, b] of this.actBtns) b.classList.toggle('active', k === id);
    this.setSidebar(true);
    v.onShow?.();
    this.viewShown.fire(id);
  }

  toggleView(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    if ((v.location ?? 'primary') === 'secondary') {
      if (this.sidebar2Visible && this.activeSecondary === id) this.setSidebar2(false); else this.showView(id);
      return;
    }
    if (this.sidebarVisible && this.activeView === id) this.setSidebar(false); else this.showView(id);
  }

  setSidebar(on: boolean): void {
    this.sidebarVisible = on;
    this.applyLayout();
    if (on && !this.activeView) this.showView('explorer');
  }

  setSidebar2(on: boolean): void {
    this.sidebar2Visible = on;
    this.applyLayout();
    if (on && !this.activeSecondary) this.showView('ai');
  }

  applyLayout(): void {
    const right = this.isRightSide();
    this.workbench.classList.toggle('side-right', right);
    this.sidebar.style.display = this.sidebarVisible && !this.zen ? '' : 'none';
    this.sidebar2.style.display = this.sidebar2Visible && !this.zen ? '' : 'none';
    this.activity.style.display = cfg('workbench.activityBar') && !this.zen ? '' : 'none';
    this.statusbar.style.display = cfg('workbench.statusBar') && !this.zen ? '' : 'none';
    this.titlebar.style.display = this.zen ? 'none' : '';
    this.panel.style.display = this.panelVisible ? '' : 'none';
    // sashes sit next to their panes
    const [s1, s2, s3] = [...this.workbench.querySelectorAll<HTMLElement>(':scope > .sash'), ...this.main.querySelectorAll<HTMLElement>(':scope > .sash')];
    if (s1) s1.style.display = this.sidebarVisible && !this.zen ? '' : 'none';
    if (s2) s2.style.display = this.sidebar2Visible && !this.zen ? '' : 'none';
    if (s3) s3.style.display = this.panelVisible ? '' : 'none';
    this.root.classList.toggle('zen', this.zen);
    this.layoutChanged.fire();
  }

  // ---- panel
  registerPanel(p: PanelView): void {
    this.panels.set(p.id, p);
    const badge = h('span.tab-badge');
    badge.style.display = 'none';
    this.panelBadges.set(p.id, badge);
    const btn = h('button', { class: 'ptab', onclick: () => this.showPanel(p.id) }, p.title, badge);
    this.panelBtns.set(p.id, btn);
    const sorted = [...this.panels.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    this.panelTabs.replaceChildren(...sorted.map((x) => this.panelBtns.get(x.id)!));
  }

  showPanel(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    this.activePanel = id;
    let host = this.panelHosts.get(id);
    if (!host) {
      host = h('div.panel-content');
      this.panelHosts.set(id, host);
      p.create(host, {
        setActions: (a) => { if (this.activePanel === id) this.panelActions.replaceChildren(...a); this.panelActionStore.set(id, a); },
        setBadge: (n) => { const b = this.panelBadges.get(id)!; b.textContent = n == null ? '' : String(n); b.style.display = n == null || n === 0 ? 'none' : ''; },
      });
    }
    this.panelBody.replaceChildren(host);
    this.panelActions.replaceChildren(...(this.panelActionStore.get(id) ?? []));
    for (const [k, b] of this.panelBtns) b.classList.toggle('active', k === id);
    this.setPanel(true);
    p.onShow?.();
    this.panelShown.fire(id);
  }
  private panelActionStore = new Map<string, HTMLElement[]>();

  setPanel(on: boolean): void {
    this.panelVisible = on;
    if (on && !this.activePanel) { this.showPanel('terminal'); return; }
    this.applyLayout();
  }

  togglePanel(): void { this.setPanel(!this.panelVisible); }

  private panelMax = false;
  togglePanelMax(): void {
    this.panelMax = !this.panelMax;
    this.panel.classList.toggle('max', this.panelMax);
    this.editorHost.style.display = this.panelMax ? 'none' : '';
    this.layoutChanged.fire();
  }

  async setZen(on: boolean): Promise<void> {
    this.zen = on;
    this.applyLayout();
    await getCurrentWindow().setFullscreen(on);
  }

  // ---- status bar
  statusItem(opts: { id: string; align?: 'left' | 'right'; priority?: number; text?: string; tooltip?: string; icon?: string; command?: string; onClick?: (e: MouseEvent) => void; color?: string }): { update(p: Partial<{ text: string; tooltip: string; icon: string; color: string; hidden: boolean }>): void; dispose(): void; el: HTMLElement } {
    const el = h('button', { class: 'status-item', 'data-pri': String(opts.priority ?? 50) });
    const render = (o: { text?: string; tooltip?: string; icon?: string; color?: string }) => {
      el.innerHTML = (o.icon ? icon(o.icon, 13) : '') + (o.text ? `<span>${o.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</span>` : '');
      el.title = o.tooltip ?? '';
      el.style.color = o.color ?? '';
    };
    render(opts);
    el.addEventListener('click', (e) => { if (opts.command) void commands.execute(opts.command); opts.onClick?.(e); });
    if (!opts.command && !opts.onClick) el.classList.add('static');
    const side = opts.align === 'right' ? this.statusRight : this.statusLeft;
    side.append(el);
    const sorted = [...side.children].sort((a, b) => Number((b as HTMLElement).dataset.pri) - Number((a as HTMLElement).dataset.pri));
    // left side: higher priority first; right side: higher priority closer to the edge
    side.replaceChildren(...(opts.align === 'right' ? sorted.reverse() : sorted));
    const state = { ...opts };
    return {
      el,
      update: (p) => { Object.assign(state, p); render(state); el.style.display = p.hidden ? 'none' : p.hidden === false ? '' : el.style.display; },
      dispose: () => el.remove(),
    };
  }

  updateTitle(): void {
    const root = app.root ? basename(app.root) : null;
    this.setCenterText(root ? `${root} — Lumen Code` : 'Lumen Code');
    void getCurrentWindow().setTitle(root ? `${root} — Lumen Code` : 'Lumen Code');
  }
}

export const shell = new Shell();

export function bindingText(id: string): string { return bindingFor(id); }
export function onSetting(keys: string[], fn: () => void): void {
  settings.changed.on((k) => { if (k.some((x) => keys.includes(x) || keys.some((p) => p.endsWith('*') && x.startsWith(p.slice(0, -1))))) fn(); });
}
