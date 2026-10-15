import { ipc } from './ipc';
import { log } from './panels';
import { runTask } from './tasks';
import { confirmDialog, dialog, notify } from './ui';
import { extname } from './util';

export interface LangDef {
  id: string;
  name: string;
  exts: string[];
  /** Executables; the toolchain counts as installed when any of them is on PATH. */
  probe: string[];
  winget?: string;
  url?: string;
  /** Commands run one after another (a failing step stops the chain). Variables: ${file} ${dir} ${name} ${out} ${python} ${workspace} ${class}. */
  run?: string[];
  runKind?: 'browser';
  defaultName: string;
  template: string;
  group: 'Языки программирования' | 'Скрипты и оболочки' | 'Веб и данные';
}

const HELLO = 'Привет, мир!';

export const LANGS: LangDef[] = [
  { id: 'python', name: 'Python', exts: ['py', 'pyw'], probe: ['python', 'py'], winget: 'Python.Python.3.12', url: 'https://www.python.org/downloads/', run: ['"${python}" "${file}"'], defaultName: 'main.py', group: 'Языки программирования',
    template: `def main() -> None:\n    print("${HELLO}")\n\n\nif __name__ == "__main__":\n    main()\n` },
  { id: 'java', name: 'Java', exts: ['java'], probe: ['javac', 'java'], winget: 'EclipseAdoptium.Temurin.21.JDK', url: 'https://adoptium.net/', run: ['java "${file}"'], defaultName: 'Main.java', group: 'Языки программирования',
    template: `public class \${class} {\n    public static void main(String[] args) {\n        System.out.println("${HELLO}");\n    }\n}\n` },
  { id: 'kotlin', name: 'Kotlin', exts: ['kt'], probe: ['kotlinc'], url: 'https://kotlinlang.org/docs/command-line.html', run: ['kotlinc "${file}" -include-runtime -d "${dir}\\${name}.jar"', 'java -jar "${dir}\\${name}.jar"'], defaultName: 'Main.kt', group: 'Языки программирования',
    template: `fun main() {\n    println("${HELLO}")\n}\n` },
  { id: 'c', name: 'C', exts: ['c'], probe: ['gcc', 'clang'], winget: 'BrechtSanders.WinLibs.POSIX.UCRT', url: 'https://winlibs.com/', run: ['gcc "${file}" -o "${out}"', '"${out}"'], defaultName: 'main.c', group: 'Языки программирования',
    template: `#include <stdio.h>\n\nint main(void) {\n    printf("Hello, world!\\n");\n    return 0;\n}\n` },
  { id: 'cpp', name: 'C++', exts: ['cpp', 'cc', 'cxx'], probe: ['g++', 'clang++'], winget: 'BrechtSanders.WinLibs.POSIX.UCRT', url: 'https://winlibs.com/', run: ['g++ "${file}" -std=c++17 -o "${out}"', '"${out}"'], defaultName: 'main.cpp', group: 'Языки программирования',
    template: `#include <iostream>\n\nint main() {\n    std::cout << "Hello, world!" << std::endl;\n    return 0;\n}\n` },
  { id: 'csharp', name: 'C#', exts: ['cs'], probe: ['dotnet'], winget: 'Microsoft.DotNet.SDK.9', url: 'https://dotnet.microsoft.com/download', run: ['dotnet run "${file}"'], defaultName: 'Program.cs', group: 'Языки программирования',
    template: `Console.WriteLine("${HELLO}");\n` },
  { id: 'go', name: 'Go', exts: ['go'], probe: ['go'], winget: 'GoLang.Go', url: 'https://go.dev/dl/', run: ['go run "${file}"'], defaultName: 'main.go', group: 'Языки программирования',
    template: `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("${HELLO}")\n}\n` },
  { id: 'rust', name: 'Rust', exts: ['rs'], probe: ['rustc', 'cargo'], winget: 'Rustlang.Rustup', url: 'https://rustup.rs/', run: ['rustc "${file}" -o "${out}"', '"${out}"'], defaultName: 'main.rs', group: 'Языки программирования',
    template: `fn main() {\n    println!("${HELLO}");\n}\n` },
  { id: 'dart', name: 'Dart', exts: ['dart'], probe: ['dart'], winget: 'Google.DartSDK', url: 'https://dart.dev/get-dart', run: ['dart run "${file}"'], defaultName: 'main.dart', group: 'Языки программирования',
    template: `void main() {\n  print('${HELLO}');\n}\n` },
  { id: 'zig', name: 'Zig', exts: ['zig'], probe: ['zig'], winget: 'zig.zig', url: 'https://ziglang.org/download/', run: ['zig run "${file}"'], defaultName: 'main.zig', group: 'Языки программирования',
    template: `const std = @import("std");\n\npub fn main() !void {\n    try std.io.getStdOut().writer().print("Hello, world!\\n", .{});\n}\n` },
  { id: 'julia', name: 'Julia', exts: ['jl'], probe: ['julia'], winget: 'Julialang.Julia', url: 'https://julialang.org/downloads/', run: ['julia "${file}"'], defaultName: 'main.jl', group: 'Языки программирования',
    template: `println("${HELLO}")\n` },
  { id: 'elixir', name: 'Elixir', exts: ['exs', 'ex'], probe: ['elixir'], winget: 'Elixir.Elixir', url: 'https://elixir-lang.org/install.html', run: ['elixir "${file}"'], defaultName: 'main.exs', group: 'Языки программирования',
    template: `IO.puts("${HELLO}")\n` },
  { id: 'haskell', name: 'Haskell', exts: ['hs'], probe: ['runghc', 'ghc'], url: 'https://www.haskell.org/ghcup/', run: ['runghc "${file}"'], defaultName: 'Main.hs', group: 'Языки программирования',
    template: `main :: IO ()\nmain = putStrLn "${HELLO}"\n` },

  { id: 'javascript', name: 'JavaScript (Node.js)', exts: ['js', 'mjs', 'cjs'], probe: ['node'], winget: 'OpenJS.NodeJS.LTS', url: 'https://nodejs.org/', run: ['node "${file}"'], defaultName: 'index.js', group: 'Скрипты и оболочки',
    template: `console.log("${HELLO}");\n` },
  { id: 'typescript', name: 'TypeScript', exts: ['ts', 'mts'], probe: ['node'], winget: 'OpenJS.NodeJS.LTS', url: 'https://nodejs.org/', run: ['npx --yes tsx "${file}"'], defaultName: 'index.ts', group: 'Скрипты и оболочки',
    template: `const greet = (name: string): string => \`Привет, \${name}!\`;\nconsole.log(greet("мир"));\n` },
  { id: 'php', name: 'PHP', exts: ['php'], probe: ['php'], winget: 'PHP.PHP.8.4', url: 'https://windows.php.net/download/', run: ['php "${file}"'], defaultName: 'index.php', group: 'Скрипты и оболочки',
    template: `<?php\n\necho "${HELLO}\\n";\n` },
  { id: 'ruby', name: 'Ruby', exts: ['rb'], probe: ['ruby'], winget: 'RubyInstallerTeam.Ruby.3.4', url: 'https://rubyinstaller.org/', run: ['ruby "${file}"'], defaultName: 'main.rb', group: 'Скрипты и оболочки',
    template: `puts "${HELLO}"\n` },
  { id: 'perl', name: 'Perl', exts: ['pl'], probe: ['perl'], winget: 'StrawberryPerl.StrawberryPerl', url: 'https://strawberryperl.com/', run: ['perl "${file}"'], defaultName: 'main.pl', group: 'Скрипты и оболочки',
    template: `use strict;\nuse warnings;\n\nprint "${HELLO}\\n";\n` },
  { id: 'lua', name: 'Lua', exts: ['lua'], probe: ['lua', 'luajit'], winget: 'DEVCOM.Lua', url: 'https://www.lua.org/download.html', run: ['lua "${file}"'], defaultName: 'main.lua', group: 'Скрипты и оболочки',
    template: `print("${HELLO}")\n` },
  { id: 'r', name: 'R', exts: ['r'], probe: ['Rscript'], winget: 'RProject.R', url: 'https://cran.r-project.org/', run: ['Rscript "${file}"'], defaultName: 'main.R', group: 'Скрипты и оболочки',
    template: `cat("${HELLO}\\n")\n` },
  { id: 'powershell', name: 'PowerShell', exts: ['ps1'], probe: ['powershell', 'pwsh'], winget: 'Microsoft.PowerShell', run: ['powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"'], defaultName: 'script.ps1', group: 'Скрипты и оболочки',
    template: `Write-Host "${HELLO}"\n` },
  { id: 'bat', name: 'Пакетный файл (.bat)', exts: ['bat', 'cmd'], probe: ['cmd'], run: ['"${file}"'], defaultName: 'run.bat', group: 'Скрипты и оболочки',
    template: `@echo off\nchcp 65001 >nul\necho ${HELLO}\npause\n` },
  { id: 'shell', name: 'Bash / sh', exts: ['sh'], probe: ['bash'], winget: 'Git.Git', url: 'https://git-scm.com/download/win', run: ['bash "${file}"'], defaultName: 'script.sh', group: 'Скрипты и оболочки',
    template: `#!/usr/bin/env bash\nset -euo pipefail\n\necho "${HELLO}"\n` },
  { id: 'gdscript', name: 'GDScript (Godot)', exts: ['gd'], probe: ['godot'], winget: 'GodotEngine.GodotEngine', url: 'https://godotengine.org/download', run: ['godot --headless -s "${file}"'], defaultName: 'script.gd', group: 'Скрипты и оболочки',
    template: `extends Node\n\n\nfunc _ready() -> void:\n\tprint("${HELLO}")\n` },

  { id: 'html', name: 'HTML-страница', exts: ['html', 'htm'], probe: [], runKind: 'browser', defaultName: 'index.html', group: 'Веб и данные',
    template: `<!DOCTYPE html>\n<html lang="ru">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Страница</title>\n  <style>\n    body { font-family: system-ui, sans-serif; margin: 2rem; }\n  </style>\n</head>\n<body>\n  <h1>${HELLO}</h1>\n  <script>\n    console.log("готово");\n  </script>\n</body>\n</html>\n` },
  { id: 'svg', name: 'SVG-картинка', exts: ['svg'], probe: [], runKind: 'browser', defaultName: 'image.svg', group: 'Веб и данные',
    template: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">\n  <circle cx="100" cy="100" r="80" fill="#cba6f7"/>\n</svg>\n` },
  { id: 'css', name: 'CSS', exts: ['css'], probe: [], defaultName: 'style.css', group: 'Веб и данные', template: `:root {\n  --accent: #cba6f7;\n}\n\nbody {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n}\n` },
  { id: 'json', name: 'JSON', exts: ['json'], probe: [], defaultName: 'data.json', group: 'Веб и данные', template: `{\n  \n}\n` },
  { id: 'markdown', name: 'Markdown', exts: ['md'], probe: [], defaultName: 'README.md', group: 'Веб и данные', template: `# Заголовок\n\nТекст.\n` },
  { id: 'yaml', name: 'YAML', exts: ['yml', 'yaml'], probe: [], defaultName: 'config.yml', group: 'Веб и данные', template: `name: example\nitems:\n  - one\n  - two\n` },
  { id: 'sql', name: 'SQL', exts: ['sql'], probe: [], defaultName: 'query.sql', group: 'Веб и данные', template: `SELECT 1;\n` },
  { id: 'xml', name: 'XML', exts: ['xml'], probe: [], defaultName: 'data.xml', group: 'Веб и данные', template: `<?xml version="1.0" encoding="UTF-8"?>\n<root>\n</root>\n` },
  { id: 'plaintext', name: 'Текстовый файл', exts: ['txt'], probe: [], defaultName: 'notes.txt', group: 'Веб и данные', template: '' },
];

export const langForExt = (ext: string): LangDef | undefined => LANGS.find((l) => l.exts.includes(ext.toLowerCase()));
export const langForPath = (path: string): LangDef | undefined => langForExt(extname(path));
export const langById = (id: string): LangDef | undefined => LANGS.find((l) => l.id === id);

// ---------------------------------------------------------------- detection
const found = new Map<string, boolean>();

export async function hasTool(cmd: string): Promise<boolean> {
  const hit = found.get(cmd);
  if (hit !== undefined) return hit;
  const r = await ipc.exec('where', [cmd], undefined, 5000).catch(() => null);
  const ok = r?.code === 0 && !/\\microsoft\\windowsapps\\/i.test(r.stdout.split('\n')[0] ?? '');
  found.set(cmd, ok);
  return ok;
}

export async function isInstalled(l: LangDef): Promise<boolean> {
  if (!l.probe.length) return true;
  for (const p of l.probe) if (await hasTool(p)) return true;
  return false;
}

export async function installedMap(): Promise<Map<string, boolean>> {
  const res = await Promise.all(LANGS.map(async (l) => [l.id, await isInstalled(l)] as const));
  return new Map(res);
}

export async function rescanTools(): Promise<void> {
  await ipc.refreshEnv().catch(() => undefined);
  found.clear();
}

// ---------------------------------------------------------------- install / download
export async function installToolchain(l: LangDef): Promise<boolean> {
  if (!l.winget) {
    if (l.url) { notify(`Для ${l.name} нет пакета winget — открываю страницу загрузки.`); void ipc.openUrl(l.url); }
    return false;
  }
  const wg = await hasTool('winget');
  if (!wg) {
    notify('winget не найден. Открываю страницу загрузки.', { kind: 'warn' });
    if (l.url) void ipc.openUrl(l.url);
    return false;
  }
  if (!(await confirmDialog(`Установка: ${l.name}`, `Будет выполнено:\nwinget install -e --id ${l.winget}\n\nWindows может запросить подтверждение (UAC). Продолжить?`, 'Установить'))) return false;
  const toast = notify(`Устанавливаю ${l.name}…`, { timeout: 0, progress: true });
  const t = runTask('winget', ['install', '-e', '--id', l.winget, '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], {
    onLine: (line) => { const clean = line.replace(/[\u0008\r]/g, '').trim(); if (clean && !/^[-\\|/ ]+$/.test(clean)) { log('Установка', clean); toast.update(`Устанавливаю ${l.name}… ${clean.slice(0, 60)}`); } },
  });
  const code = await t.done;
  toast.close();
  await rescanTools();
  const ok = await isInstalled(l);
  if (ok) notify(`${l.name} установлен и готов к работе`);
  else notify(`Установка ${l.name} завершилась кодом ${code}, но программа пока не найдена. Перезапустите редактор или посмотрите вывод «Установка».`, { kind: code === 0 ? 'warn' : 'error', timeout: 12000 });
  return ok;
}

/** Asks what to do when the toolchain is missing. Resolves true when it is available afterwards. */
export async function ensureToolchain(l: LangDef, why: string): Promise<boolean> {
  if (await isInstalled(l)) return true;
  const buttons = [{ label: 'Отмена' }, ...(l.url ? [{ label: 'Скачать (сайт)' }] : []), ...(l.winget ? [{ label: 'Установить через winget', primary: true }] : [])];
  const r = await dialog(`${l.name} не найден`, `${why}\nНа этом компьютере не найдено: ${l.probe.join(' / ')}.`, buttons);
  const label = buttons[r]?.label;
  if (label === 'Скачать (сайт)') { void ipc.openUrl(l.url!); return false; }
  if (label === 'Установить через winget') return installToolchain(l);
  return false;
}
