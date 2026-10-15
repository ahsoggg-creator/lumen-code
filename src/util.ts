export type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: string; dataset?: Record<string, string> };

type TagOf<S extends string> = S extends `${infer T}.${string}` ? T : S extends `${infer T}#${string}` ? T : S;
type ElOf<S extends string> = TagOf<S> extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[TagOf<S>] : HTMLElement;

/** Tiny hyperscript: h('div.cls#id', {onclick}, children...) */
export function h<S extends string>(sel: S, props?: Props | null, ...kids: (Child | Child[])[]): ElOf<S> {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(sel) ?? [];
  const el = document.createElement(m[1] || 'div') as ElOf<S>;
  for (const part of (m[2] ?? '').match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.classList.add(...String(v).split(/\s+/).filter(Boolean));
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

export function append(el: Element, kids: (Child | Child[])[]): void {
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    el.append(typeof k === 'string' ? document.createTextNode(k) : k);
  }
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export function html(s: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = s.trim();
  return t.content.firstElementChild as HTMLElement;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void } {
  let t: number | undefined;
  const d = (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export interface Disposable { dispose(): void }
export function disposable(fn: () => void): Disposable {
  let done = false;
  return { dispose: () => { if (!done) { done = true; fn(); } } };
}

export class Emitter<T> {
  private ls = new Set<(v: T) => void>();
  on(fn: (v: T) => void): Disposable {
    this.ls.add(fn);
    return disposable(() => this.ls.delete(fn));
  }
  fire(v: T): void {
    for (const l of [...this.ls]) {
      try { l(v); } catch (e) { console.error(e); }
    }
  }
}

// ---- paths (Windows-style, tolerant of '/') ----
export const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '');
export const key = (p: string): string => norm(p).toLowerCase();
export const basename = (p: string): string => norm(p).split('\\').pop() ?? p;
export const dirname = (p: string): string => { const n = norm(p); const i = n.lastIndexOf('\\'); return i <= 2 && n[1] === ':' ? n.slice(0, i + 1) : i > 0 ? n.slice(0, i) : n; };
export const join = (...parts: string[]): string => parts.filter(Boolean).join('\\').replace(/[\\/]+/g, '\\');
export const extname = (p: string): string => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
export function relative(root: string | null, p: string): string {
  if (!root) return p;
  const r = key(root) + '\\';
  return key(p).startsWith(r) ? norm(p).slice(r.length) : p;
}
export const isUnder = (root: string, p: string): boolean => key(p).startsWith(key(root) + '\\') || key(p) === key(root);
export function toFileUri(p: string): string {
  return 'file:///' + norm(p).replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/').replace('%3A', ':');
}

export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let ti = 0, score = 0, streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return 0;
    streak = idx === ti ? streak + 1 : 0;
    const boundary = idx === 0 || '\\/_-. '.includes(t[idx - 1]!);
    score += 1 + streak * 2 + (boundary ? 4 : 0) - Math.min(idx - ti, 5) * 0.2;
    ti = idx + 1;
  }
  const base = t.lastIndexOf('\\') + 1;
  if (t.slice(base).includes(q)) score += 20;
  return score / (1 + target.length * 0.01);
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1 << 30) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${(n / (1 << 30)).toFixed(2)} GB`;
}

export function hashStr(s: string): string {
  let hsh = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) hsh = Math.imul(hsh ^ s.charCodeAt(i), 0x01000193);
  return (hsh >>> 0).toString(16);
}

export function stripJsonComments(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; }
    else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonc<T>(s: string, fallback: T): T {
  try { return JSON.parse(stripJsonComments(s)) as T; } catch { return fallback; }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function uid(prefix = 'id'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}
