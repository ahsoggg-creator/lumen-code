/** Language servers Lumen Code knows how to find, install and start. JS/TS/JSON/CSS/HTML are served by Monaco itself. */

export interface ServerDef {
  id: string;
  name: string;
  /** Monaco language ids this server handles. */
  languages: string[];
  /** Executable names tried in order; a full path or a name on PATH. */
  commands: string[];
  args: string[];
  /** Answers to `workspace/configuration`, as a nested object (`{ python: { analysis: {...} } }`). */
  settings?: Record<string, unknown>;
  /** Steps run one after another to install the server. `${python}` is the selected interpreter. */
  install?: { label: string; needs: string; steps: { program: string; args: string[] }[] };
  /** Folders, relative to the Python interpreter, to look for `commands` in (pip puts scripts there). */
  pythonScripts?: boolean;
  /** Folders under the user's home to look in when the command is not on PATH (`go install` puts binaries in go\bin). */
  homeDirs?: string[];
  /** Page to open when there is no automatic installation. */
  url?: string;
}

const WINGET = ['--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];

export const BUILTIN_SERVERS: ServerDef[] = [
  {
    id: 'python', name: 'basedpyright (Python)', languages: ['python'], commands: ['basedpyright-langserver', 'pyright-langserver'], args: ['--stdio'], pythonScripts: true,
    settings: { python: { analysis: { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly' } } },
    install: { label: 'basedpyright', needs: 'python', steps: [{ program: '${python}', args: ['-m', 'pip', 'install', '--upgrade', 'basedpyright'] }] },
  },
  {
    id: 'rust', name: 'rust-analyzer (Rust)', languages: ['rust'], commands: ['rust-analyzer'], args: [], homeDirs: ['.cargo\\bin'],
    install: { label: 'rust-analyzer', needs: 'rustup', steps: [{ program: 'rustup', args: ['component', 'add', 'rust-analyzer'] }] },
  },
  {
    id: 'go', name: 'gopls (Go)', languages: ['go'], commands: ['gopls'], args: [], homeDirs: ['go\\bin'],
    install: { label: 'gopls', needs: 'go', steps: [{ program: 'go', args: ['install', 'golang.org/x/tools/gopls@latest'] }] },
  },
  {
    id: 'clangd', name: 'clangd (C / C++)', languages: ['c', 'cpp'], commands: ['clangd'], args: ['--background-index'],
    install: { label: 'LLVM (clangd)', needs: 'winget', steps: [{ program: 'winget', args: ['install', '-e', '--id', 'LLVM.LLVM', ...WINGET] }] },
  },
  {
    id: 'lua', name: 'lua-language-server (Lua)', languages: ['lua'], commands: ['lua-language-server'], args: [],
    install: { label: 'lua-language-server', needs: 'winget', steps: [{ program: 'winget', args: ['install', '-e', '--id', 'LuaLS.lua-language-server', ...WINGET] }] },
  },
];

/** What the user may put into `lsp.servers`: change a built-in server by its id, or add one with `languages` and `command`. */
export interface ServerOverride {
  command?: string;
  args?: string[];
  languages?: string[];
  settings?: Record<string, unknown>;
  disabled?: boolean;
}

export function mergeServers(user: Record<string, ServerOverride> | undefined, builtin: ServerDef[] = BUILTIN_SERVERS): ServerDef[] {
  const out: ServerDef[] = [];
  const seen = new Set<string>();
  for (const b of builtin) {
    seen.add(b.id);
    const o = user?.[b.id];
    if (o?.disabled) continue;
    out.push(o ? {
      ...b,
      commands: o.command ? [o.command] : b.commands,
      args: o.args ?? b.args,
      languages: o.languages ?? b.languages,
      settings: o.settings ? { ...b.settings, ...o.settings } : b.settings,
      // A command chosen by the user is not ours to install.
      install: o.command ? undefined : b.install,
      pythonScripts: o.command ? false : b.pythonScripts,
    } : b);
  }
  for (const [id, o] of Object.entries(user ?? {})) {
    if (seen.has(id) || o.disabled || !o.command || !o.languages?.length) continue;
    out.push({ id, name: id, languages: o.languages, commands: [o.command], args: o.args ?? [], settings: o.settings });
  }
  return out;
}

export const serverForLanguage = (servers: ServerDef[], lang: string): ServerDef | undefined => servers.find((s) => s.languages.includes(lang));

/** The value of a dotted section (`python.analysis`) inside a settings object, or null. */
export function sectionOf(settings: Record<string, unknown> | undefined, section: string | undefined): unknown {
  if (!section) return settings ?? null;
  let cur: unknown = settings;
  for (const part of section.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur ?? null;
}
