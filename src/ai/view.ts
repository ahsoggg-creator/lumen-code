import { app, monaco } from '../app';
import { commands } from '../commands';
import { editors } from '../editor';
import { icon } from '../icons';
import { errText, ipc } from '../ipc';
import { renderMarkdown } from '../md';
import { runInTerminal, newTerminal } from '../panels';
import { settings, cfg } from '../settings';
import { shell } from '../shell';
import { confirmDialog, notify } from '../ui';
import { h, uid } from '../util';
import { PRESETS, AbortHandle, activeProvider, agentsChanged, apiKey, keyName, listModels, pluginAgents, providers, saveProviders, streamChat, type Msg, type Provider } from './core';
import { registerInlineEdit } from './inline';
import { Checkpoint, TOOLS, dangerOf, recordTo, needsApproval, previewTool, runTool } from './tools';

const TERMINAL_AGENTS = [
  { name: 'Claude Code', command: 'claude', probe: 'claude' },
  { name: 'Codex CLI', command: 'codex', probe: 'codex' },
  { name: 'Gemini CLI', command: 'gemini', probe: 'gemini' },
  { name: 'Aider', command: 'aider', probe: 'aider' },
  { name: 'OpenCode', command: 'opencode', probe: 'opencode' },
  { name: 'Qwen Code', command: 'qwen', probe: 'qwen' },
];

const SLASH: Record<string, string> = {
  '/explain': 'Объясни, что делает этот код, простыми словами и по шагам.',
  '/fix': 'Найди ошибки в этом коде и предложи исправленный вариант.',
  '/tests': 'Напиши тесты для этого кода.',
  '/docs': 'Добавь понятную документацию/комментарии к этому коду.',
  '/refactor': 'Предложи рефакторинг: упрости и улучши читаемость, не меняя поведение.',
  '/optimize': 'Предложи оптимизации производительности этого кода.',
};

interface Ctx { file: boolean; selection: boolean }
let askExternal: (prompt: string, opts?: { selection?: boolean; file?: boolean; send?: boolean }) => void = () => undefined;
export const askAI = (prompt: string, opts?: { selection?: boolean; file?: boolean; send?: boolean }): void => askExternal(prompt, opts);

/** Project rules the user keeps in the workspace; read on every request so edits apply immediately. */
async function projectRules(): Promise<string> {
  if (!app.root) return '';
  for (const rel of ['AGENTS.md', '.lumen\\rules.md']) {
    try {
      const f = await ipc.readFile(`${app.root}\\${rel}`);
      if (!f.binary && f.content.trim()) return `Project rules (${rel}), follow them:\n${f.content.length > 20000 ? f.content.slice(0, 20000) + '\n… [truncated]' : f.content}`;
    } catch { /* file absent */ }
  }
  return '';
}

function systemPrompt(agent: boolean, rules = ''): string {
  const ed = editors.active();
  const parts = [
    'You are Lumen, an expert AI coding assistant built into the Lumen Code editor. Be precise and concise. Reply in the same language as the user (usually Russian). Put code in fenced blocks with a language tag.',
    `Environment: Windows. Workspace: ${app.root ?? '(no folder open)'}.`,
    ed.doc?.path ? `Active file: ${ed.doc.path} (${ed.doc.model.getLanguageId()}).` : '',
    cfg<string>('python.interpreter') ? `Selected Python: ${cfg<string>('python.interpreter')}.` : '',
    agent ? 'You can use tools to read, search, edit files and run commands in the workspace. Prefer small, exact edits (edit_file). Read a file before editing it. After finishing, summarize what you changed.' : 'No tools are available in this mode: answer from the provided context.',
    cfg<string>('ai.systemPrompt'),
    rules,
  ];
  return parts.filter(Boolean).join('\n');
}

function contextBlock(ctx: Ctx): string {
  const { doc, editor } = editors.active();
  if (!doc) return '';
  const out: string[] = [];
  const sel = editor?.getSelection();
  if (ctx.selection && sel && !sel.isEmpty()) out.push(`Selected code (${doc.name}, lines ${sel.startLineNumber}-${sel.endLineNumber}):\n\`\`\`${doc.model.getLanguageId()}\n${doc.model.getValueInRange(sel)}\n\`\`\``);
  else if (ctx.file) {
    const t = doc.model.getValue();
    out.push(`Current file ${doc.path ?? doc.name}:\n\`\`\`${doc.model.getLanguageId()}\n${t.length > 40000 ? t.slice(0, 40000) + '\n… [обрезано]' : t}\n\`\`\``);
  }
  return out.join('\n\n');
}

