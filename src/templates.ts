import { app } from './app';
import { commands } from './commands';
import { editors, languageFor } from './editor';
import { ipc, errText } from './ipc';
import { LANGS, ensureToolchain, hasTool, installToolchain, installedMap, rescanTools, type LangDef } from './toolchains';
import { confirmDialog, dialog, inputBox, notify, quickPick, type PickItem } from './ui';
import { basename, dirname, extname, join } from './util';

const userDir = (): string => join(app.paths.config, 'templates');

interface UserTemplate { name: string; path: string; ext: string }

async function userTemplates(): Promise<UserTemplate[]> {
  try {
    return (await ipc.readDir(userDir())).filter((e) => !e.is_dir).map((e) => ({ name: e.name.replace(/\.[^.]+$/, ''), path: e.path, ext: extname(e.name) }));
  } catch { return []; }
}

const clsName = (file: string): string => basename(file).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');

async function targetDir(preferred?: string): Promise<string | null> {
  if (preferred) return preferred;
  return app.root;
}

async function createFile(dir: string | null, fileName: string, content: string): Promise<void> {
  if (!dir) { editors.newUntitled(content, languageFor(fileName)); return; }
  const path = join(dir, fileName);
  if (await ipc.exists(path)) {
    if (!(await confirmDialog('Файл уже есть', `«${fileName}» уже существует. Открыть его?`, 'Открыть'))) return;
  } else {
    await ipc.writeFile(path, content);
  }
  await editors.openFile(path, { preview: false });
}

