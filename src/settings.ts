import { ipc } from './ipc';
import { Emitter, debounce, join, parseJsonc } from './util';

export type SettingType = 'boolean' | 'number' | 'string' | 'enum' | 'color' | 'array' | 'object' | 'font';
export interface SettingDef {
  key: string;
  type: SettingType;
  default: unknown;
  group: string;
  label: string;
  desc?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
}

const opt = (...vals: string[]) => vals.map((v) => ({ value: v, label: v }));

const FONT_MONO = "'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace";
const FONT_UI = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";

export const SCHEMA: SettingDef[] = [
  { key: 'workbench.theme', type: 'enum', default: 'catppuccin-mocha', group: 'Внешний вид', label: 'Тема', desc: 'Цветовая тема интерфейса и редактора.' },
  { key: 'workbench.accent', type: 'color', default: 'mauve', group: 'Внешний вид', label: 'Акцентный цвет', desc: 'Имя цвета палитры (mauve, blue, teal…) или #hex.' },
  { key: 'workbench.uiScale', type: 'number', default: 1, group: 'Внешний вид', label: 'Масштаб интерфейса', min: 0.7, max: 1.8, step: 0.05 },
  { key: 'workbench.uiFont', type: 'font', default: FONT_UI, group: 'Внешний вид', label: 'Шрифт интерфейса' },
  { key: 'workbench.uiFontSize', type: 'number', default: 13, group: 'Внешний вид', label: 'Размер шрифта интерфейса', min: 10, max: 20 },
  { key: 'workbench.borderRadius', type: 'number', default: 8, group: 'Внешний вид', label: 'Скругление углов', min: 0, max: 16 },
  { key: 'workbench.animations', type: 'boolean', default: true, group: 'Внешний вид', label: 'Анимации интерфейса' },
  { key: 'workbench.sidebarPosition', type: 'enum', default: 'left', group: 'Внешний вид', label: 'Боковая панель', options: opt('left', 'right') },
  { key: 'workbench.activityBar', type: 'boolean', default: true, group: 'Внешний вид', label: 'Панель действий (значки слева)' },
  { key: 'workbench.statusBar', type: 'boolean', default: true, group: 'Внешний вид', label: 'Строка состояния' },
  { key: 'workbench.breadcrumbs', type: 'boolean', default: true, group: 'Внешний вид', label: 'Навигационная цепочка над редактором' },
  { key: 'workbench.colors', type: 'object', default: {}, group: 'Внешний вид', label: 'Свои цвета интерфейса', desc: 'Переопределение CSS-переменных, например {"--bg": "#101018", "--accent": "#ff6188"}.' },
  { key: 'workbench.editorColors', type: 'object', default: {}, group: 'Внешний вид', label: 'Свои цвета редактора', desc: 'Ключи темы Monaco, например {"editor.background": "#000000"}.' },

  { key: 'editor.fontFamily', type: 'font', default: FONT_MONO, group: 'Редактор', label: 'Шрифт' },
  { key: 'editor.fontSize', type: 'number', default: 14, group: 'Редактор', label: 'Размер шрифта', min: 8, max: 40 },
  { key: 'editor.fontLigatures', type: 'boolean', default: true, group: 'Редактор', label: 'Лигатуры' },
  { key: 'editor.lineHeight', type: 'number', default: 0, group: 'Редактор', label: 'Высота строки (0 — авто)', min: 0, max: 60 },
  { key: 'editor.letterSpacing', type: 'number', default: 0, group: 'Редактор', label: 'Межбуквенный интервал', min: -2, max: 5, step: 0.1 },
  { key: 'editor.tabSize', type: 'number', default: 4, group: 'Редактор', label: 'Ширина табуляции', min: 1, max: 12 },
  { key: 'editor.insertSpaces', type: 'boolean', default: true, group: 'Редактор', label: 'Пробелы вместо табуляции' },
  { key: 'editor.detectIndentation', type: 'boolean', default: true, group: 'Редактор', label: 'Определять отступы по файлу' },
  { key: 'editor.wordWrap', type: 'enum', default: 'off', group: 'Редактор', label: 'Перенос строк', options: opt('off', 'on', 'wordWrapColumn', 'bounded') },
  { key: 'editor.lineNumbers', type: 'enum', default: 'on', group: 'Редактор', label: 'Номера строк', options: opt('on', 'off', 'relative') },
  { key: 'editor.minimap', type: 'boolean', default: true, group: 'Редактор', label: 'Миникарта' },
  { key: 'editor.renderWhitespace', type: 'enum', default: 'selection', group: 'Редактор', label: 'Показывать пробелы', options: opt('none', 'boundary', 'selection', 'trailing', 'all') },
  { key: 'editor.renderLineHighlight', type: 'enum', default: 'all', group: 'Редактор', label: 'Подсветка текущей строки', options: opt('none', 'gutter', 'line', 'all') },
  { key: 'editor.rulers', type: 'array', default: [], group: 'Редактор', label: 'Вертикальные линейки', desc: 'Колонки, например [80, 120].' },
  { key: 'editor.cursorStyle', type: 'enum', default: 'line', group: 'Редактор', label: 'Стиль курсора', options: opt('line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin') },
  { key: 'editor.cursorBlinking', type: 'enum', default: 'smooth', group: 'Редактор', label: 'Мигание курсора', options: opt('blink', 'smooth', 'phase', 'expand', 'solid') },
  { key: 'editor.smoothCaret', type: 'boolean', default: true, group: 'Редактор', label: 'Плавное движение курсора' },
  { key: 'editor.smoothScrolling', type: 'boolean', default: true, group: 'Редактор', label: 'Плавная прокрутка' },
  { key: 'editor.bracketPairColorization', type: 'boolean', default: true, group: 'Редактор', label: 'Цветные парные скобки' },
  { key: 'editor.guides', type: 'boolean', default: true, group: 'Редактор', label: 'Направляющие отступов' },
  { key: 'editor.stickyScroll', type: 'boolean', default: true, group: 'Редактор', label: 'Закреплять заголовки областей' },
  { key: 'editor.folding', type: 'boolean', default: true, group: 'Редактор', label: 'Сворачивание кода' },
  { key: 'editor.mouseWheelZoom', type: 'boolean', default: true, group: 'Редактор', label: 'Масштаб Ctrl + колесо' },
  { key: 'editor.quickSuggestions', type: 'boolean', default: true, group: 'Редактор', label: 'Автодополнение при вводе' },
  { key: 'editor.linkedEditing', type: 'boolean', default: false, group: 'Редактор', label: 'Парное переименование тегов' },
  { key: 'editor.scrollBeyondLastLine', type: 'boolean', default: false, group: 'Редактор', label: 'Прокрутка ниже последней строки' },
  { key: 'editor.padding', type: 'number', default: 8, group: 'Редактор', label: 'Отступ сверху и снизу', min: 0, max: 40 },
  { key: 'editor.formatOnSave', type: 'boolean', default: false, group: 'Редактор', label: 'Форматировать при сохранении' },
  { key: 'editor.trimTrailingWhitespace', type: 'boolean', default: false, group: 'Редактор', label: 'Убирать пробелы в конце строк при сохранении' },
  { key: 'editor.insertFinalNewline', type: 'boolean', default: false, group: 'Редактор', label: 'Пустая строка в конце файла при сохранении' },
  { key: 'editor.semanticValidation', type: 'boolean', default: false, group: 'Редактор', label: 'Семантическая проверка JS/TS', desc: 'Выключено для скорости и чтобы не видеть ошибок импорта без node_modules.' },

  { key: 'files.autoSave', type: 'enum', default: 'off', group: 'Файлы', label: 'Автосохранение', options: opt('off', 'afterDelay', 'onFocusChange') },
  { key: 'files.autoSaveDelay', type: 'number', default: 1000, group: 'Файлы', label: 'Задержка автосохранения, мс', min: 200, max: 30000, step: 100 },
  { key: 'files.exclude', type: 'array', default: ['.git', '__pycache__', '.DS_Store', 'Thumbs.db'], group: 'Файлы', label: 'Скрывать в проводнике' },
  { key: 'files.restoreSession', type: 'boolean', default: true, group: 'Файлы', label: 'Восстанавливать открытые файлы' },
  { key: 'files.confirmDelete', type: 'boolean', default: true, group: 'Файлы', label: 'Подтверждать удаление' },
  { key: 'files.eol', type: 'enum', default: 'auto', group: 'Файлы', label: 'Конец строки для новых файлов', options: [{ value: 'auto', label: 'авто' }, { value: '\n', label: 'LF' }, { value: '\r\n', label: 'CRLF' }] },

  { key: 'terminal.shell', type: 'enum', default: 'powershell', group: 'Терминал', label: 'Оболочка', options: opt('powershell', 'pwsh', 'cmd', 'gitbash', 'wsl') },
  { key: 'terminal.customShell', type: 'string', default: '', group: 'Терминал', label: 'Свой путь к оболочке', desc: 'Если задан — используется вместо выбора выше.' },
  { key: 'terminal.fontSize', type: 'number', default: 13, group: 'Терминал', label: 'Размер шрифта', min: 8, max: 30 },
  { key: 'terminal.fontFamily', type: 'font', default: '', group: 'Терминал', label: 'Шрифт (пусто — как в редакторе)' },
  { key: 'terminal.cursorStyle', type: 'enum', default: 'bar', group: 'Терминал', label: 'Курсор', options: opt('block', 'underline', 'bar') },
  { key: 'terminal.scrollback', type: 'number', default: 4000, group: 'Терминал', label: 'История строк', min: 500, max: 50000, step: 500 },

  { key: 'python.interpreter', type: 'string', default: '', group: 'Python', label: 'Интерпретатор', desc: 'Путь к python.exe (обычно выбирается в панели Python).' },
  { key: 'python.activateInTerminal', type: 'boolean', default: true, group: 'Python', label: 'Подключать выбранный Python к терминалу' },

  { key: 'git.enabled', type: 'boolean', default: true, group: 'Git', label: 'Включить Git' },
  { key: 'git.gutter', type: 'boolean', default: true, group: 'Git', label: 'Цветные полоски изменений рядом со строками' },

  { key: 'lsp.enabled', type: 'boolean', default: true, group: 'Языки', label: 'Языковые серверы (LSP)', desc: 'Автодополнение, подсказки, переход к определению и проверка кода для Python, Rust, Go, C/C++, Lua.' },
  { key: 'lsp.servers', type: 'object', default: {}, group: 'Языки', label: 'Настройка языковых серверов', desc: 'По id встроенного сервера (python, rust, go, clangd, lua): {"python": {"command": "pyright-langserver", "args": ["--stdio"], "disabled": false, "settings": {}}}. Новый сервер: id с "languages" и "command".' },
  { key: 'lsp.dismissed', type: 'array', default: [], group: 'Языки', label: 'Серверы, которые не предлагать установить' },
  { key: 'ai.activeProvider', type: 'string', default: '', group: 'ИИ', label: 'Активный провайдер' },
  { key: 'ai.providers', type: 'array', default: [], group: 'ИИ', label: 'Провайдеры (ключи хранятся в хранилище Windows)' },
  { key: 'ai.systemPrompt', type: 'string', default: '', group: 'ИИ', label: 'Свои инструкции для ИИ' },
  { key: 'ai.temperature', type: 'number', default: 0.2, group: 'ИИ', label: 'Температура', min: 0, max: 2, step: 0.1 },
  { key: 'ai.maxTokens', type: 'number', default: 4096, group: 'ИИ', label: 'Максимум токенов ответа', min: 256, max: 64000, step: 256 },
  { key: 'ai.maxSteps', type: 'number', default: 12, group: 'ИИ', label: 'Максимум шагов агента', min: 1, max: 50 },
  { key: 'ai.autoApproveReads', type: 'boolean', default: true, group: 'ИИ', label: 'Агент читает файлы без вопросов' },
  { key: 'ai.autoApproveEdits', type: 'boolean', default: false, group: 'ИИ', label: 'Агент правит файлы без подтверждения' },
  { key: 'ai.autoApproveCommands', type: 'boolean', default: false, group: 'ИИ', label: 'Агент запускает команды без подтверждения' },
  { key: 'ai.mcpServers', type: 'array', default: [], group: 'ИИ', label: 'MCP-серверы для агента', desc: 'Например [{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}]. Серверы запускаются как программы на вашем ПК; вызовы их инструментов подтверждаются как команды.' },
  { key: 'ai.inline.enabled', type: 'boolean', default: false, group: 'ИИ', label: 'Автодополнение серым текстом (ghost-текст)', desc: 'Нужна модель с поддержкой fill-in-the-middle, например qwen2.5-coder в Ollama. Код вокруг курсора отправляется на указанный адрес.' },
  { key: 'ai.inline.url', type: 'string', default: 'http://localhost:11434/v1/completions', group: 'ИИ', label: 'Автодополнение: адрес /completions' },
  { key: 'ai.inline.model', type: 'string', default: 'qwen2.5-coder', group: 'ИИ', label: 'Автодополнение: модель' },
  { key: 'ai.inline.maxTokens', type: 'number', default: 96, group: 'ИИ', label: 'Автодополнение: максимум токенов', min: 16, max: 512, step: 16 },
  { key: 'ai.inline.delay', type: 'number', default: 350, group: 'ИИ', label: 'Автодополнение: пауза перед запросом, мс', min: 0, max: 2000, step: 50 },
  { key: 'ai.terminalAgents', type: 'array', default: [], group: 'ИИ', label: 'Свои агенты для терминала', desc: 'Например [{"name":"Aider","command":"aider"}].' },

  { key: 'update.check', type: 'enum', default: 'startup', group: 'Обновления', label: 'Проверка обновлений', options: [{ value: 'startup', label: 'при запуске (раз в сутки)' }, { value: 'never', label: 'только вручную' }] },
  { key: 'vscode.disabled', type: 'array', default: [], group: 'Плагины', label: 'Выключенные расширения VS Code' },
  { key: 'vscode.overrideBuiltin', type: 'boolean', default: false, group: 'Плагины', label: 'Грамматики расширений VS Code заменяют встроенную подсветку', desc: 'По умолчанию применяются только для языков, которых нет в редакторе.' },
  { key: 'plugins.disabled', type: 'array', default: [], group: 'Плагины', label: 'Отключённые плагины' },
  { key: 'plugins.registry', type: 'string', default: 'https://raw.githubusercontent.com/ahsoggg/lumen-code/main/registry/plugins.json', group: 'Плагины', label: 'Каталог плагинов (URL)' },

  { key: 'debug.justMyCode', type: 'boolean', default: true, group: 'Отладка', label: 'Python: отлаживать только свой код', desc: 'Не заходить внутрь библиотек.' },
  { key: 'debug.exceptions', type: 'enum', default: 'uncaught', group: 'Отладка', label: 'Останавливаться на исключениях', options: [{ value: 'none', label: 'никогда' }, { value: 'uncaught', label: 'только необработанные' }, { value: 'raised', label: 'на всех' }] },
  { key: 'debug.args', type: 'string', default: '', group: 'Отладка', label: 'Аргументы программы (Python)' },
  { key: 'debug.adapters', type: 'object', default: {}, group: 'Отладка', label: 'Свои отладчики (DAP)', desc: '{"go": {"kind":"stdio","command":"dlv","args":["dap"],"request":"launch","adapterID":"go","body":{"mode":"debug","program":"${file}"}}}' },
  { key: 'search.maxResults', type: 'number', default: 5000, group: 'Поиск', label: 'Максимум результатов', min: 100, max: 50000, step: 100 },
  { key: 'run.commands', type: 'object', default: {}, group: 'Запуск', label: 'Свои команды запуска', desc: 'По расширению или языку: {"lua": "lua \\"${file}\\"", "c": ["gcc \\"${file}\\" -o \\"${out}\\"", "\\"${out}\\""]}. Переменные: ${file} ${dir} ${name} ${out} ${python} ${workspace}.' },
  { key: 'keybindings', type: 'object', default: {}, group: 'Клавиши', label: 'Сочетания клавиш', desc: '{"ctrl+alt+r": "workbench.reload", "ctrl+b": ""} — пустая строка отвязывает.' },
];

