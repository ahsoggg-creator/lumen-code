# Плагины Lumen Code

Плагин — папка в `%APPDATA%\LumenCode\plugins\<id>\` с двумя файлами. Откройте её командой **«Плагины: открыть папку»**.

```
my-plugin/
  plugin.json
  main.js        # ES-модуль: export function activate(lumen) {}
  style.css      # необязательно
```

Быстрый старт: **«Плагины: создать новый»** — создаст заготовку и откроет её.
Перезагрузка после правок: **«Плагины: перезагрузить все»**.

## plugin.json

| Поле | Описание |
|---|---|
| `id` | латиница, цифры, `-`, `.`, `_` |
| `name`, `version`, `description`, `author` | для списка плагинов |
| `main` | файл с кодом (по умолчанию `main.js`) |
| `style` | файл CSS (необязательно) |
| `permissions` | `exec` (запуск программ), `net` (HTTP), `fs` (запись файлов) — спрашиваются один раз |
| `settings` | массив описаний настроек; ключ без точки получит префикс `<id>.` |
| `files` | дополнительные файлы (для установки по ссылке) |

> Плагины выполняются **внутри редактора с его правами**. Разрешения — предупреждение для пользователя и защита от случайности, а не песочница. Ставьте только то, чему доверяете.

## API: объект `lumen`

```js
export function activate(lumen) {
  lumen.commands.register('id', 'Название', () => {...}, { keybinding: 'ctrl+alt+x' });
  return () => {/* необязательная очистка */};
}
```

| Область | Методы |
|---|---|
| `lumen.commands` | `register(id, title, run, {keybinding, category})`, `execute(id, ...args)` |
| `lumen.window` | `info/warn/error(msg)`, `input({title,value,placeholder})`, `pick(items, {placeholder})`, `confirm(msg)`, `status({text,align,priority,tooltip,command,onClick})` → `{update, dispose}`, `openView(key, title, render(host))`, `addSidebarView({id,title,icon,render(host)})`, `openUntitled(text, lang)` |
| `lumen.editor` | `active()` → `{path, language, text, selectionText, line, column}`, `getEditor()` (Monaco), `insert`, `replaceSelection`, `replaceAll`, `openFile(path,{line,col})`, `onDidChangeActive`, `onDidSave` |
| `lumen.workspace` | `root`, `readFile`, `writeFile` (`fs`), `list`, `findFiles`, `search(query,{regex,include,exclude})`, `exists`, `onDidChangeRoot`, `onDidChangeFiles` |
| `lumen.settings` | `get`, `set`, `onChange`, `contribute([...])` |
| `lumen.storage` | `get(key)`, `set(key, value)` — личный JSON плагина |
| `lumen.terminal` | `run(cmd, {name, cwd})` (`exec`) |
| `lumen.exec` | `exec(program, args, {cwd, timeout})` → `{code, stdout, stderr}` (`exec`) |
| `lumen.http` | `http({url, method, headers, body})` → `{status, body}` (`net`) |
| `lumen.ai` | `chat(prompt, system)`; `registerAgent({id, name, description, run(ctx)})` — агент появится в выпадающем списке чата |
| `lumen.themes` | `register({id, name, dark, c: {base, mantle, crust, s0, s1, s2, overlay, subtext, text, red, green, yellow, blue, mauve, teal, peach, pink}})` |
| `lumen.monaco`, `lumen.ui` | сам Monaco; `h()` (создание DOM) и `icon()` |

### Агент от плагина

```js
lumen.ai.registerAgent({
  id: 'summarize', name: 'Резюме файла',
  async run(ctx) {                  // ctx: prompt, file, selection, workspace, emit(text), signal
    ctx.emit('Читаю…\n');
    return await lumen.ai.chat(`Кратко опиши файл:\n${ctx.file?.text ?? ''}`);
  },
});
```

## Установка

- Скопировать папку в каталог плагинов.
- **Плагины → «По ссылке»**: `владелец/репозиторий/путь/к/папке` или прямой URL каталога с `plugin.json`.
- **Плагины → Каталог**: список из `registry/plugins.json` этого репозитория (адрес меняется настройкой `plugins.registry`).

Примеры: [`examples/plugins`](../examples/plugins).
