import { bindingFor, commands, prettyBinding } from './commands';
import { icon } from './icons';
import { append, fuzzyScore, h, type Child } from './util';

// ---------------------------------------------------------------- notifications
export interface Notice { id: number; kind: 'info' | 'warn' | 'error'; message: string; time: number }
export const noticeHistory: Notice[] = [];
let noticeSeq = 0;
const noticeListeners = new Set<() => void>();
export const onNotices = (fn: () => void): void => { noticeListeners.add(fn); };

export interface NotifyAction { label: string; run: () => void }
export interface NotifyOpts { kind?: 'info' | 'warn' | 'error'; actions?: NotifyAction[]; timeout?: number; progress?: boolean }

export function notify(message: string, opts: NotifyOpts = {}): { close(): void; update(msg: string, pct?: number): void } {
  const kind = opts.kind ?? 'info';
  let host = document.getElementById('toasts');
  if (!host) host = document.body.appendChild(h('div#toasts'));
  const msg = h('div.toast-msg', null, message);
  const bar = h('div.toast-bar', null, h('i'));
  const toast = h('div', { class: `toast ${kind}` },
    h('span.toast-ic', { innerHTML: icon(kind === 'error' ? 'xCircle' : kind === 'warn' ? 'alert' : 'info', 16) }),
    h('div.toast-body', null, msg,
      opts.progress ? bar : null,
      opts.actions?.length ? h('div.toast-actions', null, opts.actions.map((a) => h('button.btn', { onclick: () => { a.run(); close(); } }, a.label))) : null),
    h('button.icon-btn', { title: 'Закрыть', innerHTML: icon('x', 14), onclick: () => close() }));
  host.append(toast);
  requestAnimationFrame(() => toast.classList.add('in'));
  noticeHistory.push({ id: ++noticeSeq, kind, message, time: Date.now() });
  if (noticeHistory.length > 100) noticeHistory.shift();
  noticeListeners.forEach((f) => f());
  let timer: number | undefined;
  const timeout = opts.timeout ?? (opts.actions?.length || opts.progress ? 0 : kind === 'error' ? 9000 : 4500);
  if (timeout) timer = window.setTimeout(() => close(), timeout);
  function close(): void {
    clearTimeout(timer);
    toast.classList.remove('in');
    setTimeout(() => toast.remove(), 180);
  }
  return {
    close,
    update(m: string, pct?: number) {
      msg.textContent = m;
      if (pct != null) (bar.firstElementChild as HTMLElement).style.width = `${Math.round(pct * 100)}%`;
    },
  };
}

// ---------------------------------------------------------------- modal dialog
export interface DialogButton { label: string; primary?: boolean; danger?: boolean }

export function dialog(title: string, message: string | Node, buttons: DialogButton[]): Promise<number> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const finish = (i: number) => { overlay.remove(); prevFocus?.focus?.(); resolve(i); };
    const btns = buttons.map((b, i) => h('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, onclick: () => finish(i) }, b.label));
    const overlay = h('div.modal-overlay', { onmousedown: (e: MouseEvent) => { if (e.target === overlay) finish(-1); } },
      h('div.modal', { role: 'dialog' }, h('div.modal-title', null, title), h('div.modal-body', null, message), h('div.modal-actions', null, btns)));
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(-1); });
    document.body.append(overlay);
    (btns.find((_, i) => buttons[i]!.primary) ?? btns[0])?.focus();
  });
}

export async function confirmDialog(title: string, message: string, ok = 'OK', danger = false): Promise<boolean> {
  return (await dialog(title, message, [{ label: 'Отмена' }, { label: ok, primary: !danger, danger }])) === 1;
}

// ---------------------------------------------------------------- quick input (palette / pick / input box)
export interface PickItem<T = unknown> {
  label: string;
  description?: string;
  detail?: string;
  icon?: string;
  value: T;
  keybinding?: string;
  header?: boolean;
  picked?: boolean;
}

export interface QuickOpts<T> {
  placeholder?: string;
  title?: string;
  value?: string;
  /** Called on every query change; return a replacement item list (for modes like '>' commands). */
  provider?: (query: string) => PickItem<T>[] | Promise<PickItem<T>[]> | null;
  filter?: boolean;
  onPreview?: (item: PickItem<T> | null) => void;
  canPickMany?: boolean;
}

let closeActive: (() => void) | null = null;