/** "Новый файл" (Ctrl+N): what to create right away: a blank tab, a text document or a language that is installed on this PC. */
export async function newFileChooser(dir?: string): Promise<void> {
  const installed = await installedMap();
  const items: PickItem<string>[] = [
    { label: 'Основное', value: '', header: true },
    { label: 'Пустой документ', description: 'безымянная вкладка, тип выберете позже', icon: 'file', value: 'untitled' },
    { label: 'Текстовый документ', description: '.txt', icon: 'fileText', value: 'text' },
    { label: 'Установлено на этом ПК', value: '', header: true },
    ...LANGS.filter((l) => installed.get(l.id)).map((l) => ({ label: l.name, description: `.${l.exts[0]}`, icon: 'fileText', value: `lang:${l.id}` })),
    { label: 'Ещё', value: '', header: true },
    { label: 'Другие языки и свои шаблоны…', description: 'в том числе ещё не установленные', icon: 'plus', value: 'more' },
  ];
  const pick = await quickPick(items, { placeholder: 'Что создать? (начните печатать, чтобы найти язык)' });
  if (!pick) return;
  if (pick.value === 'untitled') { editors.newUntitled(); return; }
  if (pick.value === 'more') { await newFromTemplate(dir); return; }
  const base = await targetDir(dir);
  if (pick.value === 'text') {
    const name = await inputBox({ title: 'Имя текстового документа', value: 'Новый текстовый документ.txt', validate: (v) => (/^[^\\/:*?"<>|]+$/.test(v.trim()) ? null : 'Недопустимое имя') });
    if (!name) return;
    const file = name.trim();
    await createFile(base, extname(file) ? file : `${file}.txt`, '');
    return;
  }
  await createFromLang(LANGS.find((l) => l.id === pick.value.slice(5))!, base);
}

export async function newFromTemplate(dir?: string): Promise<void> {
  const [installed, custom] = await Promise.all([installedMap(), userTemplates()]);
  const items: PickItem<string>[] = [];
  const groups = ['Языки программирования', 'Скрипты и оболочки', 'Веб и данные'] as const;
  for (const g of groups) {
    items.push({ label: g, value: '', header: true });
    for (const l of LANGS.filter((x) => x.group === g)) {
      const ok = installed.get(l.id) ?? true;
      items.push({ label: l.name, description: `.${l.exts[0]}`, detail: ok ? '' : 'не найден — можно установить', icon: ok ? 'fileText' : 'download', value: `lang:${l.id}` });
    }
  }
  if (custom.length) {
    items.push({ label: 'Свои шаблоны', value: '', header: true });
    for (const c of custom) items.push({ label: c.name, description: `.${c.ext}`, icon: 'copy', value: `user:${c.path}` });
  }
  items.push({ label: 'Другое', value: '', header: true }, { label: 'Файл с другим расширением…', icon: 'plus', value: 'other' }, { label: 'Пустой безымянный файл', icon: 'file', value: 'untitled' });
  const pick = await quickPick(items, { placeholder: 'Какой файл создать? (серые — нужной программы нет на этом ПК)' });
  if (!pick) return;
  const base = await targetDir(dir);

  if (pick.value === 'untitled') { editors.newUntitled(); return; }
  if (pick.value === 'other') {
    const name = await inputBox({ title: 'Имя файла с расширением', placeholder: 'script.xyz', validate: (v) => (/^[^\\/:*?"<>|]+\.[A-Za-z0-9]+$/.test(v.trim()) ? null : 'Например: notes.txt') });
    if (name) await createFile(base, name.trim(), '');
    return;
  }
  if (pick.value.startsWith('user:')) {
    const path = pick.value.slice(5);
    const ext = extname(path);
    const name = await inputBox({ title: 'Имя нового файла', value: `new.${ext}`, validate: (v) => (v.trim() ? null : 'Введите имя') });
    if (!name) return;
    const text = (await ipc.readFile(path)).content;
    await createFile(base, name.trim(), text.replace(/\$\{class\}/g, clsName(name)));
    return;
  }
  const lang = LANGS.find((l) => l.id === pick.value.slice(5))!;
  await createFromLang(lang, base);
}

async function createFromLang(lang: LangDef, base: string | null): Promise<void> {
  if (!(await confirmMissing(lang))) return;
  const name = await inputBox({ title: `Новый файл: ${lang.name}`, value: lang.defaultName, validate: (v) => (/^[^\\/:*?"<>|]+$/.test(v.trim()) ? null : 'Недопустимое имя') });
  if (!name) return;
  const file = name.trim();
  const finalName = extname(file) ? file : `${file}.${lang.exts[0]}`;
  await createFile(base, finalName, lang.template.replace(/\$\{class\}/g, clsName(finalName)));
}

/** Missing toolchain: let the user continue anyway, install it, or download it. */
async function confirmMissing(lang: LangDef): Promise<boolean> {
  if (await ensureProbe(lang)) return true;
  const buttons = [{ label: 'Отмена' }, { label: 'Всё равно создать файл' }, ...(lang.url ? [{ label: 'Скачать (сайт)' }] : []), ...(lang.winget ? [{ label: 'Установить через winget', primary: true }] : [])];
  const r = await dialog(`${lang.name} не найден`, `На этом компьютере нет ${lang.probe.join(' / ')}, поэтому файл не получится запустить.\nМожно создать файл сейчас, а программу установить или скачать.`, buttons);
  const label = buttons[r]?.label;
  if (label === 'Всё равно создать файл') return true;
  if (label === 'Скачать (сайт)') { void ipc.openUrl(lang.url!); return true; }
  if (label === 'Установить через winget') { void installToolchain(lang); return true; }
  return false;
}

async function ensureProbe(l: LangDef): Promise<boolean> {
  if (!l.probe.length) return true;
  for (const p of l.probe) if (await hasTool(p)) return true;
  return false;
}

export async function saveAsTemplate(): Promise<void> {
  const d = editors.activeDoc();
  if (!d) { notify('Откройте файл, который станет шаблоном', { kind: 'warn' }); return; }
  const ext = d.path ? extname(d.path) : 'txt';
  const name = await inputBox({ title: 'Название шаблона', value: d.path ? basename(d.path).replace(/\.[^.]+$/, '') : 'Мой шаблон', validate: (v) => (v.trim() ? null : 'Введите название') });
  if (!name) return;
  await ipc.writeFile(join(userDir(), `${name.trim()}.${ext}`), d.model.getValue());
  notify(`Шаблон «${name.trim()}» сохранён. Он появится в «Новый файл из шаблона».`);
}

// ---------------------------------------------------------------- projects
interface Scaffold { id: string; name: string; desc: string; need?: string[]; install?: string; files: (n: string) => Record<string, string>; open: string; cli?: (n: string) => string[] }

const SCAFFOLDS: Scaffold[] = [
  { id: 'python', name: 'Python-приложение', desc: 'main.py, requirements.txt, .gitignore', need: ['python'], install: 'python', open: 'main.py',
    files: (n) => ({ 'main.py': `def main() -> None:\n    print("Привет из ${n}!")\n\n\nif __name__ == "__main__":\n    main()\n`, 'requirements.txt': '', '.gitignore': '.venv/\n__pycache__/\n*.pyc\n', 'README.md': `# ${n}\n` }) },
  { id: 'web', name: 'Сайт: HTML + CSS + JS', desc: 'index.html, style.css, script.js', open: 'index.html',
    files: (n) => ({ 'index.html': `<!DOCTYPE html>\n<html lang="ru">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>${n}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>${n}</h1>\n  <script src="script.js"></script>\n</body>\n</html>\n`, 'style.css': 'body {\n  font-family: system-ui, sans-serif;\n  margin: 2rem;\n}\n', 'script.js': 'console.log("готово");\n' }) },
  { id: 'node', name: 'Node.js-приложение', desc: 'package.json, index.js', need: ['node'], install: 'javascript', open: 'index.js',
    files: (n) => ({ 'package.json': JSON.stringify({ name: n.toLowerCase().replace(/[^a-z0-9-]/g, '-'), version: '1.0.0', main: 'index.js', scripts: { start: 'node index.js' } }, null, 2) + '\n', 'index.js': 'console.log("Привет!");\n', '.gitignore': 'node_modules/\n' }) },
  { id: 'java', name: 'Java: консольное приложение', desc: 'src/Main.java', need: ['javac'], install: 'java', open: 'src\\Main.java',
    files: () => ({ 'src/Main.java': 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Привет, мир!");\n    }\n}\n', '.gitignore': '*.class\nout/\n' }) },
  { id: 'c', name: 'C: консольное приложение', desc: 'main.c', need: ['gcc', 'clang'], install: 'c', open: 'main.c',
    files: () => ({ 'main.c': '#include <stdio.h>\n\nint main(void) {\n    printf("Hello, world!\\n");\n    return 0;\n}\n' }) },
  { id: 'cpp', name: 'C++: консольное приложение', desc: 'main.cpp', need: ['g++', 'clang++'], install: 'cpp', open: 'main.cpp',
    files: () => ({ 'main.cpp': '#include <iostream>\n\nint main() {\n    std::cout << "Hello, world!" << std::endl;\n}\n' }) },
  { id: 'rust', name: 'Rust: cargo-проект', desc: 'cargo new', need: ['cargo'], install: 'rust', open: 'src\\main.rs', cli: (n) => ['cargo', 'new', n],
    files: (n) => ({ 'Cargo.toml': `[package]\nname = "${n.toLowerCase().replace(/[^a-z0-9_]/g, '_')}"\nversion = "0.1.0"\nedition = "2021"\n`, 'src/main.rs': 'fn main() {\n    println!("Hello, world!");\n}\n' }) },
  { id: 'go', name: 'Go-модуль', desc: 'go.mod, main.go', need: ['go'], install: 'go', open: 'main.go',
    files: (n) => ({ 'go.mod': `module ${n.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}\n\ngo 1.22\n`, 'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Привет!")\n}\n' }) },
  { id: 'csharp', name: 'C#: консольное приложение', desc: 'dotnet new console', need: ['dotnet'], install: 'csharp', open: 'Program.cs', cli: (n) => ['dotnet', 'new', 'console', '-n', n, '-o', n],
    files: () => ({ 'Program.cs': 'Console.WriteLine("Привет!");\n' }) },
];

export async function newProject(): Promise<void> {
  const ok = await installedMap();
  const pick = await quickPick(SCAFFOLDS.map((s) => ({ label: s.name, description: s.desc, detail: s.install && ok.get(s.install) === false ? 'нужная программа не найдена' : '', icon: 'folderPlus', value: s.id })), { placeholder: 'Тип нового проекта' });
  if (!pick) return;
  const sc = SCAFFOLDS.find((s) => s.id === pick.value)!;
  if (sc.install && ok.get(sc.install) === false) {
    const lang = LANGS.find((l) => l.id === sc.install)!;
    const go = await dialog(`${lang.name} не найден`, 'Проект можно создать и без него, но запустить его не получится, пока программа не установлена.', [{ label: 'Отмена' }, { label: 'Создать всё равно' }, ...(lang.winget ? [{ label: 'Установить и продолжить', primary: true }] : [])]);
    if (go === 0 || go === -1) return;
    if (go === 2 && !(await installToolchain(lang))) return;
  }
  const name = await inputBox({ title: 'Название проекта', value: 'my-project', validate: (v) => (/^[^\\/:*?"<>|]+$/.test(v.trim()) ? null : 'Недопустимое имя') });
  if (!name) return;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const parent = await open({ directory: true, title: 'В какой папке создать проект?', defaultPath: app.root ? dirname(app.root) : app.paths.home });
  if (typeof parent !== 'string') return;
  const dir = join(parent, name.trim());
  if (await ipc.exists(dir)) { notify(`Папка «${name.trim()}» уже существует`, { kind: 'warn' }); return; }
  try {
    if (sc.cli && sc.need && (await Promise.all(sc.need.map(hasTool))).some(Boolean)) {
      const [prog, ...args] = sc.cli(name.trim());
      const r = await ipc.exec(prog!, args, parent, 120000);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout);
    } else {
      for (const [rel, text] of Object.entries(sc.files(name.trim()))) await ipc.writeFile(join(dir, ...rel.split('/')), text);
    }
    const { openFolder } = await import('./workspace');
    if (await openFolder(dir)) await editors.openFile(join(dir, sc.open), { preview: false });
    notify(`Проект «${name.trim()}» создан`);
  } catch (e) { notify(`Не удалось создать проект: ${errText(e)}`, { kind: 'error' }); }
}

export function registerTemplates(): void {
  commands.register({ id: 'file.newChooser', title: 'Новый файл…', category: 'Файл', hidden: true, run: (...a: never[]) => newFileChooser((a as unknown as string[])[0]) });
  commands.register({ id: 'file.newFromTemplate', title: 'Новый файл из шаблона…', category: 'Файл', keybinding: 'ctrl+alt+n', run: (...a: never[]) => newFromTemplate((a as unknown as string[])[0]) });
  commands.register({ id: 'file.newProject', title: 'Новый проект…', category: 'Файл', run: () => newProject() });
  commands.register({ id: 'file.saveAsTemplate', title: 'Сохранить файл как шаблон…', category: 'Файл', run: () => saveAsTemplate() });
  commands.register({ id: 'file.openTemplatesFolder', title: 'Открыть папку своих шаблонов', category: 'Файл', run: async () => { await ipc.mkdir(userDir()); await ipc.reveal(userDir()); } });
  commands.register({ id: 'toolchains.manage', title: 'Языки и компиляторы: что установлено…', category: 'Запуск', run: async () => {
    await rescanTools();
    const ok = await installedMap();
    const pick = await quickPick(LANGS.filter((l) => l.probe.length).map((l) => ({ label: l.name, description: ok.get(l.id) ? 'установлен ✓' : 'не найден', detail: ok.get(l.id) ? '' : l.winget ? `winget install ${l.winget}` : l.url ?? '', icon: ok.get(l.id) ? 'check' : 'download', value: l.id })), { placeholder: 'Выберите язык, чтобы установить или скачать' });
    if (!pick) return;
    const lang = LANGS.find((l) => l.id === pick.value)!;
    if (!ok.get(lang.id)) await ensureToolchain(lang, `Установка ${lang.name}.`);
  } });
}
