import type { Palette, Theme } from '../themes';
import { parseJsonc } from '../util';

export interface TokenRule { token: string; foreground?: string; background?: string; fontStyle?: string }

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function solid(c: string | undefined): string | undefined {
  if (!c || !HEX.test(c)) return undefined;
  let h = c.slice(1);
  if (h.length <= 4) h = [...h].map((x) => x + x).join('');
  return `#${h.slice(0, 6).toLowerCase()}`;
}

function rgb(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return `#${[0, 1, 2].map((i) => Math.round(x[i]! * (1 - t) + y[i]! * t).toString(16).padStart(2, '0')).join('')}`;
}

export interface RawTheme {
  name?: string;
  type?: string;
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: { scope?: string | string[]; settings?: { foreground?: string; background?: string; fontStyle?: string } }[];
}

export function parseTheme(text: string): RawTheme { return parseJsonc<RawTheme>(text, {}); }

/** `include` chains: the parent is applied first, the child overrides. */
export function mergeThemes(parent: RawTheme, child: RawTheme): RawTheme {
  return { ...parent, ...child, colors: { ...(parent.colors ?? {}), ...(child.colors ?? {}) }, tokenColors: [...(parent.tokenColors ?? []), ...(child.tokenColors ?? [])] };
}

export function toTokenRules(raw: RawTheme): TokenRule[] {
  const out: TokenRule[] = [];
  for (const tc of raw.tokenColors ?? []) {
    const s = tc.settings ?? {};
    const scopes = tc.scope == null ? [''] : (Array.isArray(tc.scope) ? tc.scope : tc.scope.split(',')).map((x) => x.trim());
    for (const scope of scopes) {
      if (scope.includes(' ')) continue; // descendant selectors are not supported by Monaco's matcher
      const rule: TokenRule = { token: scope };
      const fg = solid(s.foreground);
      if (fg) rule.foreground = fg.slice(1);
      const bg = solid(s.background);
      if (bg) rule.background = bg.slice(1);
      if (s.fontStyle != null) rule.fontStyle = s.fontStyle.trim();
      if (rule.foreground || rule.background || rule.fontStyle != null) out.push(rule);
    }
  }
  return out;
}

function tokenColor(rules: TokenRule[], names: string[]): string | undefined {
  for (const n of names) {
    const r = [...rules].reverse().find((x) => x.token === n || x.token.startsWith(`${n}.`));
    if (r?.foreground) return `#${r.foreground}`;
  }
  return undefined;
}

/** Builds Lumen's palette-based UI theme from a VS Code colour theme (the editor part keeps the original rules). */
export function toLumenTheme(id: string, label: string, uiTheme: string | undefined, raw: RawTheme): Theme {
  const dark = (uiTheme ?? (raw.type === 'light' ? 'vs' : 'vs-dark')) !== 'vs' && raw.type !== 'light';
  const col = raw.colors ?? {};
  const get = (...keys: string[]): string | undefined => { for (const k of keys) { const v = solid(col[k]); if (v) return v; } return undefined; };
  const base = get('editor.background') ?? (dark ? '#1e1e1e' : '#ffffff');
  const text = get('editor.foreground', 'foreground') ?? (dark ? '#d4d4d4' : '#333333');
  const mantle = get('sideBar.background', 'editorGroupHeader.tabsBackground', 'tab.inactiveBackground') ?? mix(base, dark ? '#000000' : '#000000', dark ? 0.15 : 0.04);
  const crust = get('activityBar.background', 'titleBar.activeBackground', 'statusBar.background') ?? mix(mantle, '#000000', dark ? 0.2 : 0.05);
  const s0 = get('input.background', 'list.hoverBackground', 'editor.lineHighlightBackground') ?? mix(base, text, 0.08);
  const s1 = get('list.activeSelectionBackground', 'editorGroup.border', 'panel.border') ?? mix(base, text, 0.16);
  const s2 = get('scrollbarSlider.background', 'editorIndentGuide.background1', 'editorWhitespace.foreground') ?? mix(base, text, 0.28);
  const overlay = get('editorLineNumber.foreground', 'disabledForeground') ?? mix(base, text, 0.5);
  const subtext = get('descriptionForeground', 'sideBar.foreground', 'tab.inactiveForeground') ?? mix(base, text, 0.72);
  const rules = toTokenRules(raw);
  const fb = dark
    ? { red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', mauve: '#cba6f7', teal: '#94e2d5', peach: '#fab387', pink: '#f5c2e7' }
    : { red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', mauve: '#8839ef', teal: '#179299', peach: '#fe640b', pink: '#ea76cb' };
  const c: Palette = {
    base, mantle, crust, s0, s1, s2, overlay, subtext, text,
    red: get('terminal.ansiRed', 'errorForeground') ?? tokenColor(rules, ['invalid', 'markup.deleted']) ?? fb.red,
    green: get('terminal.ansiGreen') ?? tokenColor(rules, ['string']) ?? fb.green,
    yellow: get('terminal.ansiYellow') ?? tokenColor(rules, ['entity.name.class', 'support.type', 'entity.name.type']) ?? fb.yellow,
    blue: get('terminal.ansiBlue') ?? tokenColor(rules, ['entity.name.function', 'support.function']) ?? fb.blue,
    mauve: get('terminal.ansiMagenta') ?? tokenColor(rules, ['keyword', 'storage']) ?? fb.mauve,
    teal: get('terminal.ansiCyan') ?? tokenColor(rules, ['keyword.operator', 'support.constant']) ?? fb.teal,
    peach: tokenColor(rules, ['constant.numeric', 'constant']) ?? get('terminal.ansiBrightYellow') ?? fb.peach,
    pink: get('terminal.ansiBrightMagenta') ?? tokenColor(rules, ['string.regexp', 'constant.character.escape']) ?? fb.pink,
  };
  const colors: Record<string, string> = {};
  for (const [k, v] of Object.entries(col)) if (HEX.test(v)) colors[k] = v;
  return { id, name: label, dark, c, editor: { rules, colors } };
}
