import { monaco } from '../app';
import { commands } from '../commands';
import { ipc } from '../ipc';
import { cfg } from '../settings';
import { inputBox, notify } from '../ui';

const KEY = 'ai-inline';
const CONTEXT_BEFORE = 6000;
const CONTEXT_AFTER = 2000;

/** Request body of a fill-in-the-middle completion (OpenAI-style `/completions` with `suffix`: Ollama, DeepSeek beta, Codestral). */
export function fimBody(model: string, prefix: string, suffix: string, maxTokens: number): Record<string, unknown> {
  return { model, prompt: prefix, suffix, max_tokens: maxTokens, temperature: 0, stream: false };
}

export function fimText(body: string): string {
  try {
    const j = JSON.parse(body) as { choices?: { text?: string; message?: { content?: string } }[] };
    return j.choices?.[0]?.text ?? j.choices?.[0]?.message?.content ?? '';
  } catch { return ''; }
}

async function fetchCompletion(prefix: string, suffix: string): Promise<string> {
  const key = (await ipc.secretGet(KEY)) ?? '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const r = await ipc.http({ url: cfg<string>('ai.inline.url'), method: 'POST', headers, body: JSON.stringify(fimBody(cfg<string>('ai.inline.model'), prefix, suffix, cfg<number>('ai.inline.maxTokens'))) });
  return r.status < 400 ? fimText(r.body) : '';
}

export function registerGhostText(): void {
  const mo = monaco();
  let failedAt = 0;
  mo.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
    async provideInlineCompletions(model, position, _ctx, token) {
      if (!cfg<boolean>('ai.inline.enabled') || Date.now() - failedAt < 30000) return { items: [] };
      await new Promise((r) => setTimeout(r, cfg<number>('ai.inline.delay')));
      if (token.isCancellationRequested) return { items: [] };
      const offset = model.getOffsetAt(position);
      const text = model.getValue();
      const prefix = text.slice(Math.max(0, offset - CONTEXT_BEFORE), offset);
      const suffix = text.slice(offset, offset + CONTEXT_AFTER);
      try {
        const out = await fetchCompletion(prefix, suffix);
        if (token.isCancellationRequested || !out.trim()) return { items: [] };
        return { items: [{ insertText: out, range: new mo.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
      } catch {
        failedAt = Date.now(); // server is down: do not retry on every keystroke
        return { items: [] };
      }
    },
    disposeInlineCompletions() { /* nothing to release */ },
  } as import('monaco-editor').languages.InlineCompletionsProvider);

  commands.register({ id: 'ai.inline.key', title: 'ИИ: ключ для автодополнения (ghost-текст)', category: 'ИИ', run: async () => {
    const v = await inputBox({ title: 'API-ключ сервиса автодополнения (пусто — удалить)', password: true });
    if (v === undefined) return;
    if (v) await ipc.secretSet(KEY, v); else await ipc.secretDelete(KEY);
    notify(v ? 'Ключ сохранён в хранилище учётных данных Windows' : 'Ключ удалён');
  } });
}
