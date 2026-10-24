import { app } from './app';
import { commands } from './commands';
import { editors } from './editor';
import { errText, ipc, on } from './ipc';
import { log, revealChannel } from './panels';
import { crashAddresses, isCrashHeader, matchProjectFile, networkPorts } from './crash';
import { parsePlot } from './plot';
import { runTask } from './tasks';
import { hasTool } from './toolchains';
import { notify, inputBox, quickPick, type PickItem } from './ui';
import { dirname, h, uid } from './util';

const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];
const COLORS = ['#f38ba8', '#a6e3a1', '#89b4fa', '#f9e2af', '#cba6f7', '#94e2d5', '#fab387', '#f5c2e7'];
const MAX_POINTS = 600;
const MAX_LOG = 3000;
const MAX_LOG_CHARS = 256 * 1024;
const MAX_LINE = 4096;
const PLOT_LINES_PER_BATCH = 200;
const CHANNEL = 'Прошивка';

class Plotter {
  readonly canvas = h('canvas.serial-plot');
  private series = new Map<string, number[]>();

  push(line: string): void {
    for (const [k, v] of parsePlot(line)) {
      const a = this.series.get(k) ?? [];
      a.push(v);
      if (a.length > MAX_POINTS) a.shift();
      this.series.set(k, a);
    }
    if (this.series.size > 12) this.series.delete(this.series.keys().next().value as string);
  }

  clear(): void { this.series.clear(); this.draw(); }

