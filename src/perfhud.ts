import { ipc } from './ipc';
import { shell } from './shell';

const POLL_MS = 250;
const GIVE_UP_MS = 8000;
const IDLE_SAMPLES = 3;
const SPARK = '▁▂▃▄▅▆▇█';

let item: ReturnType<typeof shell.statusItem> | null = null;
let stop: (() => void) | null = null;
let hideTimer = 0;

/** Text sparkline of the last samples (0–100 %). */
export const spark = (values: number[]): string => values.slice(-12).map((v) => SPARK[Math.min(7, Math.max(0, Math.floor((v / 100) * 8)))]!).join('');

const fmtTime = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} мс` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} с`);

/**
 * Watches what the terminal's shell started (the program Run launched): live memory and CPU in the status bar,
 * then the total time and peak memory. Sampled every 250 ms, so a time is accurate to about a quarter of a second.
 */
export function monitorRun(ptyId: number): void {
  stop?.();
  clearTimeout(hideTimer);
  item ??= shell.statusItem({ id: 'perf', align: 'right', priority: 60, text: '', tooltip: 'Потребление ресурсов запущенной программы (память / процессор)' });
  item.update({ hidden: false, text: '▶ запуск…', color: '' });

  const t0 = performance.now();
  let started = 0;
  let last = 0;
  let idle = 0;
  let peak = 0;
  let cpuSum = 0;
  let samples = 0;
  const cpuHist: number[] = [];
  let busy = false;
  let dead = false;

  const finish = (text: string, color = ''): void => {
    clearInterval(timer);
    item?.update({ text, color });
    hideTimer = window.setTimeout(() => item?.update({ hidden: true }), 20000);
  };

  const tick = async (): Promise<void> => {
    if (busy || dead) return;
    busy = true;
    try {
      const now = performance.now();
      const s = await ipc.termStats(ptyId).catch(() => null);
      if (dead) return;
      if (!s) { finish('', ''); item?.update({ hidden: true }); return; }
      if (s.running) {
        if (!started) started = now;
        last = now;
        idle = 0;
        peak = Math.max(peak, s.mem_mb);
        cpuSum += s.cpu;
        samples++;
        cpuHist.push(s.cpu);
        item?.update({ text: `▶ ${fmtTime(now - started)} · ${s.mem_mb.toFixed(0)} МБ · ${s.cpu.toFixed(0)}% CPU ${spark(cpuHist)}` });
      } else if (started) {
        if (++idle >= IDLE_SAMPLES) finish(`✔ ${fmtTime(last - started + POLL_MS / 2)} · пик ${peak.toFixed(0)} МБ · CPU ср. ${(cpuSum / Math.max(1, samples)).toFixed(0)}% ${spark(cpuHist)}`, 'var(--green, #a6e3a1)');
      } else if (now - t0 > GIVE_UP_MS) {
        finish('', '');
        item?.update({ hidden: true });
      }
    } finally { busy = false; }
  };
  const timer = window.setInterval(() => void tick(), POLL_MS);
  stop = () => { dead = true; clearInterval(timer); };
}
