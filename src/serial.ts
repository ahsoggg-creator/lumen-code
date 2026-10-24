import { app } from './app';
import { commands } from './commands';
import { editors } from './editor';
import { errText, ipc, on } from './ipc';
import { log, revealChannel } from './panels';
import { parsePlot } from './plot';
import { runTask } from './tasks';
import { hasTool } from './toolchains';
import { notify, inputBox } from './ui';
import { dirname, h, uid } from './util';

const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];
const COLORS = ['#f38ba8', '#a6e3a1', '#89b4fa', '#f9e2af', '#cba6f7', '#94e2d5', '#fab387', '#f5c2e7'];
const MAX_POINTS = 600;
const MAX_LOG = 3000;
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

  function onData(data: string): void {
    const text = carry + data;
    const parts = text.split(/\r?\n/);
    carry = parts.pop() ?? '';
    for (const l of parts) { lines.push(l); plot.push(l); }
    if (lines.length > MAX_LOG) lines.splice(0, lines.length - MAX_LOG);
    dirty = true;
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
    log(CHANNEL, `> ${program} ${args.join(' ')}`);
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
    } }, 'esptool: записать .bin'));

  const un = on<{ id: string; data: string }>('serial-data', (p) => { if (p.id === id) onData(p.data); });
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