  draw(): void {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, hh = c.clientHeight;
    if (!w || !hh) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    g.clearRect(0, 0, w, hh);
    const all = [...this.series.values()].flat();
    if (!all.length) { g.fillStyle = css.getPropertyValue('--text-dim') || '#888'; g.fillText('Нет числовых данных: выводите значения вида «a:1 b:2» или «1,2,3»', 12, 20); return; }
    let lo = Math.min(...all), hi = Math.max(...all);
    if (lo === hi) { lo -= 1; hi += 1; }
    const padL = 44, padB = 14, pw = w - padL - 8, ph = hh - padB - 8;
    g.strokeStyle = css.getPropertyValue('--border') || '#444';
    g.fillStyle = css.getPropertyValue('--text-dim') || '#888';
    g.font = '11px monospace';
    for (let i = 0; i <= 4; i++) {
      const y = 8 + (ph * i) / 4;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - 8, y); g.stroke();
      g.fillText((hi - ((hi - lo) * i) / 4).toPrecision(4), 2, y + 4);
    }
    let ci = 0;
    for (const [name, a] of this.series) {
      const col = COLORS[ci++ % COLORS.length]!;
      g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath();
      a.forEach((v, i) => {
        const x = padL + (pw * i) / Math.max(1, MAX_POINTS - 1) + (pw * (MAX_POINTS - a.length)) / Math.max(1, MAX_POINTS - 1);
        const y = 8 + ph - ((v - lo) / (hi - lo)) * ph;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.stroke();
      g.fillStyle = col; g.fillText(`${name}=${a[a.length - 1]}`, padL + 6 + (ci - 1) * 90, hh - 3);
    }
  }
}

function render(host: HTMLElement): () => void {
  const id = uid('serial');
  let connected = false;
  let carry = '';
  const plot = new Plotter();
  const logEl = h('pre.serial-log');
  const lines: string[] = [];
  let dirty = false;

  const portSel = h('select.field');
  const baudSel = h('select.field', null, ...BAUDS.map((b) => h('option', { value: String(b), selected: b === 115200 }, String(b))));
  const eolSel = h('select.field', null, h('option', { value: '' }, 'без окончания'), h('option', { value: '\n', selected: true }, 'LF (\\n)'), h('option', { value: '\r\n' }, 'CRLF (\\r\\n)'));
  const status = h('span.dim.small', null, 'не подключено');
  const fqbn = h('input.field', { placeholder: 'FQBN: arduino:avr:uno, esp32:esp32:esp32', value: localStorage.getItem('lumen.serial.fqbn') ?? '', spellcheck: false });
  const connectBtn = h('button.btn.primary', { onclick: () => void toggle() }, 'Подключить');

  async function refreshPorts(): Promise<void> {
    try {
      const ports = await ipc.serialPorts();
      const cur = portSel.value;
      portSel.replaceChildren(...(ports.length ? ports : [{ name: '', kind: 'портов нет' }]).map((p) => h('option', { value: p.name }, p.name ? `${p.name}${p.kind ? ` — ${p.kind}` : ''}` : p.kind)));
      if (ports.some((p) => p.name === cur)) portSel.value = cur;
    } catch (e) { notify(errText(e), { kind: 'error' }); }
  }

  async function toggle(): Promise<void> {
    if (connected) { await disconnect(); return; }
    if (!portSel.value) { notify('Выберите порт', { kind: 'warn' }); return; }
    try {
      await ipc.serialOpen(id, portSel.value, Number(baudSel.value));
      connected = true;
      connectBtn.textContent = 'Отключить';
      status.textContent = `${portSel.value} @ ${baudSel.value}`;
    } catch (e) { notify(errText(e), { kind: 'error' }); }
  }

  async function disconnect(): Promise<void> {
    if (!connected) return;
    await ipc.serialClose(id).catch(() => undefined);
    connected = false;
    connectBtn.textContent = 'Подключить';
    status.textContent = 'не подключено';
  }

  function onData(data: string, dropped = 0): void {
    if (dropped > 0) { lines.push(`[… пропущено ${dropped} байт: устройство шлёт быстрее, чем можно показать]`); carry = ''; }
    const text = carry + data;
    const parts = text.split(/\r?\n/);
    carry = parts.pop() ?? '';
    if (carry.length > MAX_LINE) { parts.push(carry.slice(0, MAX_LINE)); carry = carry.slice(MAX_LINE); }
    for (const l of parts) lines.push(l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l);
    // The plotter only needs the freshest values of a burst, and decoding looks at every line once.
    for (const l of parts.slice(-PLOT_LINES_PER_BATCH)) plot.push(l);
    for (const l of parts.slice(-500)) watchCrash(l);
    if (lines.length > MAX_LOG) lines.splice(0, lines.length - MAX_LOG);
    // The log is also bounded by size: a few thousand 4 KB lines would be megabytes of text to re-render every tick.
    let chars = lines.reduce((n, l) => n + l.length + 1, 0);
    while (chars > MAX_LOG_CHARS && lines.length > 1) chars -= lines.shift()!.length + 1;
    dirty = true;
  }

  // ---- crash decoder: Backtrace lines -> function, file and line through addr2line and the project's .elf
  const elfInput = h('input.field', { placeholder: '.elf текущей сборки (ищется автоматически)', value: localStorage.getItem('lumen.serial.elf') ?? '', spellcheck: false, onchange: () => localStorage.setItem('lumen.serial.elf', elfInput.value.trim()) });
  const crashBox = h('div.serial-crash');
  let lastAddrs: string[] = [];
  let projectFiles: string[] | null = null;

  async function findElf(): Promise<string> {
    const set = elfInput.value.trim();
    if (set && (await ipc.exists(set).catch(() => false))) return set;
    const root = sketchDir();
    if (!root) return '';
    const all = (await ipc.listFiles(root, 20000).catch(() => [] as string[])).filter((p) => /\.elf$/i.test(p) && !/bootloader/i.test(p));
    const pick = all.find((p) => /[\\/](build|\.pio)[\\/]/i.test(p)) ?? all[0] ?? '';
    if (pick) { elfInput.value = pick; localStorage.setItem('lumen.serial.elf', pick); }
    return pick;
  }

  async function openFrame(file: string, line: number): Promise<void> {
    projectFiles ??= app.root ? await ipc.listFiles(app.root, 50000).catch(() => []) : [];
    const path = (await ipc.exists(file).catch(() => false)) ? file : matchProjectFile(file, projectFiles);
    if (!path) { notify(`Файл не найден в проекте: ${file}`, { kind: 'warn' }); return; }
    await editors.openFile(path, { line, preview: false });
  }

  async function decode(addrs: string[], title: string): Promise<void> {
    lastAddrs = addrs;
    const head = h('div.crash-head', null, h('b', null, title), h('button.btn', { onclick: () => void decode(lastAddrs, title) }, 'Расшифровать снова'), h('button.icon-btn', { title: 'Закрыть', onclick: () => crashBox.replaceChildren() }, '×'));
    const body = h('div.crash-body', null, 'Расшифровываю…');
    crashBox.replaceChildren(head, body);
    try {
      const elf = await findElf();
      if (!elf) { body.textContent = 'Не найден .elf: соберите проект (arduino-cli compile) или укажите путь к .elf выше.'; return; }
      const frames = await ipc.decodeBacktrace(elf, addrs);
      if (!frames.length) { body.textContent = `Адреса не расшифрованы (${addrs.join(' ')}). Проверьте, что .elf от той же сборки, что и прошивка в плате.`; return; }
      body.replaceChildren(...frames.map((f) => h('div.crash-frame', null, h('span.dim', null, f.addr), ' ', h('b', null, f.func), ' ',
        h('a.crash-link', { href: '#', title: f.file, onclick: (e: Event) => { e.preventDefault(); void openFrame(f.file, f.line); } }, `${f.file.split(/[\\/]/).pop()}:${f.line}`))));
    } catch (e) { body.textContent = errText(e); }
  }

  let crashTimer = 0;
  let pendingAddrs: string[] = [];
  let crashTitle = 'Падение микроконтроллера';
  function watchCrash(line: string): void {
    if (isCrashHeader(line)) crashTitle = line.trim().slice(0, 90);
    const a = crashAddresses(line);
    if (!a.length) return;
    pendingAddrs = [...new Set([...pendingAddrs, ...a])].slice(0, 32);
    clearTimeout(crashTimer);
    crashTimer = window.setTimeout(() => { const batch = pendingAddrs; pendingAddrs = []; void decode(batch, crashTitle); }, 400);
  }

  const tick = window.setInterval(() => {
    if (!dirty) return;
    dirty = false;
    const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8;
    logEl.textContent = lines.join('\n') + (carry ? '\n' + carry : '');
    if (stick) logEl.scrollTop = logEl.scrollHeight;
    plot.draw();
  }, 100);

  const input = h('input.field', { placeholder: 'Отправить в порт и нажать Enter', spellcheck: false, onkeydown: (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !connected) return;
    void ipc.serialWrite(id, input.value + eolSel.value).catch((er) => notify(errText(er), { kind: 'error' }));
    input.value = '';
  } });