export function registerAI(): void {
  shell.registerView({
    id: 'ai', title: 'Чат с ИИ', icon: 'sparkles', location: 'secondary',
    create(host, api) {
      const root = h('div.ai-view');
      host.append(root);
      const history: Msg[] = [];
      let busy = false;
      let abort: AbortHandle | null = null;
      let mode: 'agent' | 'chat' = 'agent';
      const ctx: Ctx = { file: true, selection: true };
      let showSettings = false;
      let agentId = '';
      let detected: typeof TERMINAL_AGENTS = [];

      const list = h('div.ai-messages');
      const input = h('textarea.ai-input', { placeholder: 'Спросите что угодно о коде…  (/ — команды, Enter — отправить)', rows: 2, spellcheck: false });
      const sendBtn = h('button.btn.primary.ai-send', { title: 'Отправить', innerHTML: icon('send', 16), onclick: () => void send() });
      const chips = h('div.ai-chips');
      const bar = h('div.ai-bar');
      const settingsEl = h('div.ai-settings');
      const termAgents = h('div.ai-term-agents');

      function renderBar(): void {
        const p = activeProvider();
        const ps = providers();
        const sel = h('select.field.small', { title: 'Провайдер', onchange: (e: Event) => { settings.set('ai.activeProvider', (e.target as HTMLSelectElement).value); renderBar(); } },
          ...ps.map((x) => h('option', { value: x.id, selected: p?.id === x.id }, x.name)), ps.length ? null : h('option', null, 'нет провайдеров'));
        const modeSel = h('select.field.small', { title: 'Режим', onchange: (e: Event) => { mode = (e.target as HTMLSelectElement).value as typeof mode; } },
          h('option', { value: 'agent', selected: mode === 'agent' }, 'Агент (инструменты)'), h('option', { value: 'chat', selected: mode === 'chat' }, 'Чат'));
        const plugAgents = [...pluginAgents.values()];
        const agentSel = plugAgents.length ? h('select.field.small', { title: 'Агент', onchange: (e: Event) => { agentId = (e.target as HTMLSelectElement).value; } }, h('option', { value: '' }, 'Встроенный'), ...plugAgents.map((a) => h('option', { value: a.id, selected: agentId === a.id, title: a.description ?? '' }, a.name))) : null;
        bar.replaceChildren(...[sel, h('span.dim.small.model', { title: 'Модель' }, p?.model ?? ''), modeSel, agentSel].filter((x): x is HTMLElement => !!x));
      }

      function renderChips(): void {
        const d = editors.activeDoc();
        const hasSel = !!editors.activeEditor()?.getSelection() && !editors.activeEditor()!.getSelection()!.isEmpty();
        chips.replaceChildren(
          h('button', { class: `chip ${ctx.file ? 'on' : ''}`, title: 'Передавать текущий файл в запрос', onclick: () => { ctx.file = !ctx.file; renderChips(); } }, h('span', { innerHTML: icon('fileText', 12) }), d ? d.name : 'нет файла'),
          h('button', { class: `chip ${ctx.selection ? 'on' : ''}`, title: 'Если есть выделение — отправлять только его', onclick: () => { ctx.selection = !ctx.selection; renderChips(); } }, h('span', { innerHTML: icon('edit', 12) }), hasSel ? 'выделение' : 'выделения нет'));
      }

      function scrollEnd(): void { list.scrollTop = list.scrollHeight; }

      async function enhance(el: HTMLElement): Promise<void> {
        const mo = monaco();
        for (const pre of el.querySelectorAll<HTMLElement>('pre[data-lang]')) {
          const code = pre.textContent ?? '';
          const lang = pre.dataset.lang || 'plaintext';
          const tools = h('div.code-tools', null,
            h('button.icon-btn', { title: 'Копировать', innerHTML: icon('copy', 13), onclick: () => void navigator.clipboard.writeText(code) }),
            h('button.icon-btn', { title: 'Вставить в курсор', innerHTML: icon('arrowDown', 13), onclick: () => { const e = editors.activeEditor(); if (e) e.executeEdits('ai', [{ range: e.getSelection()!, text: code, forceMoveMarkers: true }]); else notify('Нет открытого редактора', { kind: 'warn' }); } }),
            h('button.icon-btn', { title: 'Заменить выделение / весь файл', innerHTML: icon('check', 13), onclick: () => { const { editor, doc } = editors.active(); if (!editor || !doc) return; const s = editor.getSelection(); editor.executeEdits('ai', [{ range: s && !s.isEmpty() ? s : doc.model.getFullModelRange(), text: code }]); } }),
            h('button.icon-btn', { title: 'Открыть в новой вкладке', innerHTML: icon('filePlus', 13), onclick: () => editors.newUntitled(code, lang) }));
          pre.append(tools);
          try { pre.querySelector('code')!.innerHTML = await mo.editor.colorize(code, lang, { tabSize: 4 }); } catch { /* unknown language */ }
        }
        el.querySelectorAll<HTMLAnchorElement>('a[data-ext]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); void ipc.openUrl(a.href); }));
      }

      function userBubble(text: string): void {
        list.append(h('div.msg.user', null, h('div.msg-body', null, text)));
        scrollEnd();
      }

      function assistantBubble(): { el: HTMLElement; set(text: string): void; done(): void } {
        const body = h('div.msg-body.md');
        const el = h('div.msg.assistant', null, body);
        list.append(el);
        let raf = 0;
        let latest = '';
        return {
          el: body,
          set(text) { latest = text; if (!raf) raf = requestAnimationFrame(() => { raf = 0; body.innerHTML = renderMarkdown(latest); scrollEnd(); }); },
          done() { body.innerHTML = renderMarkdown(latest); void enhance(body); },
        };
      }

      function toolCard(name: string, args: Record<string, unknown>): { setResult(r: string, ok: boolean): void; approval(): Promise<boolean> } {
        const summary = name === 'run_command' ? String(args.command) : String(args.path ?? args.query ?? '');
        const status = h('span.tool-status', null, '…');
        const body = h('div.tool-body');
        const head = h('div.tool-head', { onclick: () => body.classList.toggle('open') }, h('span', { innerHTML: icon(dangerOf(name) === 'run' ? 'terminal' : dangerOf(name) === 'edit' ? 'edit' : 'search', 13) }), h('b', null, name), h('span.tool-sum', null, summary.slice(0, 80)), status);
        const card = h('div.msg.tool', null, head, body);
        list.append(card);
        scrollEnd();
        return {
          setResult(r, ok) { status.textContent = ok ? '✓' : '✗'; status.className = `tool-status ${ok ? 'ok' : 'bad'}`; body.replaceChildren(h('pre', null, r.slice(0, 4000))); },
          async approval() {
            const pv = await previewTool(name, args);
            return new Promise<boolean>((resolve) => {
              status.textContent = 'ждёт подтверждения';
              body.classList.add('open');
              const diff = h('div.diff-prev', null, ...pv.lines.map((l) => h('div', { class: `dl ${l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : ''}` }, `${l.kind} ${l.text}`)));
              const act = h('div.tool-actions', null,
                h('button.btn.primary', { onclick: () => { act.remove(); resolve(true); } }, 'Разрешить'),
                h('button.btn', { onclick: () => { act.remove(); resolve(false); } }, 'Отклонить'),
                name === 'edit_file' || name === 'write_file' ? h('button.btn', { onclick: () => void editors.openFile(String(args.path)).catch(() => undefined) }, 'Открыть файл') : null);
              body.replaceChildren(h('div.dim.small', null, pv.title + (pv.note ? ` · ${pv.note}` : '')), diff, act);
              scrollEnd();
            });
          },
        };
      }

      function undoBar(cp: Checkpoint): void {
        const n = cp.size;
        const btn = h('button.btn', { onclick: async () => {
          if (!(await confirmDialog('Откатить изменения', `Вернуть ${n} файл(ов) к состоянию до этого запроса?`, 'Откатить', true))) return;
          const done = await cp.restore();
          bar2.replaceChildren(h('span.dim.small', null, `Откат выполнен: ${done} из ${n}`));
        } }, `Откатить изменения этого запроса (файлов: ${n})`);
        const bar2 = h('div.msg.tool.undo', null, btn);
        list.append(bar2);
        scrollEnd();
      }

      function setBusy(b: boolean): void {
        busy = b;
        sendBtn.innerHTML = icon(b ? 'stop' : 'send', 16);
        sendBtn.title = b ? 'Остановить' : 'Отправить';
        sendBtn.classList.toggle('danger', b);
        input.disabled = false;
      }

      async function send(textOverride?: string): Promise<void> {
        if (busy) { abort?.abort(); return; }
        let text = (textOverride ?? input.value).trim();
        if (!text) return;
        const slash = Object.keys(SLASH).find((s) => text === s || text.startsWith(`${s} `));
        if (text === '/clear') { history.length = 0; list.replaceChildren(); input.value = ''; return; }
        if (slash) text = `${SLASH[slash]}${text.slice(slash.length)}`;
        input.value = '';
        const p = activeProvider();
        const pa = agentId ? pluginAgents.get(agentId) : null;
        if (!p && !pa) { showSettings = true; paint(); notify('Сначала добавьте ИИ-провайдера', { kind: 'warn' }); return; }
        const context = contextBlock(ctx);
        const full = context ? `${text}\n\n${context}` : text;
        userBubble(text);
        setBusy(true);
        abort = new AbortHandle();
        try {
          if (pa) {
            const bubble = assistantBubble();
            let acc = '';
            const ed = editors.active();
            const r = await pa.run({ prompt: text, file: ed.doc ? { path: ed.doc.path, text: ed.doc.model.getValue(), language: ed.doc.model.getLanguageId() } : null, selection: ed.editor?.getSelection() && !ed.editor.getSelection()!.isEmpty() ? ed.doc!.model.getValueInRange(ed.editor.getSelection()!) : '', workspace: app.root, emit: (t) => { acc += t; bubble.set(acc); }, signal: abort });
            if (typeof r === 'string') { acc += r; bubble.set(acc); }
            bubble.done();
          } else {
            history.push({ role: 'user', text: full });
            const cp = new Checkpoint();
            recordTo(cp);
            try { await agentLoop(p!); } finally { recordTo(null); if (cp.size) undoBar(cp); }
          }
        } catch (e) {
          list.append(h('div.msg.error', null, errText(e)));
          scrollEnd();
        } finally {
          setBusy(false);
          abort = null;
        }
      }

      async function agentLoop(p: Provider): Promise<void> {
        const agent = mode === 'agent' && !!app.root;
        const max = cfg<number>('ai.maxSteps');
        for (let step = 0; step < max; step++) {
          const bubble = assistantBubble();
          let acc = '';
          const res = await streamChat(p, systemPrompt(agent, await projectRules()), history, agent ? TOOLS : [], { onText: (t) => { acc += t; bubble.set(acc); } }, abort!);
          if (acc) bubble.done(); else bubble.el.parentElement?.remove();
          history.push({ role: 'assistant', text: res.text, calls: res.calls });
          if (!res.calls.length || abort!.aborted) break;
          for (const call of res.calls) {
            const card = toolCard(call.name, call.args);
            let result: string;
            if (abort!.aborted) { result = 'Прервано пользователем'; }
            else if (needsApproval(call.name) && !(await card.approval())) result = 'Пользователь отклонил это действие.';
            else result = await runTool(call.name, call.args);
            card.setResult(result, !result.startsWith('Ошибка') && !result.startsWith('Пользователь'));
            history.push({ role: 'tool', callId: call.id, name: call.name, result });
          }
          if (step === max - 1) list.append(h('div.msg.error', null, `Достигнут лимит шагов агента (${max}). Напишите «продолжай», чтобы идти дальше.`));
        }
      }

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
        e.stopPropagation();
      });
      input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(220, input.scrollHeight)}px`; });

      // ---------------------------------------------------------- settings panel
      function providerForm(p: Provider): HTMLElement {
        const field = (label: string, el: HTMLElement) => h('label.form-row', null, h('span.dim.small', null, label), el);
        const name = h('input.field', { value: p.name, oninput: () => { p.name = name.value; } });
        const url = h('input.field', { value: p.baseUrl, spellcheck: false, oninput: () => { p.baseUrl = url.value; } });
        const model = h('input.field', { value: p.model, spellcheck: false, list: `models-${p.id}`, oninput: () => { p.model = model.value; } });
        const dl = h('datalist', { id: `models-${p.id}` });
        const kind = h('select.field', { onchange: () => { p.kind = kind.value as Provider['kind']; } }, h('option', { value: 'openai', selected: p.kind === 'openai' }, 'OpenAI-совместимый'), h('option', { value: 'anthropic', selected: p.kind === 'anthropic' }, 'Anthropic'));
        const key = h('input.field', { type: 'password', placeholder: 'API-ключ (хранится в хранилище учётных данных Windows)', spellcheck: false });
        void apiKey(p).then((k) => { if (k) key.placeholder = '•••••••• (сохранён) — введите новый, чтобы заменить'; });
        const status = h('div.dim.small');
        return h('div.provider-card', null,
          field('Название', name), field('Тип API', kind), field('Адрес', url),
          field('Модель', h('div.row', null, model, dl, h('button.btn', { title: 'Загрузить список моделей', onclick: async () => { try { const ms = await listModels(p); dl.replaceChildren(...ms.map((m) => h('option', { value: m }))); status.textContent = `Моделей: ${ms.length}`; } catch (e) { status.textContent = `Не удалось: ${errText(e)}`; } } }, 'Список'))),
          field('Ключ', key),
          status,
          h('div.btn-row', null,
            h('button.btn.primary', { onclick: async () => { const all = providers().map((x) => (x.id === p.id ? p : x)); saveProviders(all); if (key.value) { await ipc.secretSet(keyName(p), key.value); key.value = ''; } settings.set('ai.activeProvider', p.id); status.textContent = 'Сохранено ✓'; renderBar(); } }, 'Сохранить и выбрать'),
            h('button.btn', { onclick: async () => { status.textContent = 'Проверяю…'; try { if (key.value) await ipc.secretSet(keyName(p), key.value); const r = await streamChat(p, '', [{ role: 'user', text: 'Reply with the single word: pong' }], [], {}, new AbortHandle()); status.textContent = `Ответ: ${r.text.trim().slice(0, 60) || '(пусто)'} ✓`; } catch (e) { status.textContent = errText(e); } } }, 'Проверить'),
            h('button.btn.danger', { onclick: async () => { if (!(await confirmDialog('Удалить провайдера', `Удалить «${p.name}»?`, 'Удалить', true))) return; saveProviders(providers().filter((x) => x.id !== p.id)); await ipc.secretDelete(keyName(p)); paint(); } }, 'Удалить')));
      }

      function paintSettings(): void {
        const forms = providers().map((p) => providerForm({ ...p }));
        settingsEl.replaceChildren(
          h('div.dim.small.pad', null, 'Подключите любого провайдера: облачного или локального (Ollama, LM Studio). Ключи не попадают в файлы настроек.'),
          ...forms,
          h('div.sec-title.pad', null, 'Добавить провайдера'),
          h('div.chips', null, PRESETS.map((pr) => h('button.chip', { onclick: () => { const p: Provider = { id: uid('p'), name: pr.name, kind: pr.kind, baseUrl: pr.baseUrl, model: pr.model, needsKey: pr.needsKey }; saveProviders([...providers(), p]); settings.set('ai.activeProvider', p.id); paint(); } }, `+ ${pr.name}`))),
          h('div.sec-title.pad', null, 'Права агента'),
          ...(['ai.autoApproveReads', 'ai.autoApproveEdits', 'ai.autoApproveCommands'] as const).map((k) => h('label.check', null, h('input', { type: 'checkbox', checked: cfg<boolean>(k), onchange: (e: Event) => settings.set(k, (e.target as HTMLInputElement).checked) }), k === 'ai.autoApproveReads' ? 'Читать файлы без вопросов' : k === 'ai.autoApproveEdits' ? 'Править файлы без подтверждения' : 'Запускать команды без подтверждения')));
      }

      async function detectAgents(): Promise<void> {
        const found: typeof TERMINAL_AGENTS = [];
        await Promise.all(TERMINAL_AGENTS.map(async (a) => { const r = await ipc.exec('where', [a.probe], undefined, 4000).catch(() => null); if (r?.code === 0) found.push(a); }));
        detected = TERMINAL_AGENTS.filter((a) => found.includes(a));
        const custom = cfg<{ name: string; command: string }[]>('ai.terminalAgents') ?? [];
        termAgents.replaceChildren(...[...detected, ...custom.map((c) => ({ ...c, probe: c.command }))].map((a) => h('button.chip', { title: `Запустить «${a.command}» в терминале`, onclick: () => void launchTerminalAgent(a.command, a.name) }, h('span', { innerHTML: icon('terminal', 12) }), a.name)));
        termAgents.style.display = termAgents.childElementCount ? '' : 'none';
      }

      async function launchTerminalAgent(command: string, name: string): Promise<void> {
        await newTerminal({ name, cwd: app.root ?? undefined });
        await new Promise((r) => setTimeout(r, 400));
        await runInTerminal(command, { name, reuse: true, cwd: undefined });
      }

      function paint(): void {
        settingsEl.style.display = showSettings ? '' : 'none';
        list.style.display = showSettings ? 'none' : '';
        if (showSettings) paintSettings();
        renderBar();
        renderChips();
      }

      const empty = (): HTMLElement => h('div.ai-empty', null,
        h('div.ai-logo', { innerHTML: icon('sparkles', 32) }),
        h('div', null, h('b', null, 'Чат с ИИ')),
        h('div.dim.small', null, 'Агент читает проект, правит файлы и запускает команды — каждое действие подтверждается вами.'),
        providers().length ? null : h('button.btn.primary', { onclick: () => { showSettings = true; paint(); } }, 'Подключить провайдера'),
        h('div.chips', null, Object.keys(SLASH).map((s) => h('button.chip', { onclick: () => { input.value = `${s} `; input.focus(); } }, s))));
      list.append(empty());
      const origAppend = list.append.bind(list);
      list.append = ((...nodes: (Node | string)[]) => { list.querySelector('.ai-empty')?.remove(); origAppend(...nodes); }) as typeof list.append;

      root.append(bar, settingsEl, list, termAgents, h('div.ai-compose', null, chips, h('div.ai-input-row', null, input, sendBtn)));
      api.setActions([
        h('button.icon-btn', { title: 'Новый чат', innerHTML: icon('plus', 15), onclick: () => { history.length = 0; list.replaceChildren(empty()); } }),
        h('button.icon-btn', { title: 'Настройки ИИ', innerHTML: icon('sliders', 15), onclick: () => { showSettings = !showSettings; paint(); } }),
      ]);
      settings.changed.on((k) => { if (k.some((x) => x.startsWith('ai.'))) { renderBar(); } });
      editors.activeChanged.on(() => renderChips());
      editors.cursorMoved.on(() => renderChips());
      agentsChanged.on(() => renderBar());
      paint();
      void detectAgents();

      askExternal = (prompt, o = {}) => {
        shell.showView('ai');
        if (o.selection === false) ctx.selection = false;
        input.value = prompt;
        input.focus();
        if (o.send !== false) void send();
      };
    },
  });

  registerInlineEdit();
  commands.register({ id: 'ai.toggleChat', title: 'ИИ: показать/скрыть чат', category: 'ИИ', keybinding: 'ctrl+alt+i', run: () => shell.toggleView('ai') });
  commands.register({ id: 'ai.focus', title: 'ИИ: фокус на поле ввода', category: 'ИИ', run: () => shell.showView('ai') });
  commands.register({ id: 'ai.settings', title: 'ИИ: настроить провайдеров', category: 'ИИ', run: () => { shell.showView('ai'); document.querySelector<HTMLElement>('.sidebar.secondary .side-actions button:last-child')?.click(); } });
  const quick = (id: string, title: string, prompt: string) => commands.register({ id: `ai.${id}`, title: `ИИ: ${title}`, category: 'ИИ', run: () => askAI(prompt, { selection: true }) });
  quick('explain', 'объяснить код', SLASH['/explain']!);
  quick('fix', 'исправить код', SLASH['/fix']!);
  quick('tests', 'написать тесты', SLASH['/tests']!);
  quick('docs', 'добавить документацию', SLASH['/docs']!);
  quick('refactor', 'рефакторинг', SLASH['/refactor']!);

  // Terminal AI agents also available from the palette.
  for (const a of TERMINAL_AGENTS) {
    commands.register({ id: `ai.cli.${a.probe}`, title: `ИИ: запустить ${a.name} в терминале`, category: 'ИИ', run: async () => { await newTerminal({ name: a.name, cwd: app.root ?? undefined }); await new Promise((r) => setTimeout(r, 400)); await runInTerminal(a.command, { name: a.name }); } });
  }
}

/** Adds "AI" actions to the Monaco context menu once an editor exists. */
export function installEditorActions(ed: import('monaco-editor').editor.IStandaloneCodeEditor): void {
  const add = (id: string, label: string, prompt: string, order: number) => ed.addAction({ id: `lumen.ai.${id}`, label: `ИИ: ${label}`, contextMenuGroupId: '9_ai', contextMenuOrder: order, precondition: undefined, run: () => askAI(prompt, { selection: true }) });
  add('explain', 'объяснить', SLASH['/explain']!, 1);
  add('fix', 'исправить', SLASH['/fix']!, 2);
  add('tests', 'написать тесты', SLASH['/tests']!, 3);
  add('refactor', 'рефакторинг', SLASH['/refactor']!, 4);
}
