import { commands } from './commands';
import { docs, editors, type Doc } from './editor';
import { errText, ipc } from './ipc';
import { cfg } from './settings';
import { sensitivePath } from './trust';
import { confirmDialog, notify, quickPick, type PickItem } from './ui';
import { basename } from './util';

const PAUSE_MS = 15000;
const timers = new Map<string, number>();

const store = (d: Doc): void => {
  // Secrets and big files never reach the (unencrypted) history; the backend applies the same rule.
  if (!d.path || !cfg('history.enabled') || sensitivePath(d.path) || d.model.getValueLength() > 5 * 1024 * 1024) return;
  void ipc.historySave(d.path, d.model.getValue()).catch(() => undefined);
};

const when = (ts: number): string => new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const kb = (n: number): string => (n < 1024 ? `${n} Б` : `${(n / 1024).toFixed(1)} КБ`);

async function pickVersion(doc: Doc): Promise<{ id: number; text: string; ts: number } | undefined> {
  const list = await ipc.historyList(doc.path!);
  if (!list.length) { notify('Для этого файла пока нет сохранённых версий', { kind: 'warn' }); return; }
  const items: PickItem<number>[] = list.map((v, i) => ({ label: when(v.ts), description: kb(v.size), detail: i === 0 ? 'последняя сохранённая версия' : undefined, value: v.id }));
  const hit = await quickPick(items, { placeholder: `История ${doc.name}: выберите версию` });
  if (!hit) return;
  const v = list.find((x) => x.id === hit.value)!;
  return { id: v.id, ts: v.ts, text: await ipc.historyGet(v.id) };
}

function activeSavedDoc(): Doc | null {
  const d = editors.activeDoc();
  if (!d?.path) { notify('Откройте сохранённый файл', { kind: 'warn' }); return null; }
  return d;
}

export function registerHistory(): void {
  docs.onSave.on(store);
  docs.onChange.on((d) => {
    if (!d.path) return;
    clearTimeout(timers.get(d.id));
    timers.set(d.id, window.setTimeout(() => store(d), PAUSE_MS));
  });
  docs.onClose.on((d) => { clearTimeout(timers.get(d.id)); timers.delete(d.id); });

  commands.register({
    id: 'history.show', title: 'Машина времени: сравнить с прошлой версией файла…', category: 'Файл',
    run: async () => {
      const doc = activeSavedDoc();
      if (!doc) return;
      try {
        const v = await pickVersion(doc);
        if (v) editors.openDiff({ key: `${doc.path}:history:${v.id}`, title: `${basename(doc.path!)} · ${when(v.ts)}`, original: v.text, modifiedDoc: doc, language: doc.model.getLanguageId(), path: doc.path! });
      } catch (e) { notify(errText(e), { kind: 'error' }); }
    },
  });
  commands.register({
    id: 'history.restore', title: 'Машина времени: вернуть прошлую версию файла…', category: 'Файл',
    run: async () => {
      const doc = activeSavedDoc();
      if (!doc) return;
      try {
        const v = await pickVersion(doc);
        if (!v) return;
        store(doc); // keep what is being replaced
        doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: v.text }], () => null);
        notify(`Версия от ${when(v.ts)} возвращена (Ctrl+Z отменит)`);
      } catch (e) { notify(errText(e), { kind: 'error' }); }
    },
  });
  commands.register({
    id: 'history.clearFile', title: 'Машина времени: очистить историю этого файла', category: 'Файл',
    run: async () => {
      const doc = activeSavedDoc();
      if (!doc || !(await confirmDialog('Очистить историю', `Удалить все сохранённые версии «${doc.name}»? Это нельзя отменить.`, 'Очистить', true))) return;
      try { notify(`Удалено версий: ${await ipc.historyClear(doc.path!)}`); } catch (e) { notify(errText(e), { kind: 'error' }); }
    },
  });
  commands.register({
    id: 'history.clearAll', title: 'Машина времени: очистить всю историю', category: 'Файл',
    run: async () => {
      if (!(await confirmDialog('Очистить всю историю', 'Удалить сохранённые версии всех файлов? Это нельзя отменить.', 'Очистить всё', true))) return;
      try { notify(`Удалено версий: ${await ipc.historyClearAll()}`); } catch (e) { notify(errText(e), { kind: 'error' }); }
    },
  });
}