  // ---- firmware: arduino-cli / esptool
  const sketchDir = (): string => {
    const d = editors.activeDoc();
    return d?.path ? dirname(d.path) : app.root ?? '';
  };
  async function fw(program: string, args: string[], cwd?: string): Promise<number> {
    revealChannel(CHANNEL);
    log(CHANNEL, `> ${program} ${args.join(' ').replace(/(password=)\S+/g, '$1***')}`);
    const t = runTask(program, args, { cwd, onLine: (l) => log(CHANNEL, l) });
    const code = await t.done;
    log(CHANNEL, code === 0 ? '✔ готово' : `✖ код выхода ${code}`);
    return code;
  }
  const needFqbn = (): string | null => {
    const v = fqbn.value.trim();
    if (!v) { notify('Укажите FQBN платы (кнопка «Платы» подскажет)', { kind: 'warn' }); return null; }
    localStorage.setItem('lumen.serial.fqbn', v);
    return v;
  };
  async function cli(args: string[]): Promise<void> {
    if (!(await hasTool('arduino-cli'))) { notify('arduino-cli не найден в PATH: https://arduino.github.io/arduino-cli/', { kind: 'warn' }); return; }
    await fw('arduino-cli', args, sketchDir() || undefined);
  }
  /** OTA: boards announcing themselves on the network (mDNS discovery of arduino-cli) or an address typed in. */
  async function ota(): Promise<void> {
    const f = needFqbn();
    if (!f) return;
    if (!(await hasTool('arduino-cli'))) { notify('arduino-cli не найден в PATH', { kind: 'warn' }); return; }
    status.textContent = 'ищу платы в сети…';
    const found = networkPorts((await ipc.exec('arduino-cli', ['board', 'list', '--format', 'json'], undefined, 30000).catch(() => ({ stdout: '' }))).stdout);
    status.textContent = connected ? `${portSel.value} @ ${baudSel.value}` : 'не подключено';
    const items: PickItem<string>[] = [...found.map((p) => ({ label: p.address, description: p.label, value: p.address })), { label: 'Ввести адрес или имя вручную…', value: '' }];
    const hit = await quickPick(items, { placeholder: found.length ? 'Плата для прошивки по воздуху' : 'Плат в сети не найдено: введите адрес вручную' });
    if (!hit) return;
    const addr = hit.value || (await inputBox({ title: 'IP-адрес или имя платы (esp32.local)', placeholder: '192.168.1.50' }))?.trim();
    if (!addr) return;
    const pw = await inputBox({ title: 'Пароль OTA (пусто — без пароля)', password: true });
    if (pw === undefined) return;
    await disconnect();
    await cli(['compile', '--upload', '--fqbn', f, '--port', addr, '--protocol', 'network', ...(pw ? ['--upload-field', `password=${pw}`] : []), sketchDir()]);
  }
  const fwBar = h('div.serial-bar', null,
    h('b.small', null, 'Прошивка'), fqbn,
    h('button.btn', { onclick: () => void cli(['board', 'list']) }, 'Платы'),
    h('button.btn', { onclick: () => { const f = needFqbn(); if (f) void cli(['compile', '--fqbn', f, sketchDir()]); } }, 'Компиляция'),
    h('button.btn', { onclick: async () => {
      const f = needFqbn();
      if (!f) return;
      if (!portSel.value) { notify('Выберите порт', { kind: 'warn' }); return; }
      await disconnect();
      await cli(['compile', '--upload', '--fqbn', f, '--port', portSel.value, sketchDir()]);
    } }, 'Загрузить'),
    h('button.btn', { onclick: async () => {
      if (!portSel.value) { notify('Выберите порт', { kind: 'warn' }); return; }
      const { open } = await import('@tauri-apps/plugin-dialog');
      const file = await open({ multiple: false, directory: false, title: 'Образ прошивки (.bin) для esptool', filters: [{ name: 'bin', extensions: ['bin'] }] });
      if (typeof file !== 'string') return;
      const addr = await inputBox({ title: 'Адрес записи', value: '0x10000', placeholder: '0x10000 для приложения, 0x0 для полного образа' });
      if (!addr) return;
      const tool = (await hasTool('esptool')) ? 'esptool' : (await hasTool('esptool.py')) ? 'esptool.py' : null;
      if (!tool) { notify('esptool не найден: pip install esptool', { kind: 'warn' }); return; }
      await disconnect();
      await fw(tool, ['--port', portSel.value, 'write_flash', addr, file]);
    } }, 'esptool: записать .bin'),
    h('button.btn', { title: 'Прошивка по Wi-Fi: плата находится по mDNS (arduino-cli)', onclick: () => void ota() }, 'OTA по Wi-Fi'));

