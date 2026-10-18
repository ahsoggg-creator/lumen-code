/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { applyTextEdits, codeActionKindOk, markdown, toCompletionItem, toDocumentSymbols, toMarker, toRange, toSeverity, toSymbolKind } from './convert';

const R = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });

describe('positions and diagnostics', () => {
  it('shifts 0-based LSP ranges to 1-based Monaco ranges', () => {
    expect(toRange(R(0, 0, 2, 5))).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 6 });
  });
  it('maps severities (error 8, warning 4, info 2, hint 1)', () => {
    expect([1, 2, 3, 4, undefined].map(toSeverity)).toEqual([8, 4, 2, 1, 8]);
  });
  it('builds a marker with a string code', () => {
    const m = toMarker({ range: R(1, 2, 1, 4), severity: 2, message: 'unused', code: 123, source: 'pyright' });
    expect(m).toMatchObject({ startLineNumber: 2, startColumn: 3, severity: 4, message: 'unused', code: '123', source: 'pyright' });
  });
});

describe('completion', () => {
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 };
  it('uses the default range and snippet rules', () => {
    const item = toCompletionItem({ label: 'print', kind: 3, insertText: 'print($0)', insertTextFormat: 2 }, range);
    expect(item).toMatchObject({ label: 'print', kind: 1, insertText: 'print($0)', insertTextRules: 4, range });
  });
  it('prefers the textEdit range and text, including InsertReplaceEdit', () => {
    const item = toCompletionItem({ label: 'x', textEdit: { replace: R(0, 0, 0, 2), insert: R(0, 0, 0, 1), newText: 'xyz' } }, range);
    expect(item).toMatchObject({ insertText: 'xyz', range: { startLineNumber: 1, endColumn: 3 } });
  });
});

describe('markdown', () => {
  it('handles strings, MarkupContent, MarkedString and arrays', () => {
    expect(markdown('hi')).toEqual({ value: 'hi' });
    expect(markdown({ kind: 'markdown', value: '**b**' })).toEqual({ value: '**b**' });
    expect(markdown({ language: 'py', value: 'x = 1' })).toEqual({ value: '```py\nx = 1\n```' });
    expect(markdown(['a', { value: 'b' }])).toEqual({ value: 'a\n\nb' });
    expect(markdown(null)).toBeUndefined();
    expect(markdown('')).toBeUndefined();
  });
});

describe('symbols', () => {
  it('shifts SymbolKind by one', () => {
    expect(toSymbolKind(5)).toBe(4); // Class
    expect(toSymbolKind(12)).toBe(11); // Function
  });
  it('converts hierarchical and flat symbols', () => {
    const h = toDocumentSymbols([{ name: 'C', kind: 5, range: R(0, 0, 5, 0), selectionRange: R(0, 6, 0, 7), children: [{ name: 'm', kind: 6, range: R(1, 0, 2, 0), selectionRange: R(1, 4, 1, 5) }] }]);
    expect((h[0] as any).children[0]).toMatchObject({ name: 'm', kind: 5 });
    const f = toDocumentSymbols([{ name: 'f', kind: 12, containerName: 'mod', location: { uri: 'file:///a', range: R(3, 0, 4, 0) } }]);
    expect(f[0]).toMatchObject({ name: 'f', detail: 'mod', kind: 11 });
  });
});

describe('applyTextEdits', () => {
  it('applies several edits against the original positions', () => {
    const text = 'foo = 1\nprint(foo)\n';
    const out = applyTextEdits(text, [
      { range: R(0, 0, 0, 3), newText: 'bar' },
      { range: R(1, 6, 1, 9), newText: 'bar' },
    ]);
    expect(out).toBe('bar = 1\nprint(bar)\n');
  });
  it('keeps CRLF line ends and clamps a position past the end of a line', () => {
    expect(applyTextEdits('a\r\nb\r\n', [{ range: R(0, 1, 0, 99), newText: 'X' }])).toBe('aX\r\nb\r\n');
  });
  it('inserts at the end of the file', () => {
    expect(applyTextEdits('x', [{ range: R(5, 0, 5, 0), newText: '!' }])).toBe('x!');
  });
});

describe('codeActionKindOk', () => {
  it('matches a kind and its sub-kinds only', () => {
    expect(codeActionKindOk('quickfix', undefined)).toBe(true);
    expect(codeActionKindOk('refactor.extract', 'refactor')).toBe(true);
    expect(codeActionKindOk('refactorX', 'refactor')).toBe(false);
    expect(codeActionKindOk(undefined, 'quickfix')).toBe(false);
  });
});
