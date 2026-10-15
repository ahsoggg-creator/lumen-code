import { settings } from './settings';
import { Emitter, disposable, type Disposable } from './util';

export interface Command {
  id: string;
  title: string;
  category?: string;
  keybinding?: string;
  when?: () => boolean;
  hidden?: boolean;
  /** Stays active while a terminal has focus (otherwise the shell gets the keys). */
  inTerminal?: boolean;
  run: (...args: never[]) => unknown;
}

const registry = new Map<string, Command>();
export const commandsChanged = new Emitter<void>();

export const commands = {
  register(cmd: Command): Disposable {
    registry.set(cmd.id, cmd);
    commandsChanged.fire();
    return disposable(() => { if (registry.get(cmd.id) === cmd) { registry.delete(cmd.id); commandsChanged.fire(); } });
  },
  get: (id: string): Command | undefined => registry.get(id),
  all: (): Command[] => [...registry.values()],
  async execute(id: string, ...args: unknown[]): Promise<unknown> {
    const c = registry.get(id);
    if (!c) throw new Error(`Unknown command: ${id}`);
    return (c.run as (...a: unknown[]) => unknown)(...args);
  },
};

const CODE_KEYS: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Space: 'space', Escape: 'escape', Enter: 'enter', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  NumpadAdd: 'numpad_add', NumpadSubtract: 'numpad_subtract',
};

/** Layout-independent chord string: works the same on Russian and English layouts. */
export function chordOf(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null;
  let k: string;
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) k = e.code.toLowerCase();
  else k = CODE_KEYS[e.code] ?? e.key.toLowerCase();
  const mods = [e.ctrlKey && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean);
  return [...mods, k].join('+');
}

export function normalizeChord(s: string): string {
  const parts = s.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  const has = (...n: string[]) => n.some((x) => parts.includes(x));
  const mods = [has('ctrl', 'control') && 'ctrl', has('shift') && 'shift', has('alt', 'option') && 'alt', has('meta', 'cmd', 'win') && 'meta'].filter(Boolean);
  const key = parts.filter((p) => !['ctrl', 'control', 'shift', 'alt', 'option', 'meta', 'cmd', 'win'].includes(p)).pop() ?? '';
  return [...mods, key].join('+');
}

export const normalizeBinding = (s: string): string => s.split(/\s+/).filter(Boolean).map(normalizeChord).join(' ');

/** Effective keymap: command defaults overlaid with `keybindings` from settings (chord → command, "" unbinds). */
export function keymap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of registry.values()) if (c.keybinding) map.set(normalizeBinding(c.keybinding), c.id);
  const user = settings.get<Record<string, string>>('keybindings') ?? {};
  for (const [chord, id] of Object.entries(user)) {
    const n = normalizeBinding(chord);
    if (id) map.set(n, id); else map.delete(n);
  }
  return map;
}

export function bindingFor(id: string): string {
  const user = settings.get<Record<string, string>>('keybindings') ?? {};
  for (const [chord, cid] of Object.entries(user)) if (cid === id) return normalizeBinding(chord);
  for (const [chord, cid] of keymap()) if (cid === id) return chord;
  return '';
}

export function prettyBinding(b: string): string {
  return b.split(' ').map((c) => c.split('+').map((p) => ({ ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Win', escape: 'Esc', up: '↑', down: '↓', left: '←', right: '→', space: 'Space' } as Record<string, string>)[p] ?? (p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1))).join('+')).join(', ');
}

export let recording = false;
export const setRecording = (b: boolean): void => { recording = b; };

let pending: string | null = null;
let pendingTimer: number | undefined;

export function installKeyHandler(isTerminalFocused: () => boolean, onPending: (s: string | null) => void): void {
  window.addEventListener('keydown', (e) => {
    if (recording) return;
    const chord = chordOf(e);
    if (!chord) return;
    const map = keymap();
    const full = pending ? `${pending} ${chord}` : chord;
    let id = map.get(full);
    if (!id && pending) { pending = null; onPending(null); id = map.get(chord); }
    if (!id) {
      const isPrefix = [...map.keys()].some((k) => k.startsWith(full + ' '));
      if (isPrefix) {
        pending = full;
        onPending(full);
        clearTimeout(pendingTimer);
        pendingTimer = window.setTimeout(() => { pending = null; onPending(null); }, 2000);
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    pending = null;
    onPending(null);
    const cmd = registry.get(id);
    if (!cmd || (cmd.when && !cmd.when())) return;
    if (isTerminalFocused() && !cmd.inTerminal) return;
    e.preventDefault();
    e.stopPropagation();
    void Promise.resolve(cmd.run()).catch((err) => console.error(id, err));
  }, true);
}
