import type * as M from 'monaco-editor';
import { monaco } from './app';
import { commands } from './commands';
import { editors } from './editor';
import { errText, ipc, type SendResp } from './ipc';
import { applyVars, parseHttpFile, requestAt } from './httpfile';
import { notify } from './ui';
import { Emitter, h } from './util';

const SEND_CMD = 'lumen.http.send';

type Shown = { title: string; sentAt: Date; resp?: SendResp; error?: string; pending?: boolean };
let shown: Shown | null = null;
const changed = new Emitter<void>();

const statusClass = (s: number): string => (s >= 500 ? 'bad' : s >= 400 ? 'warn' : s >= 300 ? 'info' : 'ok');
const size = (n: number): string => (n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1048576).toFixed(1)} МБ`);

function pretty(resp: SendResp): { text: string; lang: string } {
  const ct = resp.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  if (/json/i.test(ct) || /^\s*[[{]/.test(resp.body)) {
    try { return { text: JSON.stringify(JSON.parse(resp.body), null, 2), lang: 'json' }; } catch { /* not JSON */ }
  }
  if (/html/i.test(ct)) return { text: resp.body, lang: 'html' };
  if (/xml/i.test(ct)) return { text: resp.body, lang: 'xml' };
  return { text: resp.body, lang: 'plaintext' };
}

function renderResponse(host: HTMLElement): () => void {
  const root = h('div.http-resp');
  host.append(root);
  let tab: 'body' | 'headers' = 'body';

  async function paint(): Promise<void> {
    const s = shown;
    if (!s) { root.replaceChildren(h('div.pad.dim', null, 'Ответ появится здесь после «▶ Отправить запрос» в файле .http')); return; }
    if (s.pending) { root.replaceChildren(h('div.pad', null, `${s.title}: отправляю…`)); return; }
    if (s.error || !s.resp) { root.replaceChildren(h('div.pad', null, h('b', null, s.title), h('pre.http-err', null, s.error ?? 'нет ответа'))); return; }
    const r = s.resp;
    const body = h('div.http-body');
    if (tab === 'headers') {
      body.append(h('table.http-headers', null, ...r.headers.map(([k, v]) => h('tr', null, h('td.k', null, k), h('td', null, v)))));
    } else {
      const { text, lang } = pretty(r);
      const pre = h('pre.http-text', null, text);
      body.append(pre);
      if (lang !== 'plaintext' && text.length < 200_000) { try { pre.innerHTML = await monaco().editor.colorize(text, lang, { tabSize: 2 }); } catch { /* keep plain text */ } }
      if (r.truncated) body.prepend(h('div.dim.small.pad', null, 'Ответ обрезан: показаны первые 5 МБ'));
    }
    root.replaceChildren(
      h('div.http-line', null,
        h('span', { class: `http-status ${statusClass(r.status)}` }, `${r.status} ${r.reason}`),
        h('span.dim', null, `${r.time_ms} мс`), h('span.dim', null, size(r.size)), h('span.dim', null, s.title)),
      h('div.dbv-bar', null,
        h('button', { class: `btn ${tab === 'body' ? 'primary' : ''}`, onclick: () => { tab = 'body'; void paint(); } }, 'Тело'),
        h('button', { class: `btn ${tab === 'headers' ? 'primary' : ''}`, onclick: () => { tab = 'headers'; void paint(); } }, `Заголовки (${r.headers.length})`),
        h('button.btn', { onclick: () => void navigator.clipboard.writeText(r.body) }, 'Копировать тело')),
      body);
  }

  void paint();
  const sub = changed.on(() => void paint());
  return () => sub.dispose();
}

async function send(uri: string, line: number): Promise<void> {
  const model = monaco().editor.getModels().find((m) => m.uri.toString() === uri);
  if (!model) return;
  const { requests, vars } = parseHttpFile(model.getValue());
  const req = requestAt(requests, line);
  if (!req) { notify('Под курсором нет запроса', { kind: 'warn' }); return; }
  const url = applyVars(req.url, vars);
  const title = `${req.method} ${url}`;
  shown = { title, sentAt: new Date(), pending: true };
  editors.openViewBeside({ key: 'http-response', title: 'Ответ HTTP', icon: 'globe', render: renderResponse });
  changed.fire();
  try {
    const resp = await ipc.httpSend({ method: req.method, url, headers: req.headers.map(([k, v]) => [k, applyVars(v, vars)] as [string, string]), body: req.body ? applyVars(req.body, vars) : undefined });
    shown = { title, sentAt: new Date(), resp };
  } catch (e) { shown = { title, sentAt: new Date(), error: errText(e) }; }
  changed.fire();
}

export function registerHttpClient(): void {
  const mo = monaco();
  mo.languages.register({ id: 'http', extensions: ['.http', '.rest'], aliases: ['HTTP', 'REST Client'] });
  mo.languages.setMonarchTokensProvider('http', {
    tokenizer: {
      root: [
        [/^###.*$/, 'comment.doc'],
        [/^\s*(#|\/\/).*$/, 'comment'],
        [/^\s*@[\w.-]+/, 'variable.predefined'],
        [/^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\b/, 'keyword'],
        [/\{\{[^}]*\}\}/, 'variable'],
        [/^[\w-]+(?=:)/, 'attribute.name'],
        [/https?:\/\/\S+/, 'string.link'],
      ],
    },
  } as M.languages.IMonarchLanguage);
  mo.editor.registerCommand(SEND_CMD, (_acc, uri: string, line: number) => { void send(uri, line); });
  mo.languages.registerCodeLensProvider('http', {
    provideCodeLenses(model) {
      const { requests } = parseHttpFile(model.getValue());
      return {
        lenses: requests.map((r) => ({
          range: { startLineNumber: r.line, startColumn: 1, endLineNumber: r.line, endColumn: 1 },
          command: { id: SEND_CMD, title: '▶ Отправить запрос', arguments: [model.uri.toString(), r.line] },
        })),
        dispose() {},
      };
    },
  });
  commands.register({
    id: 'http.send', title: 'HTTP: отправить запрос под курсором', category: 'Запуск', keybinding: 'ctrl+alt+r',
    when: () => editors.activeDoc()?.model.getLanguageId() === 'http',
    run: () => {
      const { editor, doc } = editors.active();
      if (!editor || !doc || doc.model.getLanguageId() !== 'http') { notify('Откройте файл .http или .rest', { kind: 'warn' }); return; }
      void send(doc.model.uri.toString(), editor.getPosition()?.lineNumber ?? 1);
    },
  });
}
