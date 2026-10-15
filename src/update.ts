import { app } from './app';
import { commands } from './commands';
import { errText, ipc, on, type Release } from './ipc';
import { renderMarkdown } from './md';
import { log } from './panels';
import { cfg } from './settings';
import { shell } from './shell';
import { dialog, notify } from './ui';
import { fmtSize, h } from './util';

let available: Release | null = null;
let item: ReturnType<typeof shell.statusItem> | null = null;
let installing = false;

export async function checkForUpdates(interactive: boolean): Promise<void> {
  const toast = interactive ? notify('Проверяю обновления…', { timeout: 0 }) : null;
  try {
    const rel = await ipc.updateCheck();
    toast?.close();
    try { localStorage.setItem('lumen.lastUpdateCheck', String(Date.now())); } catch { /* ignore */ }
    if (!rel) {
      available = null;
      item?.update({ hidden: true });
      if (interactive) notify(`У вас последняя версия — ${app.version}`);
      return;
    }
    available = rel;
    item?.update({ text: `Обновление ${rel.version}`, tooltip: 'Доступна новая версия — нажмите, чтобы установить', hidden: false, color: 'var(--green)' });
    log('Lumen Code', `Доступна версия ${rel.version}`);
    if (interactive) await offer(rel);
    else notify(`Доступна версия ${rel.version}`, { actions: [{ label: 'Подробнее…', run: () => void offer(rel) }], timeout: 0 });
  } catch (e) {
    toast?.close();
    if (interactive) notify(`Не удалось проверить обновления: ${errText(e)}`, { kind: 'error' });
    else log('Lumen Code', `Проверка обновлений не удалась: ${errText(e)}`);
  }
}

async function offer(rel: Release): Promise<void> {
  const notes = h('div.md.update-notes');
  notes.innerHTML = rel.notes ? renderMarkdown(rel.notes) : '<p class="dim">Описание не указано.</p>';
  const body = h('div', null, h('div', null, `Текущая версия: ${app.version} → новая: `, h('b', null, rel.version), rel.size ? h('span.dim', null, ` (${fmtSize(rel.size)})`) : null), notes);
  const r = await dialog('Доступно обновление', body, [{ label: 'Позже' }, { label: 'Страница релиза' }, { label: 'Скачать и установить', primary: true }]);
  if (r === 1) void ipc.openUrl(rel.page || `https://github.com/ahsoggg-creator/lumen-code/releases/tag/${rel.tag}`);
  else if (r === 2) await install(rel);
}

async function install(rel: Release): Promise<void> {
  if (installing) return;
  installing = true;
  const toast = notify(`Скачиваю ${rel.version}…`, { timeout: 0, progress: true });
  const un = await on<{ done: number; total: number; verifying?: boolean }>('update-progress', (p) => {
    if (p.verifying) toast.update('Проверяю контрольную сумму…', 1);
    else toast.update(`Скачиваю ${rel.version}… ${fmtSize(p.done)}${p.total ? ` из ${fmtSize(p.total)}` : ''}`, p.total ? p.done / p.total : undefined);
  });
  try {
    await ipc.updateInstall(rel);
    toast.update('Устанавливаю и перезапускаю…', 1);
  } catch (e) {
    toast.close();
    notify(`Обновление не удалось: ${errText(e)}`, { kind: 'error', timeout: 12000 });
  } finally {
    un();
    installing = false;
  }
}

export function registerUpdates(): void {
  item = shell.statusItem({ id: 'update', align: 'right', priority: 5, icon: 'download', text: '', onClick: () => { if (available) void offer(available); } });
  item.update({ hidden: true });
  commands.register({ id: 'help.checkUpdates', title: 'Справка: проверить обновления…', category: 'Справка', run: () => checkForUpdates(true) });
  const last = Number(localStorage.getItem('lumen.lastUpdateCheck') ?? 0);
  if (cfg('update.check') === 'startup' && Date.now() - last > 24 * 3600 * 1000) setTimeout(() => void checkForUpdates(false), 8000);
}