const defs = new Map<string, SettingDef>(SCHEMA.map((d) => [d.key, d]));

export function defOf(key: string): SettingDef | undefined { return defs.get(key); }
export function contribute(entries: SettingDef[]): void {
  for (const e of entries) {
    defs.set(e.key, e);
    if (!SCHEMA.some((s) => s.key === e.key)) SCHEMA.push(e);
  }
}

class Settings {
  private user: Record<string, unknown> = {};
  private ws: Record<string, unknown> = {};
  private wsRoot: string | null = null;
  private userFile = '';
  readonly changed = new Emitter<string[]>();
  readonly saved = new Emitter<string>();
  private pendingUser = debounce(() => void this.flushUser(), 250);
  private pendingWs = debounce(() => void this.flushWs(), 250);

  get userPath(): string { return this.userFile; }
  get workspacePath(): string | null { return this.wsRoot ? join(this.wsRoot, '.lumen', 'settings.json') : null; }

  async init(configDir: string): Promise<void> {
    this.userFile = join(configDir, 'settings.json');
    await this.reloadUser(false);
  }

  async reloadUser(notify = true): Promise<void> {
    const before = { ...this.user };
    try {
      this.user = parseJsonc<Record<string, unknown>>((await ipc.readFile(this.userFile)).content, {});
    } catch {
      this.user = {};
    }
    if (notify) this.changed.fire(diffKeys(before, this.user));
  }

