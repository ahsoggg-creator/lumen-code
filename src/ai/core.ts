import { ipc, on } from '../ipc';
import { app } from '../app';
import { runTask } from '../tasks';
import { settings, cfg } from '../settings';
import { Emitter, uid } from '../util';

// ---------------------------------------------------------------- providers
export type ProviderKind = 'openai' | 'anthropic' | 'claude-cli';
export interface Provider { id: string; name: string; kind: ProviderKind; baseUrl: string; model: string; needsKey?: boolean }

export const PRESETS: { name: string; kind: ProviderKind; baseUrl: string; model: string; needsKey: boolean; hint?: string }[] = [
  { name: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', needsKey: true },
  { name: 'Claude по подписке (Claude Code CLI)', kind: 'claude-cli', baseUrl: '', model: 'sonnet', needsKey: false, hint: 'Нужен установленный Claude Code и вход через `claude auth login`. Только чат, без инструментов агента.' },
  { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', needsKey: true },
  { name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5', needsKey: true },
  { name: 'Ollama (локально)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder', needsKey: false },
  { name: 'LM Studio (локально)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'local-model', needsKey: false },
  { name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true },
  { name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true },
  { name: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro', needsKey: true },
  { name: 'Другой (OpenAI-совместимый)', kind: 'openai', baseUrl: 'http://localhost:8000/v1', model: 'model', needsKey: false },
];

export const providers = (): Provider[] => cfg<Provider[]>('ai.providers') ?? [];
export function activeProvider(): Provider | null {
  const list = providers();
  return list.find((p) => p.id === cfg('ai.activeProvider')) ?? list[0] ?? null;
}
export function saveProviders(list: Provider[]): void { settings.set('ai.providers', list); }
export const keyName = (p: Provider): string => `ai:${p.id}`;
export async function apiKey(p: Provider): Promise<string> { return (await ipc.secretGet(keyName(p))) ?? ''; }

// ---------------------------------------------------------------- neutral message model
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ToolDef { name: string; description: string; schema: Record<string, unknown> }
export type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls?: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; result: string };

export interface StreamHandlers { onText?: (t: string) => void; onCall?: (c: ToolCall) => void }
export interface StreamResult { text: string; calls: ToolCall[]; stop: string }

function headers(p: Provider, key: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (p.kind === 'anthropic') {
    h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
  } else if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

function toOpenAI(system: string, msgs: Msg[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of msgs) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.text || null, ...(m.calls?.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) });
    } else out.push({ role: 'tool', tool_call_id: m.callId, content: m.result });
  }
  return out;
}

function toAnthropic(msgs: Msg[]): unknown[] {
  const out: { role: string; content: unknown[] | string }[] = [];
  for (const m of msgs) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      const blocks: unknown[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const c of m.calls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      out.push({ role: 'assistant', content: blocks.length ? blocks : '…' });
    } else {
      const block = { type: 'tool_result', tool_use_id: m.callId, content: m.result };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

const streams = new Map<string, { onLine: (l: string, status: number) => void; end: (err: string | null, status: number) => void }>();
let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  void on<{ id: string; line: string; status: number }>('http-chunk', (p) => streams.get(p.id)?.onLine(p.line, p.status));
  void on<{ id: string; error: string | null; status: number }>('http-end', (p) => streams.get(p.id)?.end(p.error, p.status));
}

export class AbortHandle {
  aborted = false;
  private id: string | null = null;
  private extra: (() => void)[] = [];
  set(id: string): void { this.id = id; if (this.aborted) void ipc.httpCancel(id); }
  /** Runs `fn` on abort (immediately if already aborted): for work that is not an HTTP stream. */
  onAbort(fn: () => void): void { if (this.aborted) fn(); else this.extra.push(fn); }
  abort(): void { this.aborted = true; if (this.id) void ipc.httpCancel(this.id); for (const f of this.extra.splice(0)) f(); }
}

export async function streamChat(p: Provider, system: string, msgs: Msg[], tools: ToolDef[], h: StreamHandlers, abort: AbortHandle): Promise<StreamResult> {
  if (p.kind === 'claude-cli') return streamClaudeCli(p, system, msgs, tools.length > 0, h, abort);
  wire();
  const key = await apiKey(p);
  if (!key && p.needsKey !== false) throw new Error(`Не задан API-ключ для «${p.name}». Откройте панель ИИ → шестерёнка.`);
  const temperature = cfg<number>('ai.temperature');
  const maxTokens = cfg<number>('ai.maxTokens');
  let url: string;
  let body: Record<string, unknown>;
  if (p.kind === 'anthropic') {
    url = `${p.baseUrl.replace(/\/+$/, '')}/v1/messages`;
    body = { model: p.model, max_tokens: maxTokens, temperature, stream: true, system, messages: toAnthropic(msgs), ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) } : {}) };
  } else {
    url = `${p.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    body = { model: p.model, temperature, max_tokens: maxTokens, stream: true, messages: toOpenAI(system, msgs), ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}) };
  }
  const id = uid('http');
  abort.set(id);
  let text = '';
  let stop = '';
  const calls: ToolCall[] = [];
  const partial = new Map<number, { id: string; name: string; json: string }>();
  let errBody = '';
  let status = 0;

  const onData = (data: string) => {
    let j: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { j = JSON.parse(data); } catch { return; }
    if (p.kind === 'anthropic') {
      if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') partial.set(j.index, { id: j.content_block.id, name: j.content_block.name, json: '' });
      else if (j.type === 'content_block_delta') {
        if (j.delta?.type === 'text_delta') { text += j.delta.text; h.onText?.(j.delta.text); }
        else if (j.delta?.type === 'input_json_delta') { const c = partial.get(j.index); if (c) c.json += j.delta.partial_json; }
      } else if (j.type === 'content_block_stop') {
        const c = partial.get(j.index);
        if (c) { partial.delete(j.index); const call = { id: c.id, name: c.name, args: safeJson(c.json) }; calls.push(call); h.onCall?.(call); }
      } else if (j.type === 'message_delta' && j.delta?.stop_reason) stop = j.delta.stop_reason;
      else if (j.type === 'error') errBody = j.error?.message ?? 'ошибка провайдера';
    } else {
      if (j.error) { errBody = j.error.message ?? JSON.stringify(j.error); return; }
      const ch = j.choices?.[0];
      if (!ch) return;
      const d = ch.delta ?? {};
      if (d.content) { text += d.content; h.onText?.(d.content); }
      for (const tc of d.tool_calls ?? []) {
        const c = partial.get(tc.index ?? 0) ?? { id: '', name: '', json: '' };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.json += tc.function.arguments;
        partial.set(tc.index ?? 0, c);
      }
      if (ch.finish_reason) stop = ch.finish_reason;
    }
  };

  await new Promise<void>((resolve, reject) => {
    streams.set(id, {
      onLine: (line, st) => {
        status = st;
        if (line.startsWith('data:')) { const d = line.slice(5).trim(); if (d && d !== '[DONE]') onData(d); }
        else if (!line.startsWith('event:') && !line.startsWith(':') && line.trim() && status !== 200) errBody += line;
      },
      end: (err, st) => { streams.delete(id); status = st; if (err) reject(new Error(err)); else resolve(); },
    });
    ipc.httpStream(id, { url, method: 'POST', headers: headers(p, key), body: JSON.stringify(body) }).catch(reject);
  });
  if (p.kind === 'openai') {
    for (const [, c] of [...partial].sort((a, b) => a[0] - b[0])) { const call = { id: c.id || uid('call'), name: c.name, args: safeJson(c.json) }; calls.push(call); h.onCall?.(call); }
  }
  if (status >= 400 || (errBody && !text && !calls.length)) throw new Error(`${status ? `HTTP ${status}: ` : ''}${errBody.slice(0, 600) || 'ошибка запроса'}`);
  return { text, calls, stop };
}

/** Credential files Claude Code must not read (same idea as the agent's own `sensitivePath` prompt). */
const SECRET_READS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.pfx', '**/*.p12', '**/id_rsa*', '**/id_ed25519*', '**/.npmrc', '**/.pypirc', '**/.netrc', '**/.git-credentials', '**/credentials', '**/secrets*'].map((g) => `Read(${g})`).join(',');

const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Chat through the user's own Claude Code login (subscription): the official `claude -p` CLI, no tools, history passed as text. */
async function streamClaudeCli(p: Provider, system: string, msgs: Msg[], agent: boolean, h: StreamHandlers, abort: AbortHandle): Promise<StreamResult> {
  const dir = `${app.paths.config}\\claude-chat`;
  await ipc.mkdir(dir);
  const turns = msgs.filter((m): m is Extract<Msg, { role: 'user' | 'assistant' }> => m.role !== 'tool').map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`);
  // Agent mode: Claude Code's own tools work in the open project; the "agent rights" settings decide which exist (headless mode cannot ask).
  let root = agent ? app.root : null;
  // Reading follows the "read without asking" setting too; Bash is offered only when commands are auto-approved and is NOT filtered by Lumen's danger list.
  const allowed = root ? [...(cfg('ai.autoApproveReads') ? ['Read', 'Glob', 'Grep'] : []), ...(cfg('ai.autoApproveEdits') ? ['Edit', 'Write'] : []), ...(cfg('ai.autoApproveCommands') ? ['Bash'] : [])] : [];
  if (!allowed.length) root = null;
  const toolNote = root
    ? `You work in the project folder ${root} with these tools: ${allowed.join(', ')}. Use them to read and change files there directly instead of pasting code into the chat.${cfg('ai.autoApproveEdits') ? '' : ' Editing is disabled (the user has not allowed it): show changes as code blocks.'}`
    : `No tools are available in this chat: answer from the provided context only.${agent ? ' No project folder is open, so files cannot be changed: tell the user to open a folder (File > Open Folder).' : ''}`;
  const prompt = `<instructions>\n${system}\n${toolNote}\n</instructions>\n\n${turns.join('\n\n')}\n\nAssistant:`;
  const file = `${dir}\\prompt-${uid('p')}.txt`;
  await ipc.writeFile(file, prompt);
  const utf8 = '$e=[Text.UTF8Encoding]::new($false);$OutputEncoding=$e;[Console]::OutputEncoding=$e;';
  const cmd = `${utf8}Get-Content -Raw -Encoding UTF8 -LiteralPath ${psq(file)} | claude -p --output-format stream-json --verbose --include-partial-messages --no-session-persistence --tools ${allowed.length ? psq(allowed.join(',')) : `'""'`} ${root ? "--permission-mode acceptEdits " : ''}${allowed.includes('Bash') ? "--allowedTools Bash " : ''}${allowed.length ? `--disallowedTools ${psq(SECRET_READS)} ` : ''}--setting-sources user --strict-mcp-config --disable-slash-commands --model ${psq(p.model || 'sonnet')}`;
  let text = '';
  let err = '';
  let failed = '';
  const task = runTask('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    cwd: root ?? dir,
    onLine: (line, stream) => {
      if (stream === 'stderr') { err += `${line}\n`; return; }
      let j: { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } }; is_error?: boolean; result?: string; message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] } };
      try { j = JSON.parse(line); } catch { return; }
      if (j.type === 'stream_event' && j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta' && j.event.delta.text) { text += j.event.delta.text; h.onText?.(j.event.delta.text); }
      else if (j.type === 'assistant') {
        for (const b of j.message?.content ?? []) {
          if (b.type !== 'tool_use') continue;
          const i = b.input ?? {};
          const what = String(i.file_path ?? i.path ?? i.pattern ?? i.command ?? '').slice(0, 120);
          const note = `

> ⚙ ${b.name}${what ? `: \`${what}\`` : ''}

`;
          text += note;
          h.onText?.(note);
        }
      } else if (j.type === 'result' && j.is_error) failed = j.result ?? 'ошибка Claude Code';
    },
  });
  abort.onAbort(task.kill);
  const code = await task.done;
  void ipc.remove(file, true).catch(() => undefined);
  if (abort.aborted) return { text, calls: [], stop: 'abort' };
  if (failed || (code !== 0 && !text)) {
    const why = failed || err.trim() || `код выхода ${code}`;
    throw new Error(/not recognized|не распознан|CommandNotFound/i.test(why) ? 'Claude Code не найден в PATH: установите его и выполните `claude auth login`' : why.slice(0, 600));
  }
  return { text, calls: [], stop: 'end_turn' };
}

function safeJson(s: string): Record<string, unknown> {
  if (!s.trim()) return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

export async function listModels(p: Provider): Promise<string[]> {
  if (p.kind === 'claude-cli') return ['sonnet', 'opus', 'haiku'];
  const key = await apiKey(p);
  const url = p.kind === 'anthropic' ? `${p.baseUrl.replace(/\/+$/, '')}/v1/models?limit=100` : `${p.baseUrl.replace(/\/+$/, '')}/models`;
  const r = await ipc.http({ url, method: 'GET', headers: headers(p, key) });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const j = JSON.parse(r.body) as { data?: { id: string }[]; models?: { name: string }[] };
  return (j.data ?? []).map((m) => m.id).concat((j.models ?? []).map((m) => m.name)).sort();
}

/** One-shot, non-agentic completion (used by plugins and quick actions). */
export async function complete(prompt: string, system = ''): Promise<string> {
  const p = activeProvider();
  if (!p) throw new Error('ИИ-провайдер не настроен');
  return (await streamChat(p, system, [{ role: 'user', text: prompt }], [], {}, new AbortHandle())).text;
}

// ---------------------------------------------------------------- agents registered by plugins
export interface AgentCtx {
  prompt: string;
  file: { path: string | null; text: string; language: string } | null;
  selection: string;
  workspace: string | null;
  emit(text: string): void;
  signal: AbortHandle;
}
export interface PluginAgent { id: string; name: string; description?: string; run(ctx: AgentCtx): Promise<string | void> | string | void }
export const pluginAgents = new Map<string, PluginAgent>();
export const agentsChanged = new Emitter<void>();
