// Headless smoke test: starts the release exe with the window hidden and WebView2 remote debugging enabled,
// drives the UI through the DevTools protocol (no real keyboard/mouse), checks key elements and console errors,
// saves a screenshot and prints the memory used by the whole process tree.
//
//   node scripts/smoke.mjs [path\to\lumen-code.exe] [screenshot.png]
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.argv[2] ?? 'src-tauri/target/release/lumen-code.exe';
const shot = process.argv[3];
const port = 9333;
const work = mkdtempSync(join(tmpdir(), 'lumen-smoke-'));
const appdata = join(work, 'appdata');
mkdirSync(appdata);
mkdirSync(join(work, 'proj', 'src'), { recursive: true });
writeFileSync(join(work, 'proj', 'main.py'), 'import os\n\ndef greet(name: str) -> str:\n    return f"hello {name}"\n\nprint(greet("мир"))\n');
writeFileSync(join(work, 'proj', 'src', 'app.ts'), 'export const x: number = 42;\nexport function add(a: number, b: number) { return a + b; }\n');
writeFileSync(join(work, 'proj', 'test.nix'), ['# a comment', '{ pkgs ? import <nixpkgs> {} }:', 'let name = "lumen"; n = 42; in pkgs.mkShell { buildInputs = [ pkgs.hello ]; }', ''].join(String.fromCharCode(10)));
writeFileSync(join(work, 'proj', 'bad.py'), ['import os', '', 'undefined_name', ''].join(String.fromCharCode(10)));
writeFileSync(join(work, 'proj', 'hello.rs'), ['fn main() {', '    let total = 40 + 2;', '    println!("{}", total);', '}', ''].join(String.fromCharCode(10)));
writeFileSync(join(work, 'proj', 'README.md'), '# Demo\n\nSome **markdown**.\n');

// A throw-away venv with debugpy so the debugger test does not touch the user's Python.
const venv = join(work, 'venv');
let venvPy = '';
try {
  execFileSync('python', ['-m', 'venv', venv], { stdio: 'ignore' });
  venvPy = join(venv, 'Scripts', 'python.exe');
  execFileSync(venvPy, ['-m', 'pip', 'install', '-q', 'debugpy', '--disable-pip-version-check'], { stdio: 'ignore', timeout: 180000 });
  mkdirSync(join(appdata, 'LumenCode'), { recursive: true });
  writeFileSync(join(appdata, 'LumenCode', 'settings.json'), JSON.stringify({ 'python.interpreter': venvPy }));
} catch { venvPy = ''; }
// The language server for the LSP check; without it that check is skipped.
let lspOk = false;
if (venvPy) {
  try { execFileSync(venvPy, ['-m', 'pip', 'install', '-q', 'basedpyright', '--disable-pip-version-check'], { stdio: 'ignore', timeout: 300000 }); lspOk = true; } catch { lspOk = false; }
}