export function quickPick<T>(initial: PickItem<T>[], opts: QuickOpts<T> = {}): Promise<PickItem<T> | undefined> {
  return new Promise((resolve) => {
    closeActive?.();
    const prevFocus = document.activeElement as HTMLElement | null;
    let items = initial;
    let shown: PickItem<T>[] = [];
    let sel = 0;
    let seq = 0;
    const input = h('input.qi-input', { placeholder: opts.placeholder ?? '', spellcheck: false, value: opts.value ?? '' });
    const list = h('div.qi-list');
    const box = h('div.qi', null, opts.title ? h('div.qi-title', null, opts.title) : null, input, list);
    const overlay = h('div.qi-overlay', { onmousedown: (e: MouseEvent) => { if (e.target === overlay) done(undefined); } }, box);
    let finished = false;

    function done(v: PickItem<T> | undefined): void {
      if (finished) return;
      finished = true;
      closeActive = null;
      opts.onPreview?.(null);
      overlay.remove();
      prevFocus?.focus?.();
      resolve(v);
    }
    closeActive = () => done(undefined);

    function render(): void {
      const q = input.value;
      const useFilter = opts.filter !== false;
      let rows = items;
      if (useFilter && q) {
        rows = items
          .filter((i) => !i.header)
          .map((i) => ({ i, s: fuzzyScore(q, `${i.label} ${i.description ?? ''}`) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.i);
      }
      shown = rows.slice(0, 200);
      sel = Math.min(sel, Math.max(0, shown.findIndex((i) => !i.header) < 0 ? 0 : shown.length - 1));
      if (shown[sel]?.header) sel = shown.findIndex((i) => !i.header);
      list.replaceChildren(...shown.map((it, idx) => {
        if (it.header) return h('div.qi-header', null, it.label);
        const kb = it.keybinding ? h('span.kbd', null, prettyBinding(it.keybinding)) : null;
        return h('div', { class: `qi-item ${idx === sel ? 'sel' : ''}`, onmousemove: () => { if (sel !== idx) { sel = idx; mark(); } }, onclick: () => done(it) },
          it.icon ? h('span.qi-ic', { innerHTML: icon(it.icon, 15) }) : null,
          h('span.qi-label', null, it.label),
          it.description ? h('span.qi-desc', null, it.description) : null,
          it.detail ? h('span.qi-detail', null, it.detail) : null,
          kb);
      }));
      if (!shown.length) list.append(h('div.qi-empty', null, 'Ничего не найдено'));
      mark();
    }

    function mark(): void {
      [...list.children].forEach((c, i) => c.classList.toggle('sel', i === sel && c.classList.contains('qi-item')));
      list.children[sel]?.scrollIntoView({ block: 'nearest' });
      opts.onPreview?.(shown[sel] && !shown[sel]!.header ? shown[sel]! : null);
    }

    async function refresh(): Promise<void> {
      const mine = ++seq;
      if (opts.provider) {
        const r = await opts.provider(input.value);
        if (mine !== seq) return;
        if (r) items = r;
      }
      render();
    }

    input.addEventListener('input', () => { sel = 0; void refresh(); });
    input.addEventListener('keydown', (e) => {
      const step = (d: number) => {
        let n = sel;
        for (let k = 0; k < shown.length; k++) { n = (n + d + shown.length) % shown.length; if (!shown[n]?.header) break; }
        sel = n;
        mark();
      };
      if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'PageDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 8); mark(); }
      else if (e.key === 'PageUp') { e.preventDefault(); sel = Math.max(0, sel - 8); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); const it = shown[sel]; if (it && !it.header) done(it); }
      else if (e.key === 'Escape') { e.preventDefault(); done(undefined); }
      e.stopPropagation();
    });
    document.body.append(overlay);
    input.focus();
    input.select();
    void refresh();
  });
}

export async function inputBox(opts: { title?: string; value?: string; placeholder?: string; validate?: (v: string) => string | null; password?: boolean }): Promise<string | undefined> {
  return new Promise((resolve) => {
    closeActive?.();
    const prevFocus = document.activeElement as HTMLElement | null;
    const input = h('input.qi-input', { placeholder: opts.placeholder ?? '', value: opts.value ?? '', spellcheck: false, type: opts.password ? 'password' : 'text' });
    const msg = h('div.qi-msg');
    const box = h('div.qi', null, opts.title ? h('div.qi-title', null, opts.title) : null, input, msg);
    const overlay = h('div.qi-overlay', { onmousedown: (e: MouseEvent) => { if (e.target === overlay) done(undefined); } }, box);
    let finished = false;
    function done(v: string | undefined): void {
      if (finished) return;
      finished = true;
      closeActive = null;
      overlay.remove();
      prevFocus?.focus?.();
      resolve(v);
    }
    closeActive = () => done(undefined);
    input.addEventListener('input', () => { msg.textContent = opts.validate?.(input.value) ?? ''; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const err = opts.validate?.(input.value);
        if (err) msg.textContent = err; else done(input.value);
      } else if (e.key === 'Escape') { e.preventDefault(); done(undefined); }
      e.stopPropagation();
    });
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

// ---------------------------------------------------------------- context menu
export interface MenuItem {
  label?: string;
  run?: () => void;
  keybinding?: string;
  command?: string;
  icon?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
}

let openMenu: HTMLElement | null = null;
export function closeMenus(): void { openMenu?.remove(); openMenu = null; }

function buildMenu(items: MenuItem[], onClose: () => void): HTMLElement {
  const el = h('div.menu', { onmousedown: (e: MouseEvent) => e.stopPropagation() });
  for (const it of items) {
    if (it.separator) { el.append(h('div.menu-sep')); continue; }
    const kb = it.keybinding ?? (it.command ? bindingFor(it.command) : '');
    const row = h('div', { class: `menu-item ${it.disabled ? 'disabled' : ''}` },
      h('span.menu-check', { innerHTML: it.checked ? icon('check', 14) : it.icon ? icon(it.icon, 14) : '' }),
      h('span.menu-label', null, it.label ?? ''),
      kb ? h('span.kbd', null, prettyBinding(kb)) : null,
      it.submenu ? h('span.menu-arrow', { innerHTML: icon('chevronRight', 12) }) : null);
    if (it.submenu) {
      let sub: HTMLElement | null = null;
      row.addEventListener('mouseenter', () => {
        sub?.remove();
        sub = buildMenu(it.submenu!, onClose);
        sub.classList.add('submenu');
        document.body.append(sub);
        const r = row.getBoundingClientRect();
        placeMenu(sub, r.right - 4, r.top - 4);
      });
      row.addEventListener('mouseleave', (e) => { if (!(e.relatedTarget instanceof Node && sub?.contains(e.relatedTarget))) setTimeout(() => { if (sub && !sub.matches(':hover') && !row.matches(':hover')) { sub.remove(); sub = null; } }, 120); });
    } else if (!it.disabled) {
      row.addEventListener('click', () => {
        onClose();
        if (it.command) void commands.execute(it.command);
        else it.run?.();
      });
    }
    el.append(row);
  }
  return el;
}

function placeMenu(el: HTMLElement, x: number, y: number): void {
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 6))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 6))}px`;
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenus();
  const el = buildMenu(items, () => { closeMenus(); document.querySelectorAll('.submenu').forEach((s) => s.remove()); });
  document.body.append(el);
  placeMenu(el, x, y);
  openMenu = el;
  const off = (e: Event) => {
    const t = e.target;
    if (t instanceof Node && (el.contains(t) || (t as HTMLElement).closest?.('.submenu'))) return;
    closeMenus();
    document.querySelectorAll('.submenu').forEach((s) => s.remove());
    window.removeEventListener('mousedown', off, true);
    window.removeEventListener('blur', off);
  };
  setTimeout(() => { window.addEventListener('mousedown', off, true); window.addEventListener('blur', off); }, 0);
}

// ---------------------------------------------------------------- misc widgets
export function toggleBtn(label: string, title: string, on: boolean, onChange: (v: boolean) => void, ic?: string): HTMLElement {
  const b = h('button', { class: `tgl ${on ? 'on' : ''}`, title, onclick: () => { on = !on; b.classList.toggle('on', on); onChange(on); } });
  if (ic) b.innerHTML = icon(ic, 14); else b.textContent = label;
  return b;
}

export function section(title: string, body: Child[], opts: { open?: boolean; actions?: Child[] } = {}): HTMLElement {
  let open = opts.open ?? true;
  const content = h('div.sec-body');
  append(content, body);
  const chev = h('span.sec-chev', { innerHTML: icon('chevronDown', 12) });
  const head = h('div.sec-head', { onclick: () => { open = !open; sync(); } }, chev, h('span.sec-title', null, title), h('span.sec-actions', { onclick: (e: Event) => e.stopPropagation() }, opts.actions ?? []));
  const el = h('div.sec', null, head, content);
  function sync(): void {
    content.style.display = open ? '' : 'none';
    chev.style.transform = open ? '' : 'rotate(-90deg)';
  }
  sync();
  return el;
}

export function iconBtn(ic: string, title: string, onclick: (e: MouseEvent) => void, size = 15): HTMLButtonElement {
  return h('button.icon-btn', { title, innerHTML: icon(ic, size), onclick });
}
