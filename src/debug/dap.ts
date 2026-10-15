import { ipc, on } from '../ipc';
import { Emitter } from '../util';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DapEvent { event: string; body: any }

const clients = new Map<string, DapClient>();
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  void on<{ id: string; msg: string }>('dap-msg', (p) => clients.get(p.id)?.handle(p.msg));
  void on<{ id: string }>('dap-exit', (p) => clients.get(p.id)?.closed.fire());
  void on<{ id: string; line: string }>('dap-log', (p) => clients.get(p.id)?.log.fire(p.line));
}

/** Minimal Debug Adapter Protocol client: request/response matching plus events. */
export class DapClient {
  private seq = 1;
  private pending = new Map<number, { ok: (b: any) => void; fail: (e: Error) => void; timer: number }>();
  readonly events = new Emitter<DapEvent>();
  readonly closed = new Emitter<void>();
  readonly log = new Emitter<string>();
  capabilities: Record<string, any> = {};
  constructor(readonly id: string) { wire(); clients.set(id, this); }

  async connect(host: string, port: number, timeoutMs: number): Promise<void> { await ipc.dapConnect(this.id, host, port, timeoutMs); }
  async spawn(program: string, args: string[], cwd?: string): Promise<void> { await ipc.dapSpawn(this.id, program, args, cwd); }

  request<T = any>(command: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    const seq = this.seq++;
    return new Promise<T>((ok, fail) => {
      const timer = window.setTimeout(() => { this.pending.delete(seq); fail(new Error(`отладчик не ответил на «${command}»`)); }, timeoutMs);
      this.pending.set(seq, { ok, fail, timer });
      ipc.dapSend(this.id, JSON.stringify({ seq, type: 'request', command, arguments: args })).catch((e) => { clearTimeout(timer); this.pending.delete(seq); fail(new Error(String(e))); });
    });
  }

  handle(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'response') {
      const p = this.pending.get(m.request_seq);
      if (!p) return;
      this.pending.delete(m.request_seq);
      clearTimeout(p.timer);
      if (m.success) p.ok(m.body ?? {}); else p.fail(new Error(m.message ?? `ошибка «${m.command}»`));
    } else if (m.type === 'event') {
      this.events.fire({ event: m.event, body: m.body ?? {} });
    } else if (m.type === 'request') {
      // Reverse requests (runInTerminal, startDebugging) are not supported: say so politely.
      void ipc.dapSend(this.id, JSON.stringify({ seq: this.seq++, type: 'response', request_seq: m.seq, success: false, command: m.command, message: 'not supported' }));
    }
  }

  close(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.fail(new Error('сеанс отладки закрыт')); }
    this.pending.clear();
    clients.delete(this.id);
    void ipc.dapClose(this.id);
  }
}
