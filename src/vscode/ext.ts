import type * as Mn from 'monaco-editor';
import { app, monaco } from '../app';
import { resetLanguageCache } from '../editor';
import { errText, ipc } from '../ipc';
import { cfg } from '../settings';
import { addTheme } from '../themes';
import { dirname, join, parseJsonc } from '../util';
import { mergeThemes, parseTheme, toLumenTheme, type RawTheme } from './convert';
import { addGrammarFile, tokensProviderFor } from './textmate';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface VsxInfo {
  id: string;
  dir: string;
  name: string;
  publisher: string;
  version: string;
  description: string;
  counts: { themes: number; snippets: number; grammars: number; languages: number };
  hasCode: boolean;
  error?: string;
}

export interface OpenVsxHit {
  namespace: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  downloadCount?: number;
  averageRating?: number;
  files: { download?: string };
}

const root = (): string => join(app.paths.config, 'vscode-extensions');
export const installedExts: VsxInfo[] = [];
let builtinLangs: Set<string> | null = null;

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return parseJsonc<T>((await ipc.readFile(path)).content, fallback); } catch { return fallback; }
}

function localize(v: unknown, nls: Record<string, any>): string {
  if (typeof v !== 'string') return '';
  const m = /^%(.+)%$/.exec(v);
  if (!m) return v;
  const e = nls[m[1]!];
  return typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : v;
}

export async function scanInstalled(): Promise<VsxInfo[]> {
  installedExts.length = 0;
  let dirs: { path: string; is_dir: boolean }[] = [];
  try { dirs = await ipc.readDir(root()); } catch { return installedExts; }
  for (const d of dirs.filter((x) => x.is_dir)) {
    const man = await readJson<any>(join(d.path, 'package.json'), null);
    if (!man?.name) continue;
    const nls = await readJson<Record<string, any>>(join(d.path, 'package.nls.json'), {});
    const c = man.contributes ?? {};
    installedExts.push({
      id: `${man.publisher ?? 'local'}.${man.name}`, dir: d.path, name: localize(man.displayName, nls) || man.name, publisher: man.publisher ?? 'local', version: man.version ?? '?',
      description: localize(man.description, nls),
      counts: { themes: (c.themes ?? []).length, snippets: (c.snippets ?? []).length, grammars: (c.grammars ?? []).length, languages: (c.languages ?? []).length },
      hasCode: !!(man.main || man.browser),
    });
  }
  installedExts.sort((a, b) => a.name.localeCompare(b.name));
  return installedExts;
}

const disabled = (): string[] => cfg<string[]>('vscode.disabled') ?? [];
export const isEnabled = (id: string): boolean => !disabled().includes(id);

function toRegex(v: unknown): RegExp | undefined {
  if (typeof v === 'string') { try { return new RegExp(v); } catch { return undefined; } }
  if (v && typeof (v as any).pattern === 'string') { try { return new RegExp((v as any).pattern, (v as any).flags ?? ''); } catch { return undefined; } }
  return undefined;
}

function langConfig(raw: any): Mn.languages.LanguageConfiguration {
  const pairs = (a: any[] | undefined) => (a ?? []).map((p: any) => (Array.isArray(p) ? { open: p[0], close: p[1] } : p));
  const cfgOut: Mn.languages.LanguageConfiguration = {
    comments: raw.comments, brackets: raw.brackets, autoClosingPairs: pairs(raw.autoClosingPairs), surroundingPairs: pairs(raw.surroundingPairs), colorizedBracketPairs: raw.colorizedBracketPairs,
  };
  const wp = toRegex(raw.wordPattern);
  if (wp) cfgOut.wordPattern = wp;
  const ir = raw.indentationRules;
  if (ir) {
    const inc = toRegex(ir.increaseIndentPattern), dec = toRegex(ir.decreaseIndentPattern);
    if (inc && dec) cfgOut.indentationRules = { increaseIndentPattern: inc, decreaseIndentPattern: dec, indentNextLinePattern: toRegex(ir.indentNextLinePattern), unIndentedLinePattern: toRegex(ir.unIndentedLinePattern) };
  }
  const fm = raw.folding?.markers;
  if (fm) { const s = toRegex(fm.start), e = toRegex(fm.end); if (s && e) cfgOut.folding = { markers: { start: s, end: e } }; }
  return cfgOut;
}

export interface Applied { themes: number; snippets: number; grammars: number; languages: number }

