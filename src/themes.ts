export interface Palette {
  base: string; mantle: string; crust: string; s0: string; s1: string; s2: string; overlay: string; subtext: string; text: string;
  red: string; green: string; yellow: string; blue: string; mauve: string; teal: string; peach: string; pink: string;
}
export interface Theme { id: string; name: string; dark: boolean; c: Palette }

const t = (id: string, name: string, dark: boolean, c: Palette): Theme => ({ id, name, dark, c });

export const THEMES: Theme[] = [
  t('catppuccin-mocha', 'Catppuccin Mocha', true, { base: '#1e1e2e', mantle: '#181825', crust: '#11111b', s0: '#313244', s1: '#45475a', s2: '#585b70', overlay: '#6c7086', subtext: '#a6adc8', text: '#cdd6f4', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', mauve: '#cba6f7', teal: '#94e2d5', peach: '#fab387', pink: '#f5c2e7' }),
  t('catppuccin-latte', 'Catppuccin Latte', false, { base: '#eff1f5', mantle: '#e6e9ef', crust: '#dce0e8', s0: '#ccd0da', s1: '#bcc0cc', s2: '#acb0be', overlay: '#9ca0b0', subtext: '#6c6f85', text: '#4c4f69', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', mauve: '#8839ef', teal: '#179299', peach: '#fe640b', pink: '#ea76cb' }),
  t('tokyo-night', 'Tokyo Night', true, { base: '#1a1b26', mantle: '#16161e', crust: '#13131a', s0: '#24283b', s1: '#2f334d', s2: '#3b4261', overlay: '#565f89', subtext: '#787c99', text: '#c0caf5', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', mauve: '#bb9af7', teal: '#73daca', peach: '#ff9e64', pink: '#ff9ec4' }),
  t('dracula', 'Dracula', true, { base: '#282a36', mantle: '#21222c', crust: '#191a21', s0: '#343746', s1: '#44475a', s2: '#565a6e', overlay: '#6272a4', subtext: '#a9b0cf', text: '#f8f8f2', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#8be9fd', mauve: '#bd93f9', teal: '#8be9fd', peach: '#ffb86c', pink: '#ff79c6' }),
  t('one-dark', 'One Dark', true, { base: '#282c34', mantle: '#21252b', crust: '#181a1f', s0: '#2c313c', s1: '#3e4451', s2: '#4b5263', overlay: '#5c6370', subtext: '#9da5b4', text: '#abb2bf', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', mauve: '#c678dd', teal: '#56b6c2', peach: '#d19a66', pink: '#e59fb1' }),
  t('nord', 'Nord', true, { base: '#2e3440', mantle: '#292e39', crust: '#242933', s0: '#3b4252', s1: '#434c5e', s2: '#4c566a', overlay: '#616e88', subtext: '#a3adc2', text: '#d8dee9', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', mauve: '#b48ead', teal: '#8fbcbb', peach: '#d08770', pink: '#c9a0c6' }),
  t('gruvbox-dark', 'Gruvbox Dark', true, { base: '#282828', mantle: '#1d2021', crust: '#171819', s0: '#3c3836', s1: '#504945', s2: '#665c54', overlay: '#7c6f64', subtext: '#bdae93', text: '#ebdbb2', red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f', blue: '#83a598', mauve: '#d3869b', teal: '#8ec07c', peach: '#fe8019', pink: '#d3869b' }),
  t('rose-pine', 'Rosé Pine', true, { base: '#191724', mantle: '#16141f', crust: '#12101a', s0: '#1f1d2e', s1: '#26233a', s2: '#403d52', overlay: '#6e6a86', subtext: '#908caa', text: '#e0def4', red: '#eb6f92', green: '#a6d189', yellow: '#f6c177', blue: '#9ccfd8', mauve: '#c4a7e7', teal: '#9ccfd8', peach: '#ebbcba', pink: '#ebbcba' }),
  t('solarized-dark', 'Solarized Dark', true, { base: '#002b36', mantle: '#00252f', crust: '#001f27', s0: '#073642', s1: '#0d4654', s2: '#586e75', overlay: '#657b83', subtext: '#93a1a1', text: '#a8b5b6', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', mauve: '#6c71c4', teal: '#2aa198', peach: '#cb4b16', pink: '#d33682' }),
  t('github-light', 'GitHub Light', false, { base: '#ffffff', mantle: '#f6f8fa', crust: '#eaeef2', s0: '#eaeef2', s1: '#d0d7de', s2: '#afb8c1', overlay: '#8c959f', subtext: '#57606a', text: '#24292f', red: '#cf222e', green: '#116329', yellow: '#9a6700', blue: '#0969da', mauve: '#8250df', teal: '#1b7c83', peach: '#bc4c00', pink: '#bf3989' }),
];

const extraThemes: Theme[] = [];
export const allThemes = (): Theme[] => [...THEMES, ...extraThemes];
export const findTheme = (id: string): Theme => allThemes().find((x) => x.id === id) ?? THEMES[0]!;
export function addTheme(th: Theme): void {
  const i = extraThemes.findIndex((x) => x.id === th.id);
  if (i >= 0) extraThemes[i] = th; else extraThemes.push(th);
}

const hex = (c: string): string => c.replace('#', '');
const alpha = (c: string, a: number): string => `#${hex(c)}${Math.round(a * 255).toString(16).padStart(2, '0')}`;

export function accentOf(th: Theme, accent: string): string {
  if (accent.startsWith('#')) return accent;
  return (th.c as unknown as Record<string, string>)[accent] ?? th.c.mauve;
}

export function cssVars(th: Theme, accent: string): Record<string, string> {
  const c = th.c;
  const ac = accentOf(th, accent);
  return {
    '--bg': c.base, '--bg-side': c.mantle, '--bg-deep': c.crust, '--bg-hover': alpha(c.s1, 0.45), '--bg-active': alpha(c.s1, 0.8),
    '--bg-input': c.s0, '--bg-raised': c.s0, '--border': alpha(c.s1, 0.9), '--border-soft': alpha(c.s1, 0.45),
    '--fg': c.text, '--fg-dim': c.subtext, '--fg-mute': c.overlay,
    '--accent': ac, '--accent-soft': alpha(ac, 0.18), '--accent-fg': c.crust, '--selection': alpha(ac, 0.3),
    '--red': c.red, '--green': c.green, '--yellow': c.yellow, '--blue': c.blue, '--mauve': c.mauve, '--teal': c.teal, '--peach': c.peach, '--pink': c.pink,
    '--shadow': th.dark ? 'rgba(0,0,0,.45)' : 'rgba(40,50,80,.22)',
    '--scroll': alpha(c.s2, 0.55), '--scroll-hover': alpha(c.overlay, 0.7),
  };
}

export function monacoTheme(th: Theme, accent: string, overrides: Record<string, string> = {}): { base: 'vs' | 'vs-dark'; inherit: boolean; rules: { token: string; foreground?: string; fontStyle?: string }[]; colors: Record<string, string> } {
  const c = th.c;
  const ac = accentOf(th, accent);
  const r = (token: string, color: string, fontStyle?: string) => ({ token, foreground: hex(color), ...(fontStyle ? { fontStyle } : {}) });
  return {
    base: th.dark ? 'vs-dark' : 'vs',
    inherit: false,
    rules: [
      r('', c.text), r('comment', c.overlay, 'italic'), r('keyword', c.mauve), r('keyword.control', c.mauve), r('string', c.green), r('string.escape', c.pink),
      r('number', c.peach), r('regexp', c.pink), r('type', c.yellow), r('type.identifier', c.yellow), r('identifier', c.text), r('variable', c.text),
      r('variable.predefined', c.red), r('constant', c.peach), r('predefined', c.blue), r('function', c.blue), r('operator', c.teal), r('delimiter', c.subtext),
      r('delimiter.bracket', c.subtext), r('tag', c.red), r('metatag', c.mauve), r('attribute.name', c.yellow), r('attribute.value', c.green), r('annotation', c.yellow),
      r('namespace', c.yellow), r('key', c.blue), r('string.key.json', c.blue), r('string.value.json', c.green), r('keyword.json', c.peach),
      r('tag.id.pug', c.yellow), r('entity', c.blue),
    ],
    colors: {
      'editor.background': c.base, 'editor.foreground': c.text, 'editorLineNumber.foreground': c.s2, 'editorLineNumber.activeForeground': ac,
      'editor.selectionBackground': alpha(ac, 0.28), 'editor.inactiveSelectionBackground': alpha(ac, 0.14), 'editor.selectionHighlightBackground': alpha(ac, 0.16),
      'editor.wordHighlightBackground': alpha(c.s2, 0.35), 'editor.findMatchBackground': alpha(c.peach, 0.4), 'editor.findMatchHighlightBackground': alpha(c.blue, 0.25),
      'editor.lineHighlightBackground': alpha(c.s0, 0.55), 'editor.lineHighlightBorder': '#00000000', 'editorCursor.foreground': ac,
      'editorIndentGuide.background1': alpha(c.s1, 0.7), 'editorIndentGuide.activeBackground1': c.s2, 'editorWhitespace.foreground': alpha(c.s2, 0.6),
      'editorBracketMatch.background': alpha(ac, 0.2), 'editorBracketMatch.border': alpha(ac, 0.6),
      'editorBracketHighlight.foreground1': c.red, 'editorBracketHighlight.foreground2': c.peach, 'editorBracketHighlight.foreground3': c.yellow,
      'editorBracketHighlight.foreground4': c.green, 'editorBracketHighlight.foreground5': c.blue, 'editorBracketHighlight.foreground6': c.mauve,
      'editorRuler.foreground': alpha(c.s1, 0.8), 'editorGutter.background': c.base, 'editorOverviewRuler.border': '#00000000',
      'editorWidget.background': c.mantle, 'editorWidget.border': c.s1, 'editorSuggestWidget.background': c.mantle, 'editorSuggestWidget.border': c.s1,
      'editorSuggestWidget.selectedBackground': c.s0, 'editorSuggestWidget.highlightForeground': ac, 'editorHoverWidget.background': c.mantle, 'editorHoverWidget.border': c.s1,
      'input.background': c.s0, 'input.border': c.s1, 'inputOption.activeBorder': ac, 'focusBorder': alpha(ac, 0.7), 'list.hoverBackground': c.s0,
      'list.activeSelectionBackground': c.s1, 'list.focusBackground': c.s1, 'peekViewEditor.background': c.mantle, 'peekViewResult.background': c.crust,
      'peekViewTitle.background': c.crust, 'minimap.background': c.base, 'minimapSlider.background': alpha(c.s2, 0.25), 'minimapSlider.hoverBackground': alpha(c.s2, 0.4),
      'scrollbarSlider.background': alpha(c.s2, 0.4), 'scrollbarSlider.hoverBackground': alpha(c.overlay, 0.55), 'scrollbarSlider.activeBackground': alpha(c.overlay, 0.75),
      'stickyScroll.background': c.mantle, 'stickyScrollHover.background': c.s0, 'editorStickyScroll.background': c.mantle,
      'diffEditor.insertedTextBackground': alpha(c.green, 0.16), 'diffEditor.removedTextBackground': alpha(c.red, 0.16),
      'diffEditor.insertedLineBackground': alpha(c.green, 0.1), 'diffEditor.removedLineBackground': alpha(c.red, 0.1),
      'editorError.foreground': c.red, 'editorWarning.foreground': c.yellow, 'editorInfo.foreground': c.blue,
      'editorLink.activeForeground': ac, 'menu.background': c.mantle, 'menu.selectionBackground': c.s1,
      ...overrides,
    },
  };
}

export function xtermTheme(th: Theme, accent: string): Record<string, string> {
  const c = th.c;
  return {
    background: c.mantle, foreground: c.text, cursor: accentOf(th, accent), cursorAccent: c.mantle, selectionBackground: alpha(accentOf(th, accent), 0.3),
    black: c.s1, red: c.red, green: c.green, yellow: c.yellow, blue: c.blue, magenta: c.mauve, cyan: c.teal, white: c.subtext,
    brightBlack: c.s2, brightRed: c.red, brightGreen: c.green, brightYellow: c.yellow, brightBlue: c.blue, brightMagenta: c.pink, brightCyan: c.teal, brightWhite: c.text,
  };
}

export const ACCENTS = ['mauve', 'blue', 'teal', 'green', 'yellow', 'peach', 'red', 'pink'] as const;
