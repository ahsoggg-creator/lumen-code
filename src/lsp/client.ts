import { ipc, on } from '../ipc';
import { Emitter } from '../util';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export interface Transport {
  send(msg: string): Promise<void>;
}

export class LspError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

const clients = new Map<string, LspClient>();
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  void on<{ id: string; msg: string }>('lsp-msg', (p) => clients.get(p.id)?.handle(p.msg));
  void on<{ id: string }>('lsp-exit', (p) => clients.get(p.id)?.closed.fire());
  void on<{ id: string; line: string }>('lsp-log', (p) => clients.get(p.id)?.log.fire(p.line));
}

/** JSON-RPC 2.0 client for one language server: request/response matching, notifications and requests from the server. */
export class LspClient {
  private seq = 1;
  private pending = new Map<number, { ok: (r: Json) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private notifications = new Map<string, (params: Json) => void>();
  private requests = new Map<string, (params: Json) => unknown>();
  readonly closed = new Emitter<void>();
  readonly log = new Emitter<string>();
  capabilities: Json = {};
  alive = true;

  /** `transport` defaults to the Rust side (stdio of a spawned server); tests pass their own. */
  private transport: Transport;
  constructor(readonly id: string, transport?: Transport) {
    this.transport = transport ?? { send: (msg) => ipc.lspSend(id, msg) };
    if (!transport) wire();
    clients.set(id, this);
  }

  async spawn(program: string, args: string[], cwd?: string): Promise<void> { await ipc.lspSpawn(this.id, program, args, cwd); }

  onNotification(method: string, fn: (params: Json) => void): void { this.notifications.set(method, fn); }
  /** Answers requests the server sends to us (`workspace/configuration`, ...). Throwing yields a JSON-RPC error. */
  onRequest(method: string, fn: (params: Json) => unknown): void { this.requests.set(method, fn); }

  request<T = Json>(method: string, params: Json = null, timeoutMs = 30000): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('языковой сервер остановлен'));
    const id = this.seq++;
    return new Promise<T>((ok, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error(`сервер не ответил на «${method}»`)); }, timeoutMs);
      this.pending.set(id, { ok, fail, timer });
      this.write({ jsonrpc: '2.0', id, method, params }).catch((e) => { clearTimeout(timer); this.pending.delete(id); fail(new Error(String(e))); });
    });
  }

  notify(method: string, params: Json = null): void {
    if (this.alive) void this.write({ jsonrpc: '2.0', method, params }).catch(() => undefined);
  }

  private write(msg: Json): Promise<void> { return this.transport.send(JSON.stringify(msg)); }

  handle(raw: string): void {
    let m: Json;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.method !== undefined && m.id !== undefined) void this.answer(m);
    else if (m.method !== undefined) this.notifications.get(m.method)?.(m.params);
    else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.fail(new LspError(m.error.message ?? `ошибка «${m.id}»`, m.error.code ?? 0)); else p.ok(m.result);
    }
  }

  private async answer(m: Json): Promise<void> {
    const handler = this.requests.get(m.method);
    try {
      if (!handler) throw new LspError(`method not found: ${m.method}`, -32601);
      const result = await handler(m.params);
      await this.write({ jsonrpc: '2.0', id: m.id, result: result ?? null });
    } catch (e) {
      const code = e instanceof LspError ? e.code : -32603;
      await this.write({ jsonrpc: '2.0', id: m.id, error: { code, message: e instanceof Error ? e.message : String(e) } }).catch(() => undefined);
    }
  }

  /** Cancels waiting requests; called when the server process ends or the client is closed. */
  private failAll(reason: string): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.fail(new Error(reason)); }
    this.pending.clear();
  }

  /** Polite shutdown (`shutdown` + `exit`), then the process is killed anyway. */
  async stop(): Promise<void> {
    if (!this.alive) return;
    try { await this.request('shutdown', null, 2000); this.notify('exit'); } catch { /* the server may already be gone */ }
    this.dispose();
  }

  dispose(): void {
    this.alive = false;
    this.failAll('языковой сервер остановлен');
    clients.delete(this.id);
    void ipc.lspClose(this.id).catch(() => undefined);
  }

  /** The process exited on its own. */
  markDead(): void {
    this.alive = false;
    this.failAll('языковой сервер завершился');
  }
}