export async function applyExtension(info: VsxInfo): Promise<Applied> {
  const mo = monaco();
  const res: Applied = { themes: 0, snippets: 0, grammars: 0, languages: 0 };
  const man = await readJson<any>(join(info.dir, 'package.json'), {});
  const nls = await readJson<Record<string, any>>(join(info.dir, 'package.nls.json'), {});
  const c = man.contributes ?? {};
  builtinLangs ??= new Set(mo.languages.getLanguages().map((l) => l.id));

  for (const l of c.languages ?? []) {
    if (!l?.id) continue;
    mo.languages.register({ id: l.id, extensions: l.extensions, filenames: l.filenames, filenamePatterns: l.filenamePatterns, aliases: l.aliases, firstLine: l.firstLine });
    if (l.configuration) {
      const raw = await readJson<any>(join(info.dir, l.configuration), null);
      if (raw) mo.languages.setLanguageConfiguration(l.id, langConfig(raw));
    }
    res.languages++;
  }

  const langOfScope = new Map<string, string>();
  for (const g of c.grammars ?? []) if (g?.scopeName && g.path) { addGrammarFile(g.scopeName, join(info.dir, g.path)); if (g.language) langOfScope.set(g.scopeName, g.language); }
  for (const [scope, lang] of langOfScope) {
    if (builtinLangs.has(lang) && !cfg('vscode.overrideBuiltin')) continue;
    mo.languages.onLanguage(lang, () => {
      void tokensProviderFor(scope).then((p) => mo.languages.setTokensProvider(lang, p)).catch((e) => console.warn(`TextMate ${scope}:`, errText(e)));
    });
    res.grammars++;
  }

  const byLang = new Map<string, any[]>();
  for (const s of c.snippets ?? []) {
    if (!s?.language || !s.path) continue;
    const raw = await readJson<Record<string, any>>(join(info.dir, s.path), {});
    const list = byLang.get(s.language) ?? [];
    for (const [name, def] of Object.entries(raw)) {
      const prefixes: string[] = Array.isArray(def.prefix) ? def.prefix : [def.prefix];
      const body = Array.isArray(def.body) ? def.body.join('\n') : String(def.body ?? '');
      for (const p of prefixes) if (p) list.push({ prefix: String(p), name, body, description: def.description });
    }
    byLang.set(s.language, list);
  }
  for (const [lang, list] of byLang) {
    mo.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems(model, pos) {
        const w = model.getWordUntilPosition(pos);
        const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
        return { suggestions: list.map((s) => ({ label: s.prefix, detail: `${s.name} · ${info.name}`, kind: mo.languages.CompletionItemKind.Snippet, insertText: s.body, insertTextRules: mo.languages.CompletionItemInsertTextRule.InsertAsSnippet, documentation: s.description, range })) };
      },
    });
    res.snippets += list.length;
  }

  for (const t of c.themes ?? []) {
    if (!t?.path) continue;
    try {
      const raw = await loadTheme(join(info.dir, t.path));
      const label = localize(t.label, nls) || t.id || info.name;
      addTheme(toLumenTheme(`vsc:${info.id}:${label}`, `${label} (VS Code)`, t.uiTheme, raw));
      res.themes++;
    } catch (e) { console.warn('theme', t.path, errText(e)); }
  }
  resetLanguageCache();
  return res;
}

async function loadTheme(path: string, depth = 0): Promise<RawTheme> {
  const raw = parseTheme((await ipc.readFile(path)).content);
  if (raw.include && depth < 4) return mergeThemes(await loadTheme(join(dirname(path), raw.include), depth + 1), raw);
  return raw;
}

export async function applyAll(): Promise<void> {
  await scanInstalled();
  for (const e of installedExts) {
    if (!isEnabled(e.id)) continue;
    try { await applyExtension(e); } catch (err) { e.error = errText(err); }
  }
}

export async function installFrom(source: string): Promise<{ info: VsxInfo; applied: Applied }> {
  const r = await ipc.vsixInstall(source, root());
  // older versions of the same extension are removed so only the newest stays on disk
  for (const d of await ipc.readDir(root()).catch(() => [])) {
    if (d.is_dir && d.name.startsWith(`${r.id}-`) && d.path.toLowerCase() !== r.dir.toLowerCase()) await ipc.remove(d.path, true).catch(() => undefined);
  }
  await scanInstalled();
  const info = installedExts.find((e) => e.dir.toLowerCase() === r.dir.toLowerCase())!;
  return { info, applied: await applyExtension(info) };
}

export async function searchOpenVsx(query: string, sort = 'relevance'): Promise<OpenVsxHit[]> {
  const url = `https://open-vsx.org/api/-/search?query=${encodeURIComponent(query)}&size=30&sortBy=${sort}&sortOrder=desc`;
  const r = await ipc.http({ url });
  if (r.status >= 400) throw new Error(`Open VSX: HTTP ${r.status}`);
  return (JSON.parse(r.body) as { extensions?: OpenVsxHit[] }).extensions ?? [];
}

export const extRoot = root;