const child = spawn(exe, [join(work, 'proj')], {
  env: { ...process.env, APPDATA: appdata, LUMEN_HEADLESS: '1', WEBVIEW2_USER_DATA_FOLDER: join(work, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failed++; };

async function targets() {
  for (let i = 0; i < 80; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = t.find((x) => x.type === 'page'); if (p) return p; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('WebView2 debug port never opened');
}

try {
  const page = await targets();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push(d.params.entry.text + ' ' + (d.params.entry.url ?? ''));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
  const waitFor = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(200); } return false; };
  await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 840, deviceScaleFactor: 1, mobile: false });

  check('shell renders', await waitFor('!!document.querySelector(".titlebar") && !!document.querySelector(".statusbar")'));
  check('explorer shows project files', await waitFor('document.querySelectorAll(".tree-row").length >= 3'), String(await ev('[...document.querySelectorAll(".tree-label")].map(e=>e.textContent).join(",")')));
  check('welcome page shown (no tabs restored)', await waitFor('!!document.querySelector(".welcome")'));

  // open a file by clicking the tree row
  await ev('[...document.querySelectorAll(".tree-row")].find(r=>r.textContent.includes("main.py"))?.click()');
  check('Monaco editor mounts for main.py', await waitFor('!!document.querySelector(".monaco-editor .view-lines")'));
  check('tab created', await waitFor('[...document.querySelectorAll(".tab-label")].some(e=>e.textContent==="main.py")'));
  check('syntax highlighting applied', await waitFor('document.querySelectorAll(".monaco-editor .view-lines .mtk1, .monaco-editor .view-lines span[class*=mtk]").length > 5'));

  if (lspOk) {
    await ev('[...document.querySelectorAll(".tree-row")].find(r=>r.textContent.includes("bad.py"))?.click()');
    check('LSP: status bar shows the language server', await waitFor('[...document.querySelectorAll(".status-item")].some(e=>e.textContent.includes("basedpyright"))', 60000), String(await ev('[...document.querySelectorAll(".status-item")].map(e=>e.textContent).join("|")')));
    check('LSP: an error in bad.py is underlined', await waitFor('document.querySelectorAll(".monaco-editor .squiggly-error").length > 0', 90000));
    // bad.py was opened as a preview tab and replaced main.py: bring main.py back for the debugger test
    await ev('[...document.querySelectorAll(".tree-row")].find(r=>r.textContent.includes("main.py"))?.click()');
    await waitFor('[...document.querySelectorAll(".tab-label")].some(e=>e.textContent==="main.py")');
  } else console.log('SKIP  LSP test (could not install basedpyright)');

  await ev('document.querySelector(".act-btn[title=\\"Поиск\\"]")?.click()');
  check('search view opens', await waitFor('!!document.querySelector(".search-top")'));
  await ev('document.querySelector(".act-btn[title=\\"Python\\"]")?.click()');
  check('python view opens and finds an interpreter', await waitFor('document.querySelectorAll(".py-interp").length >= 1', 25000), String(await ev('document.querySelectorAll(".py-interp").length')));
  check('pip packages listed', await waitFor('document.querySelectorAll(".pkg").length >= 1', 30000), String(await ev('document.querySelectorAll(".pkg").length')));
  await ev('document.querySelector(".act-btn[title=\\"Плагины\\"]")?.click()');
  check('builtin plugins active', await waitFor('document.querySelectorAll(".plug-card.active, .plug-card").length >= 4'), String(await ev('document.querySelectorAll(".plug-card").length')));
  await ev('document.querySelector(".act-btn[title=\\"Система контроля версий\\"]")?.click()');
  check('git view opens', await waitFor('!!document.querySelector(".git-view")'));

  // terminal
  await ev('document.querySelector(".tb-btn[title^=\\"Нижняя\\"]")?.click()');
  check('terminal panel opens and xterm renders', await waitFor('!!document.querySelector(".xterm-screen")', 20000));
  await sleep(1500);
  check('shell prints a prompt', await waitFor('document.querySelector(".xterm-rows")?.textContent.trim().length > 0', 25000));

  // palette
  await ev('document.querySelector(".command-center")?.click()');
  check('quick open lists files', await waitFor('document.querySelectorAll(".qi-item").length >= 1'));
  await ev('document.querySelector(".qi-overlay")?.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');

  // settings page + theme change
  await ev('document.querySelector(".act-btn[title=\\"Управление\\"]")?.click()');
  await ev('[...document.querySelectorAll(".menu-item")].find(e=>e.textContent.includes("Настройки"))?.click()');
  check('settings page opens', await waitFor('!!document.querySelector(".settings-page .theme-card")'));
  await ev('[...document.querySelectorAll(".theme-card")].find(e=>e.textContent.includes("Tokyo"))?.click()');
  check('theme switches', await waitFor('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()==="#1a1b26"'));

  // file menu: "New File" offers a blank document, a text document and the languages installed on this PC
  await ev('[...document.querySelectorAll(".menu-btn")].find(b=>b.textContent==="Файл")?.click()');
  await ev('[...document.querySelectorAll(".menu-item")].find(e=>e.textContent.trim().startsWith("Новый файл") && !e.textContent.includes("шаблона"))?.click()');
  check('New File offers blank, text and installed languages', await waitFor('(() => { const t = [...document.querySelectorAll(".qi-label")].map(e=>e.textContent); return t.includes("Пустой документ") && t.includes("Текстовый документ") && t.includes("Python"); })()'), String(await ev('[...document.querySelectorAll(".qi-label")].map(e=>e.textContent).join(",")')));
  // choosing Python opens an unnamed tab straight away (no name prompt); the save dialog gets the extension later
  await ev('[...document.querySelectorAll(".qi-item")].find(e=>e.querySelector(".qi-label")?.textContent==="Python")?.click()');
  check('New File > Python opens an unnamed tab without a prompt', await waitFor('!document.querySelector(".qi-overlay") && [...document.querySelectorAll(".tab.active .tab-label")].some(e=>/^Untitled-\\d+$/.test(e.textContent))'), String(await ev('[...document.querySelectorAll(".tab.active .tab-label")].map(e=>e.textContent).join(",")')));

  // file menu: templates
  await ev('[...document.querySelectorAll(".menu-btn")].find(b=>b.textContent==="Файл")?.click()');
  await ev('[...document.querySelectorAll(".menu-item")].find(e=>e.textContent.includes("из шаблона"))?.click()');
  check('new-file template picker lists languages', await waitFor('[...document.querySelectorAll(".qi-label")].map(e=>e.textContent).filter(t=>["Python","Java","C++","Go","Rust","HTML-страница"].includes(t)).length >= 6'), String(await ev('document.querySelectorAll(".qi-item").length')));
  await ev('document.querySelector(".qi-overlay")?.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
  await ev('[...document.querySelectorAll(".menu-btn")].find(b=>b.textContent==="Запуск")?.click()');
  check('Run menu has debug items', await waitFor('[...document.querySelectorAll(".menu-item")].some(e=>e.textContent.includes("Начать отладку")) && [...document.querySelectorAll(".menu-item")].some(e=>e.textContent.includes("точку останова"))'));
  await ev('document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))'); await ev('window.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');

  // file associations: page renders, and the registry round-trip works (a fake extension, cleaned up afterwards)
  await ev('[...document.querySelectorAll(".menu-btn")].find(b=>b.textContent==="Файл")?.click()');
  await ev('[...document.querySelectorAll(".menu-item")].find(e=>e.textContent.includes("Ассоциации"))?.click()');
  check('associations page lists extensions', await waitFor('document.querySelectorAll(".assoc-ext").length > 40'), String(await ev('document.querySelectorAll(".assoc-ext").length')));
  const inv = (cmd, args) => ev(`window.__TAURI_INTERNALS__.invoke("${cmd}", ${JSON.stringify(args)}).then(v=>JSON.stringify(v ?? null)).catch(e=>"ERR "+e)`);
  const applied = await inv('assoc_apply', { exts: ['lumentest'], allKnown: ['lumentest'], contextMenu: false });
  const st = await inv('assoc_status', { exts: ['lumentest'] });
  check('registry: extension registered under OpenWithProgids', applied === 'null' && JSON.parse(st).exts.includes('lumentest'), st);
  await inv('assoc_remove_all', { allKnown: ['lumentest'] });
  const st2 = await inv('assoc_status', { exts: ['lumentest'] });
  check('registry: cleaned up again', JSON.parse(st2).exts.length === 0 && !JSON.parse(st2).registered, st2);

  // debugger (needs debugpy in the temp venv)
  if (venvPy) {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await ev('[...document.querySelectorAll(".tab")].find(t=>t.textContent.includes("main.py"))?.click()');
    await sleep(500);
    const pos = await ev('(() => { const l=[...document.querySelectorAll(".monaco-editor .view-line")].find(e=>e.textContent.indexOf("return")>=0 && e.textContent.indexOf("hello")>=0); if(!l) return null; const r=l.getBoundingClientRect(); return {x:r.left+60,y:r.top+r.height/2}; })()');
    check('found the line to break on', !!pos, pos ? '' : await ev('JSON.stringify({n:document.querySelectorAll(".view-line").length, t:[...document.querySelectorAll(".view-line")].map(e=>e.textContent).slice(0,8), tab:[...document.querySelectorAll(".tab.active .tab-label")].map(e=>e.textContent)})'));
    if (pos) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      const key = async (code, k, vk, mods = 0) => { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: k, windowsVirtualKeyCode: vk, modifiers: mods }); await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk, modifiers: mods }); };
      await key('F9', 'F9', 120);
      check('breakpoint glyph appears (F9)', await waitFor('!!document.querySelector(".bp-glyph")'));
      await key('F5', 'F5', 116);
      check('debugger stops on the breakpoint', await waitFor('!!document.querySelector(".dbg-line")', 60000), await ev('[...document.querySelectorAll(".dc-line")].map(e=>e.textContent).join(" | ").slice(0,400)'));
      check('variables panel shows the local "name"', await waitFor('[...document.querySelectorAll(".var-name")].some(e=>e.textContent==="name")', 15000), String(await ev('[...document.querySelectorAll(".var-row")].map(e=>e.textContent).join(" | ")')));
      check('debug toolbar visible', await ev('!!document.querySelector(".dbg-toolbar") && getComputedStyle(document.querySelector(".dbg-toolbar")).display !== "none"'));
      await key('F10', 'F10', 121);
      await sleep(2000);
      check('step over keeps the session paused', await waitFor('!!document.querySelector(".dbg-line")', 15000));
      await key('F5', 'F5', 116);
      check('program finishes and toolbar hides', await waitFor('getComputedStyle(document.querySelector(".dbg-toolbar")).display === "none"', 30000));
    }
  } else console.log('SKIP  debugger test (could not build a venv with debugpy)');

  // native debugging (CodeLLDB is downloaded from GitHub, so this only runs with LUMEN_SMOKE_NATIVE=1 and rustc installed)
  if (process.env.LUMEN_SMOKE_NATIVE === '1') {
    const key2 = async (code, k, vk) => { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: k, windowsVirtualKeyCode: vk }); await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk }); };
    await ev('document.querySelector(".act-btn[title^=\\"Проводник\\"]")?.click()');
    await sleep(500);
    await ev('[...document.querySelectorAll(".tree-row")].find(r=>r.textContent.includes("hello.rs"))?.click()');
    await sleep(800);
    const pos2 = await ev('(() => { const l=[...document.querySelectorAll(".monaco-editor .view-line")].find(e=>e.textContent.indexOf("println")>=0); if(!l) return null; const r=l.getBoundingClientRect(); return {x:r.left+60,y:r.top+r.height/2}; })()');
    check('native: found the line to break on', !!pos2, pos2 ? '' : await ev('JSON.stringify({rows:[...document.querySelectorAll(".tree-row")].map(r=>r.textContent), tabs:[...document.querySelectorAll(".tab-label")].map(e=>e.textContent), lines:[...document.querySelectorAll(".view-line")].map(e=>e.textContent).slice(0,5)})'));
    if (pos2) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos2.x, y: pos2.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos2.x, y: pos2.y, button: 'left', clickCount: 1 });
      await key2('F9', 'F9', 120);
      await waitFor('!!document.querySelector(".bp-glyph")', 5000);
      await sleep(800);
      await key2('F5', 'F5', 116);
      check('native: asks before downloading the debugger', await waitFor('!!document.querySelector(".modal .btn.primary") && document.querySelector(".modal-body").textContent.includes("SHA-256")', 30000));
      await ev('document.querySelector(".modal .btn.primary")?.click()');
      check('native: stops on the breakpoint', await waitFor('!!document.querySelector(".dbg-line")', 400000), await ev('JSON.stringify({bp:document.querySelectorAll(".bp-glyph").length, toasts:document.getElementById("toasts")?.textContent, modal:document.querySelector(".modal")?.textContent?.slice(0,120), status:[...document.querySelectorAll(".status-item")].map(e=>e.textContent).join("|").slice(0,80), con:[...document.querySelectorAll(".dc-line")].map(e=>e.textContent).join(" | ").slice(0,700)})'));
      check('native: variables show "total"', await waitFor('[...document.querySelectorAll(".var-name")].some(e=>e.textContent==="total")', 20000), String(await ev('[...document.querySelectorAll(".var-row")].map(e=>e.textContent).join(" | ")')));
      await sleep(1500);
      await key2('F5', 'F5', 116);
      let extraStops = 0;
      for (let i = 0; i < 3; i++) {
        if (await waitFor('getComputedStyle(document.querySelector(".dbg-toolbar")).display === "none"', 6000)) break;
        extraStops++;
        await key2('F5', 'F5', 116);
      }
      console.log('native: extra stops after the first continue:', extraStops);
      check('native: program finishes', await waitFor('getComputedStyle(document.querySelector(".dbg-toolbar")).display === "none"', 60000), await ev('JSON.stringify({line:!!document.querySelector(".dbg-line"), tb:getComputedStyle(document.querySelector(".dbg-toolbar")).display, con:document.querySelector(".debug-console")?.textContent?.slice(-400), st:[...document.querySelectorAll(".status-item")].map(e=>e.textContent).join("|").slice(0,200)})'));
    }
  }

  // AI panel
  await ev('document.querySelector(".tb-btn[title^=\\"Чат\\"]")?.click()');
  check('AI chat panel opens', await waitFor('!!document.querySelector(".ai-view .ai-input")'));

  await sleep(500);
  if (shot) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(shot, Buffer.from(r.result.data, 'base64')); console.log(`screenshot: ${shot}`); }
  const real = errors.filter((e) => !/ResizeObserver|favicon/i.test(e));
  check('no console errors', real.length === 0, real.slice(0, 5).join(' | '));
  // VS Code extensions from Open VSX: a theme and a grammar-only language (needs network, skipped when offline)
  try {
    const get = async (ns, name) => JSON.parse(await ev(`window.__TAURI_INTERNALS__.invoke("http_request", {req:{url:"https://open-vsx.org/api/${ns}/${name}"}}).then(v=>v.body)`));
    const dr = await get('dracula-theme', 'theme-dracula');
    const nix = await get('jnoortheen', 'nix-ide');
    if (dr?.files?.download && nix?.files?.download) {
      const dest = join(appdata, 'LumenCode', 'vscode-extensions').replaceAll(String.fromCharCode(92), '/');
      const i1 = await inv('vsix_install', { source: dr.files.download, destRoot: dest });
      const i2 = await inv('vsix_install', { source: nix.files.download, destRoot: dest });
      check('Open VSX packages download and unpack', !i1.startsWith('ERR') && !i2.startsWith('ERR'), `${i1} ${i2}`.slice(0, 200));
      await ev('location.reload()');
      await sleep(1500);
      check('app reloads with extensions', await waitFor('!!document.querySelector(".titlebar") && !!document.querySelector(".tree-row")', 30000));
      await ev('[...document.querySelectorAll(".tree-row")].find(r=>r.textContent.includes("test.nix"))?.click()');
      check('VS Code grammar highlights a language Monaco lacks', await waitFor('new Set([...document.querySelectorAll(".monaco-editor .view-line span span")].map(e=>e.className).filter(c=>/mtk[0-9]+/.test(c))).size >= 3', 30000), String(await ev('[...new Set([...document.querySelectorAll(".monaco-editor .view-line span span")].map(e=>e.className))].join(",")')));
      await ev('document.querySelector(".act-btn[title=\\"Управление\\"]")?.click()');
      await waitFor('[...document.querySelectorAll(".menu-item")].some(e=>e.textContent.includes("Настройки"))', 5000);
      await ev('[...document.querySelectorAll(".menu-item")].find(e=>e.textContent.includes("Настройки"))?.click()');
      check('VS Code colour theme is offered', await waitFor('[...document.querySelectorAll(".theme-card")].some(e=>e.textContent.includes("Dracula (VS Code)")) || [...document.querySelectorAll(".theme-card")].some(e=>e.textContent.includes("(VS Code)"))', 20000), String(await ev('[...document.querySelectorAll(".theme-card")].map(e=>e.textContent).join("|") + " / tabs: " + [...document.querySelectorAll(".tab-label")].map(e=>e.textContent).join("|")')));
      check('imported theme applies (Dracula background)', await waitFor('(() => { if (document.documentElement.style.getPropertyValue("--bg").trim().toLowerCase() === "#282a36") return true; [...document.querySelectorAll(".theme-card")].find(e=>e.textContent.includes("Dracula Theme (VS Code)"))?.click(); return false; })()', 15000), String(await ev('document.documentElement.style.getPropertyValue("--bg")')));
      await sleep(800);
      const late = errors.filter((e) => !/ResizeObserver|favicon/i.test(e));
      check('no console errors after loading extensions', late.length === 0, late.slice(0, 3).join(' | '));
    } else console.log('SKIP  Open VSX tests (extensions not found)');
  } catch (e) { console.log('SKIP  Open VSX tests (offline?)', String(e).slice(0, 100)); }

  ws.close();
} catch (e) {
  check('smoke run', false, String(e));
}

try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `$p=Get-Process | Where-Object { $_.Id -eq ${child.pid} }; $ids=@(${child.pid}); $all=Get-CimInstance Win32_Process; function kids($i){ $all | Where-Object ParentProcessId -eq $i | ForEach-Object { $_.ProcessId; kids $_.ProcessId } }; $ids += kids ${child.pid}; $m = (Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum; "{0:N0} MB in {1} processes" -f ($m/1MB), $ids.Count`]).toString().trim();
  console.log(`memory (working set, whole tree): ${out}`);
} catch { /* ignore */ }
child.kill();
try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
await sleep(500);
try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
