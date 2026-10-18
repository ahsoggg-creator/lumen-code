/* eslint-disable @typescript-eslint/no-explicit-any */
// Talks to a real language server over stdio. Skipped unless LUMEN_LSP_SERVER points at one, e.g.
//   $env:LUMEN_LSP_SERVER = "C:\path\to\venv\Scripts\basedpyright-langserver.exe"; npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LspClient } from './client';
import { applyTextEdits } from './convert';
import { sectionOf } from './servers';

const server = process.env.LUMEN_LSP_SERVER;
/** Servers normalize file URIs (`file:///c%3A/...`); compare them the way the editor does, by decoded lower-case text. */
const same = (a: string, b: string): boolean => decodeURIComponent(a).toLowerCase() === decodeURIComponent(b).toLowerCase();

const SOURCE = [
  'import os',
  '',
  'class Greeter:',
  '    def hello(self, name: str) -> str:',
  '        return "hi " + name',
  '',
  'g = Greeter()',
  'g.hello(1)',
  'undefined_name',
  '',
].join('\n');

describe.skipIf(!server)('real language server', () => {
  let dir = '';
  let uri = '';
  let proc: ReturnType<typeof spawn>;
  let client: LspClient;
  const diagnostics: any[] = [];
  const settings = { python: { analysis: { autoSearchPaths: true, useLibraryCodeForTypes: true } } };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-lsp-'));
    const file = join(dir, 'sample.py');
    writeFileSync(file, SOURCE);
    uri = pathToFileURL(file).toString();
    proc = spawn(server!, ['--stdio'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
    client = new LspClient('e2e', { send: async (m) => { proc.stdin!.write(`Content-Length: ${Buffer.byteLength(m)}\r\n\r\n${m}`); } });

    let buf = Buffer.alloc(0);
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const head = buf.indexOf('\r\n\r\n');
        if (head < 0) return;
        const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, head).toString())![1]);
        if (buf.length < head + 4 + len) return;
        client.handle(buf.subarray(head + 4, head + 4 + len).toString());
        buf = buf.subarray(head + 4 + len);
      }
    });

    client.onNotification('textDocument/publishDiagnostics', (p) => { if (same(p.uri, uri)) diagnostics.push(...p.diagnostics); });
    client.onRequest('workspace/configuration', (p: any) => p.items.map((i: any) => sectionOf(settings, i.section)));
    client.onRequest('client/registerCapability', () => null);
    client.onRequest('window/workDoneProgress/create', () => null);

    const root = pathToFileURL(dir).toString();
    await client.request('initialize', {
      processId: process.pid, rootUri: root, workspaceFolders: [{ uri: root, name: 'p' }],
      capabilities: { textDocument: { publishDiagnostics: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, rename: { prepareSupport: true } }, workspace: { configuration: true, workspaceFolders: true } },
    }, 60000);
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version: 1, text: SOURCE } });
  }, 90000);

  afterAll(async () => {
    await client?.request('shutdown', null, 5000).catch(() => undefined);
    client?.notify('exit');
    if (proc && proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await exited;
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('reports errors for the opened file', async () => {
    await expect.poll(() => diagnostics.length, { timeout: 60000, interval: 200 }).toBeGreaterThan(0);
    const messages = diagnostics.map((d) => d.message).join('\n');
    expect(messages).toMatch(/undefined_name/);
    expect(diagnostics.every((d) => d.range.start.line >= 0)).toBe(true);
  }, 90000);

  it('answers hover', async () => {
    const r = await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 2, character: 8 } });
    expect(JSON.stringify(r.contents)).toMatch(/Greeter/);
  }, 30000);

  it('goes to a definition', async () => {
    const r = await client.request('textDocument/definition', { textDocument: { uri }, position: { line: 6, character: 5 } });
    const loc = Array.isArray(r) ? r[0] : r;
    expect(same(loc.uri ?? loc.targetUri, uri)).toBe(true);
    expect((loc.range ?? loc.targetSelectionRange).start.line).toBe(2);
  }, 30000);

  it('lists symbols as a hierarchy', async () => {
    const r = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    const greeter = r.find((s: any) => s.name === 'Greeter');
    expect(greeter.children.map((c: any) => c.name)).toContain('hello');
  }, 30000);

  it('completes after the text changes', async () => {
    const text = SOURCE + 'g.he';
    client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text }] });
    const r = await client.request('textDocument/completion', { textDocument: { uri }, position: { line: 9, character: 4 }, context: { triggerKind: 1 } });
    const items = Array.isArray(r) ? r : r.items;
    expect(items.map((i: any) => i.label)).toContain('hello');
  }, 30000);

  it('renames a class across its uses and the edit applies to the text', async () => {
    client.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: SOURCE }] });
    const r = await client.request('textDocument/rename', { textDocument: { uri }, position: { line: 2, character: 8 }, newName: 'Welcomer' });
    const edits = Object.values<any[]>(r.changes ?? {})[0] ?? r.documentChanges?.[0]?.edits;
    expect(edits.length).toBeGreaterThanOrEqual(2);
    const out = applyTextEdits(SOURCE, edits);
    expect(out).toContain('class Welcomer:');
    expect(out).toContain('g = Welcomer()');
    expect(out).not.toContain('Greeter');
  }, 30000);
});
