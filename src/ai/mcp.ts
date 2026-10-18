import { errText, ipc, on } from '../ipc';
import { cfg, settings } from '../settings';
import { app } from '../app';
import { log } from '../panels';
import type { ToolDef } from './core';

/** An MCP server from the `ai.mcpServers` setting (user settings only: a server is an arbitrary program). */
export interface McpServerCfg { name: string; command: string; args?: string[]; env?: Record<string, string> }

interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }
interface Pending { ok: (r: unknown) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

const PREFIX = 'mcp__';

/** Provider-safe tool name: `mcp__<server>__<tool>`, only [A-Za-z0-9_-], at most 64 characters. */
export function toolName(server: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${PREFIX}${clean(server)}__${clean(tool)}`.slice(0, 64);
}

export const isMcpTool = (name: string): boolean => name.startsWith(PREFIX);

class McpServer {
  private seq = 1;
  private pending = new Map<number, Pending>();
  tools: McpTool[] = [];
  alive = true;
  constructor(readonly id: string, readonly cfg: McpServerCfg) {}

  handle(line: string): void {
    let m: { id?: number; result?: unknown; error?: { message?: string } };
    try { m = JSON.parse(line); } catch { return; }
    if (typeof m.id !== 'number') return; // notifications and server requests are not needed by the agent
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.fail(new Error(m.error.message ?? 'ошибка MCP')); else p.ok(m.result);
  }

  exited(): void {
    this.alive = false;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.fail(new Error('MCP-сервер завершился')); }
    this.pending.clear();
  }

  request<T>(method: string, params: unknown, timeoutMs = 60000): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('MCP-сервер остановлен'));
    const id = this.seq++;
    return new Promise<T>((ok, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error(`сервер не ответил на «${method}»`)); }, timeoutMs);
      this.pending.set(id, { ok: ok as (r: unknown) => void, fail, timer });
      ipc.mcpSend(this.id, JSON.stringify({ jsonrpc: '2.0', id, method, params })).catch((e) => { clearTimeout(timer); this.pending.delete(id); fail(new Error(String(e))); });
    });
  }

  notify(method: string): Promise<void> { return ipc.mcpSend(this.id, JSON.stringify({ jsonrpc: '2.0', method })); }

  async start(): Promise<void> {
    await ipc.mcpSpawn(this.id, this.cfg.command, this.cfg.args ?? [], app.root ?? undefined, this.cfg.env);
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lumen-code', version: app.version } }, 30000);
    await this.notify('notifications/initialized');
    const r = await this.request<{ tools?: McpTool[] }>('tools/list', {});
    this.tools = r.tools ?? [];
  }
}

const servers = new Map<string, McpServer>();
const byTool = new Map<string, { server: McpServer; tool: string }>();
let loading: Promise<ToolDef[]> | null = null;
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  void on<{ id: string; msg: string }>('mcp-msg', (p) => servers.get(p.id)?.handle(p.msg));
  void on<{ id: string }>('mcp-exit', (p) => servers.get(p.id)?.exited());
  void on<{ id: string; line: string }>('mcp-log', (p) => log('MCP', `${servers.get(p.id)?.cfg.name ?? p.id}: ${p.line}`));
  // Changing the server list restarts everything on the next request.
  settings.changed.on((k) => { if (k.includes('ai.mcpServers')) void stopMcp(); });
}

/** Starts the configured servers (once) and returns their tools in the agent's tool format. */
export function mcpTools(): Promise<ToolDef[]> {
  wire();
  loading ??= (async () => {
    const out: ToolDef[] = [];
    for (const c of cfg<McpServerCfg[]>('ai.mcpServers') ?? []) {
      if (!c?.name || !c.command) continue;
      const s = new McpServer(`mcp-${c.name}`, c);
      servers.set(s.id, s);
      try {
        await s.start();
      } catch (e) {
        log('MCP', `${c.name}: не удалось запустить — ${errText(e)}`);
        void ipc.mcpClose(s.id);
        servers.delete(s.id);
        continue;
      }
      for (const t of s.tools) {
        const name = toolName(c.name, t.name);
        byTool.set(name, { server: s, tool: t.name });
        out.push({ name, description: `[MCP: ${c.name}] ${t.description ?? t.name}`, schema: t.inputSchema ?? { type: 'object', properties: {} } });
      }
    }
    return out;
  })();
  return loading;
}

export async function stopMcp(): Promise<void> {
  loading = null;
  byTool.clear();
  for (const s of servers.values()) { s.alive = false; void ipc.mcpClose(s.id); }
  servers.clear();
}

export async function callMcp(name: string, args: Record<string, unknown>): Promise<string> {
  const t = byTool.get(name);
  if (!t) return `Ошибка: MCP-инструмент ${name} недоступен`;
  const r = await t.server.request<{ content?: { type: string; text?: string }[]; isError?: boolean }>('tools/call', { name: t.tool, arguments: args }, 120000);
  const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');
  return r.isError ? `Ошибка: ${text}` : text || '(пустой ответ)';
}