  async setWorkspace(root: string | null): Promise<void> {
    this.wsRoot = root;
    this.ws = {};
    if (root) {
      try { this.ws = parseJsonc<Record<string, unknown>>((await ipc.readFile(this.workspacePath!)).content, {}); } catch { /* none yet */ }
    }
    this.changed.fire(Object.keys(this.ws));
  }

  async reloadWorkspace(): Promise<void> {
    if (this.wsRoot) await this.setWorkspace(this.wsRoot);
  }

  get<T = unknown>(key: string): T {
    if (key in this.ws) return this.ws[key] as T;
    if (key in this.user) return this.user[key] as T;
    return defs.get(key)?.default as T;
  }

  has(key: string): boolean { return key in this.user; }

  set(key: string, value: unknown, scope: 'user' | 'workspace' = 'user'): void {
    const target = scope === 'workspace' && this.wsRoot ? this.ws : this.user;
    const def = defs.get(key)?.default;
    if (JSON.stringify(value) === JSON.stringify(def) && scope === 'user') delete target[key];
    else target[key] = value;
    if (target === this.ws) this.pendingWs(); else this.pendingUser();
    this.changed.fire([key]);
  }

  reset(key: string): void {
    delete this.user[key];
    this.pendingUser();
    this.changed.fire([key]);
  }

