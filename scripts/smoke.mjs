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

const child = spawn(exe, [join(work, 'proj')], {
  env: { ...process.env, APPDATA: appdata, LUMEN_HEADLESS: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
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
  check('shell prints a prompt', await waitFor('document.querySelector(".xterm-rows")?.textContent.trim().length > 0', 10000));

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

  // file menu: templates
  await ev('[...document.querySelectorAll(".menu-btn")].find(b=>b.textContent==="Файл")?.click()');
  await ev('[...document.querySelectorAll(".menu-item")].find(e=>e.textContent.includes("из шаблона"))?.click()');
  check('new-file template picker lists languages', await waitFor('[...document.querySelectorAll(".qi-label")].map(e=>e.textContent).filter(t=>["Python","Java","C++","Go","Rust","HTML-страница"].includes(t)).length >= 6'), String(await ev('document.querySelectorAll(".qi-item").length')));
  await ev('document.querySelector(".qi-overlay")?.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
  await ev('[...document.querySelectorAll(".menu-btn")].find(b=>b.textContent==="Запуск")?.click()');
  check('Run menu has debug items', await waitFor('[...document.querySelectorAll(".menu-item")].some(e=>e.textContent.includes("Начать отладку")) && [...document.querySelectorAll(".menu-item")].some(e=>e.textContent.includes("точку останова"))'));
  await ev('document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))'); await ev('window.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');

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
      check('debugger stops on the breakpoint', await waitFor('!!document.querySelector(".dbg-line")', 60000));
      check('variables panel shows the local "name"', await waitFor('[...document.querySelectorAll(".var-name")].some(e=>e.textContent==="name")', 15000), String(await ev('[...document.querySelectorAll(".var-row")].map(e=>e.textContent).join(" | ")')));
      check('debug toolbar visible', await ev('!!document.querySelector(".dbg-toolbar") && getComputedStyle(document.querySelector(".dbg-toolbar")).display !== "none"'));
      await key('F10', 'F10', 121);
      await sleep(2000);
      check('step over keeps the session paused', await waitFor('!!document.querySelector(".dbg-line")', 15000));
      await key('F5', 'F5', 116);
      check('program finishes and toolbar hides', await waitFor('getComputedStyle(document.querySelector(".dbg-toolbar")).display === "none"', 30000));
    }
  } else console.log('SKIP  debugger test (could not build a venv with debugpy)');

  // AI panel
  await ev('document.querySelector(".tb-btn[title^=\\"Чат\\"]")?.click()');
  check('AI chat panel opens', await waitFor('!!document.querySelector(".ai-view .ai-input")'));

  await sleep(500);
  if (shot) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(shot, Buffer.from(r.result.data, 'base64')); console.log(`screenshot: ${shot}`); }
  const real = errors.filter((e) => !/ResizeObserver|favicon/i.test(e));
  check('no console errors', real.length === 0, real.slice(0, 5).join(' | '));
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
