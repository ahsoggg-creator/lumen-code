/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { LspClient } from './client';

function setup() {
  const sent: any[] = [];
  const client = new LspClient('t', { send: async (m) => { sent.push(JSON.parse(m)); } });
  return { client, sent };
}

describe('LspClient', () => {
  it('matches responses to requests by id', async () => {
    const { client, sent } = setup();
    const p = client.request('textDocument/hover', { a: 1 });
    expect(sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: { a: 1 } });
    client.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects with the server error', async () => {
    const { client } = setup();
    const p = client.request('x');
    client.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }));
    await expect(p).rejects.toMatchObject({ message: 'nope', code: -32601 });
  });

  it('times out a silent server', async () => {
    vi.useFakeTimers();
    const { client } = setup();
    const p = client.request('x', null, 1000);
    const assertion = expect(p).rejects.toThrow(/не ответил/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    vi.useRealTimers();
  });

  it('delivers notifications to their handler', () => {
    const { client } = setup();
    const got: unknown[] = [];
    client.onNotification('textDocument/publishDiagnostics', (p) => got.push(p));
    client.handle(JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///a' } }));
    client.handle(JSON.stringify({ jsonrpc: '2.0', method: 'unknown/thing', params: {} }));
    expect(got).toEqual([{ uri: 'file:///a' }]);
  });

  it('answers requests from the server, e.g. workspace/configuration', async () => {
    const { client, sent } = setup();
    client.onRequest('workspace/configuration', (p: any) => p.items.map((i: any) => ({ section: i.section })));
    client.handle(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: { items: [{ section: 'python' }] } }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 7, result: [{ section: 'python' }] });
  });

  it('replies MethodNotFound to a request nobody handles', async () => {
    const { client, sent } = setup();
    client.handle(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'custom/unknown' }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ id: 3, error: { code: -32601 } });
  });

  it('ignores malformed input and unknown ids', () => {
    const { client } = setup();
    expect(() => {
      client.handle('not json');
      client.handle(JSON.stringify({ jsonrpc: '2.0', id: 99, result: 1 }));
    }).not.toThrow();
  });

  it('fails waiting requests when the process dies', async () => {
    const { client } = setup();
    const p = client.request('x');
    client.markDead();
    await expect(p).rejects.toThrow(/завершился/);
    await expect(client.request('y')).rejects.toThrow();
  });
});