  private async flushUser(): Promise<void> {
    await ipc.writeFile(this.userFile, JSON.stringify(this.user, null, 2) + '\n');
    this.saved.fire(this.userFile);
  }

  private async flushWs(): Promise<void> {
    const p = this.workspacePath;
    if (!p) return;
    await ipc.writeFile(p, JSON.stringify(this.ws, null, 2) + '\n');
    this.saved.fire(p);
  }

  /** JSON Schema for settings.json so Monaco can autocomplete and validate it. */
  jsonSchema(): object {
    const properties: Record<string, object> = {};
    for (const d of SCHEMA) {
      const p: Record<string, unknown> = { description: [d.label, d.desc].filter(Boolean).join(' — '), default: d.default };
      if (d.type === 'boolean') p.type = 'boolean';
      else if (d.type === 'number') { p.type = 'number'; if (d.min != null) p.minimum = d.min; if (d.max != null) p.maximum = d.max; }
      else if (d.type === 'array') p.type = 'array';
      else if (d.type === 'object') p.type = 'object';
      else if (d.type === 'enum' && d.options) p.enum = d.options.map((o) => o.value);
      else p.type = 'string';
      properties[d.key] = p;
    }
    return { type: 'object', properties, additionalProperties: true };
  }
}

function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

export const settings = new Settings();
export const cfg = <T = unknown>(key: string): T => settings.get<T>(key);
