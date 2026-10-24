import { app } from './app';
import { commands } from './commands';
import { stopMcp, type McpServerCfg } from './ai/mcp';
import { cfg, settings } from './settings';
import { confirmDialog, inputBox, notify, quickPick, type PickItem } from './ui';

interface Preset {
  id: string;
  label: string;
  detail: string;
  /** Asks for one value (path, connection string…) that ends up in the arguments. */
  ask?: { title: string; placeholder: string; value?: () => string };
  build(v: string): McpServerCfg;
}

const npx = (name: string, ...rest: string[]) => ({ command: 'npx', args: ['-y', name, ...rest] });

const PRESETS: Preset[] = [
  { id: 'sqlite', label: 'SQLite', detail: 'Запросы к файлу базы данных SQLite (uvx mcp-server-sqlite)', ask: { title: 'Путь к файлу .db', placeholder: 'C:\\data\\app.db' },
    build: (v) => ({ name: 'sqlite', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', v] }) },
  { id: 'postgres', label: 'PostgreSQL', detail: 'Чтение схемы и запросы (только чтение): @modelcontextprotocol/server-postgres', ask: { title: 'Строка подключения', placeholder: 'postgresql://user:pass@localhost:5432/db' },
    build: (v) => ({ name: 'postgres', ...npx('@modelcontextprotocol/server-postgres', v) }) },
  { id: 'filesystem', label: 'Файловая система', detail: 'Доступ к выбранной папке: @modelcontextprotocol/server-filesystem', ask: { title: 'Папка', placeholder: 'C:\\projects', value: () => app.root ?? '' },
    build: (v) => ({ name: 'fs', ...npx('@modelcontextprotocol/server-filesystem', v) }) },
  { id: 'memory', label: 'Граф знаний (память)', detail: 'Локальный граф знаний между сеансами: @modelcontextprotocol/server-memory',
    build: () => ({ name: 'memory', ...npx('@modelcontextprotocol/server-memory') }) },
  { id: 'fetch', label: 'Веб-страницы (fetch)', detail: 'Загрузка страниц и документации (uvx mcp-server-fetch)',
    build: () => ({ name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'] }) },
  { id: 'context7', label: 'Документация библиотек (Context7)', detail: 'Актуальная документация пакетов: @upstash/context7-mcp',
    build: () => ({ name: 'context7', ...npx('@upstash/context7-mcp') }) },
  { id: 'claude-code', label: 'Claude Code (как инструмент)', detail: 'Инструменты Claude Code для агента: `claude mcp serve` (нужен вход в Claude Code)',
    build: () => ({ name: 'claude-code', command: 'claude', args: ['mcp', 'serve'] }) },
  { id: 'playwright', label: 'Браузер (Playwright)', detail: 'Управление браузером: @playwright/mcp',
    build: () => ({ name: 'browser', ...npx('@playwright/mcp@latest') }) },
];

const current = (): McpServerCfg[] => cfg<McpServerCfg[]>('ai.mcpServers') ?? [];

async function add(): Promise<void> {
  const items: PickItem<Preset>[] = PRESETS.map((p) => ({ label: p.label, detail: p.detail, value: p }));
  const hit = await quickPick(items, { placeholder: 'MCP: какой инструмент подключить к ИИ-агенту?' });
  if (!hit) return;
  const p = hit.value;
  let v = '';
  if (p.ask) {
    const got = await inputBox({ title: p.ask.title, placeholder: p.ask.placeholder, value: p.ask.value?.() ?? '', validate: (x) => (x.trim() ? null : 'Нужно значение') });
    if (got === undefined) return;
    v = got.trim();
  }
  const server = p.build(v);
  const line = [server.command, ...(server.args ?? [])].join(' ');
  if (!(await confirmDialog('Подключить MCP-сервер', `Сервер запускается как программа на вашем ПК:\n${line}\n\nВызовы его инструментов агент будет подтверждать как команды. Нужны Node.js (npx) или uv (uvx).`, 'Подключить'))) return;
  const list = current().filter((s) => s.name !== server.name);
  settings.set('ai.mcpServers', [...list, server]);
  await stopMcp();
  notify(`MCP «${server.name}» подключён — инструменты появятся у агента со следующего сообщения`);
}

export function registerMcpCatalog(): void {
  commands.register({ id: 'mcp.add', title: 'MCP: подключить инструмент к ИИ-агенту (БД, документация, браузер…)', category: 'ИИ', run: () => add() });
  commands.register({
    id: 'mcp.remove', title: 'MCP: отключить сервер', category: 'ИИ',
    run: async () => {
      const list = current();
      if (!list.length) { notify('MCP-серверы не подключены'); return; }
      const hit = await quickPick(list.map((s) => ({ label: s.name, detail: [s.command, ...(s.args ?? [])].join(' '), value: s.name })), { placeholder: 'Какой сервер отключить?' });
      if (!hit) return;
      settings.set('ai.mcpServers', list.filter((s) => s.name !== hit.value));
      await stopMcp();
      notify(`MCP «${hit.value}» отключён`);
    },
  });
  commands.register({ id: 'mcp.restart', title: 'MCP: перезапустить серверы', category: 'ИИ', run: async () => { await stopMcp(); notify('MCP-серверы будут запущены заново со следующего сообщения'); } });
}
