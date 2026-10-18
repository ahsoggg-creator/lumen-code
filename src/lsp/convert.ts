/* Conversions between LSP structures and the plain objects Monaco accepts. Pure functions, no Monaco import:
   LSP positions are 0-based UTF-16, Monaco's are 1-based, so only an offset by one is needed. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface MRange { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }

export const toRange = (r: Json): MRange => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 });
export const fromRange = (r: MRange): Json => ({ start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } });
export const fromPosition = (line: number, column: number): Json => ({ line: line - 1, character: column - 1 });

/** LSP DiagnosticSeverity 1..4 → Monaco MarkerSeverity (Error 8, Warning 4, Info 2, Hint 1). */
export const toSeverity = (s: number | undefined): number => (s === 2 ? 4 : s === 3 ? 2 : s === 4 ? 1 : 8);

export function toMarker(d: Json): Json {
  const code = d.code === undefined ? undefined : String(d.code);
  return {
    ...toRange(d.range),
    severity: toSeverity(d.severity),
    message: d.message,
    source: d.source,
    code,
    tags: (d.tags ?? []).map((t: number) => t), // Unnecessary = 1, Deprecated = 2: same numbers in Monaco
  };
}

/** LSP CompletionItemKind → Monaco CompletionItemKind. */
const COMPLETION_KIND: Record<number, number> = {
  1: 18, 2: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 7, 9: 8, 10: 9, 11: 12, 12: 13, 13: 15, 14: 17, 15: 27, 16: 19, 17: 20, 18: 21, 19: 23, 20: 16, 21: 14, 22: 6, 23: 10, 24: 11, 25: 24,
};
export const toCompletionKind = (k: number | undefined): number => COMPLETION_KIND[k ?? 1] ?? 18;

/** LSP SymbolKind → Monaco SymbolKind (the numbering is shifted by one). */
export const toSymbolKind = (k: number): number => Math.max(0, k - 1);

export function markdown(v: Json): { value: string } | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return v ? { value: v } : undefined;
  if (Array.isArray(v)) { const s = v.map((x) => markdown(x)?.value ?? '').filter(Boolean).join('\n\n'); return s ? { value: s } : undefined; }
  if (typeof v.value === 'string') {
    if (v.language) return { value: '```' + v.language + '\n' + v.value + '\n```' };
    return v.value ? { value: v.value } : undefined;
  }
  return undefined;
}

export function toCompletionItem(it: Json, range: MRange): Json {
  const edit = it.textEdit;
  const r = edit ? toRange(edit.range ?? edit.replace) : range;
  return {
    label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
    kind: toCompletionKind(it.kind),
    detail: it.detail,
    documentation: markdown(it.documentation),
    insertText: edit?.newText ?? it.insertText ?? it.label,
    insertTextRules: it.insertTextFormat === 2 ? 4 : undefined, // InsertAsSnippet
    range: r,
    sortText: it.sortText,
    filterText: it.filterText,
    preselect: it.preselect,
    commitCharacters: it.commitCharacters,
    tags: it.deprecated || it.tags?.includes(1) ? [1] : undefined,
    additionalTextEdits: it.additionalTextEdits?.map((e: Json) => ({ range: toRange(e.range), text: e.newText })),
    _lsp: it,
  };
}

export function toTextEdits(edits: Json[] | null | undefined): { range: MRange; text: string }[] {
  return (edits ?? []).map((e) => ({ range: toRange(e.range), text: e.newText }));
}

export function toSignatureHelp(h: Json): Json {
  return {
    signatures: (h.signatures ?? []).map((s: Json) => ({
      label: s.label,
      documentation: markdown(s.documentation),
      parameters: (s.parameters ?? []).map((p: Json) => ({ label: p.label, documentation: markdown(p.documentation) })),
      activeParameter: s.activeParameter,
    })),
    activeSignature: h.activeSignature ?? 0,
    activeParameter: h.activeParameter ?? 0,
  };
}

/** DocumentSymbol (hierarchical) or SymbolInformation (flat) → Monaco DocumentSymbol. */
export function toDocumentSymbols(list: Json[] | null | undefined): Json[] {
  const conv = (s: Json): Json => {
    if (s.location) return { name: s.name, detail: s.containerName ?? '', kind: toSymbolKind(s.kind), tags: [], range: toRange(s.location.range), selectionRange: toRange(s.location.range) };
    return { name: s.name, detail: s.detail ?? '', kind: toSymbolKind(s.kind), tags: s.deprecated ? [1] : [], range: toRange(s.range), selectionRange: toRange(s.selectionRange), children: s.children?.map(conv) };
  };
  return (list ?? []).map(conv);
}

export function codeActionKindOk(kind: string | undefined, only: string | undefined): boolean {
  return !only || (!!kind && (kind === only || kind.startsWith(only + '.')));
}

/** Applies LSP TextEdits (positions in the original text) to `text`; used for files that are not open in the editor. */
export function applyTextEdits(text: string, edits: Json[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const offset = (p: Json): number => {
    if (p.line >= starts.length) return text.length;
    const from = starts[p.line]!;
    let end = p.line + 1 < starts.length ? starts[p.line + 1]! - 1 : text.length;
    if (end > from && text.charCodeAt(end - 1) === 13) end--; // the CR of a CRLF is not part of the line
    return Math.min(from + p.character, end);
  };
  const sorted = edits.map((e) => ({ s: offset(e.range.start), e: offset(e.range.end), t: e.newText as string })).sort((a, b) => b.s - a.s || b.e - a.e);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.s) + e.t + out.slice(e.e);
  return out;
}