  const un = on<{ id: string; data: string; dropped?: number }>('serial-data', (p) => { if (p.id === id) onData(p.data, p.dropped ?? 0); });
  const unExit = on<{ id: string; error: string | null }>('serial-exit', (p) => {
    if (p.id !== id || !connected) return;
    connected = false;
    connectBtn.textContent = 'Подключить';
    status.textContent = p.error ? `порт закрыт: ${p.error}` : 'не подключено';
  });
  const ro = new ResizeObserver(() => plot.draw());
  ro.observe(plot.canvas);

  host.append(h('div.serial',
    null,
    h('div.serial-bar', null, portSel, h('button.btn', { title: 'Обновить список портов', onclick: () => void refreshPorts() }, '↻'), baudSel, connectBtn,
      h('button.btn', { onclick: () => { lines.length = 0; carry = ''; logEl.textContent = ''; plot.clear(); } }, 'Очистить'), status),
    fwBar,
    h('div.serial-bar', null, h('b.small', null, 'Декодер падений'), elfInput, h('button.btn', { onclick: async () => { const { open } = await import('@tauri-apps/plugin-dialog'); const f = await open({ multiple: false, title: 'Файл .elf', filters: [{ name: 'elf', extensions: ['elf'] }] }); if (typeof f === 'string') { elfInput.value = f; localStorage.setItem('lumen.serial.elf', f); } } }, 'Обзор…'),
      h('button.btn', { title: 'Вставьте строку Backtrace из лога', onclick: async () => { const t = await inputBox({ title: 'Строка Backtrace или адреса', placeholder: 'Backtrace: 0x400d1234:0x3ffb1f50 …' }); const a = t ? crashAddresses(t.includes('Backtrace') ? t : `Backtrace: ${t}`) : []; if (a.length) void decode(a, 'Ручная расшифровка'); } }, 'Вставить адреса')),
    crashBox,
    h('div.serial-body', null, h('div.serial-col', null, logEl, h('div.serial-bar', null, input, eolSel)), plot.canvas)));
  void refreshPorts();

  return () => {
    clearInterval(tick);
    ro.disconnect();
    void un.then((f) => f());
    void unExit.then((f) => f());
    void ipc.serialClose(id).catch(() => undefined);
  };
}

export function registerSerial(): void {
  commands.register({
    id: 'serial.open', title: 'Микроконтроллеры: монитор порта, плоттер и прошивка', category: 'Устройства',
    run: () => editors.openView({ key: 'serial-monitor', title: 'Монитор порта', icon: 'terminal', render }),
  });
}
