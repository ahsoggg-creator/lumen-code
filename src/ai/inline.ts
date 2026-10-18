import { monaco } from '../app';
import { commands } from '../commands';
import { editors } from '../editor';
import { errText } from '../ipc';
import { inputBox, notify } from '../ui';
import { AbortHandle, activeProvider, streamChat } from './core';

const SYSTEM = 'You edit code. Apply the instruction to the given code and reply with ONLY the new code that replaces it, with no explanations and no markdown fences. Keep the indentation style and line endings of the original.';

/** Models like to wrap the answer in a fence even when told not to. */
export function stripFence(s: string): string {
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(s);
  return m ? m[1]! : s;
}

/** Ctrl+K I: rewrite the selection (or the current line) from an instruction; the result stays until accepted or rejected. */
export async function inlineEdit(): Promise<void> {
  const { editor, doc } = editors.active();
  if (!editor || !doc) { notify('Откройте файл, который нужно изменить', { kind: 'warn' }); return; }
  const p = activeProvider();
  if (!p) { notify('Сначала добавьте ИИ-провайдера (ИИ: настроить провайдеров)', { kind: 'warn' }); return; }
  const mo = monaco();
  let sel = editor.getSelection();
  if (!sel || sel.isEmpty()) {
    const line = editor.getPosition()?.lineNumber ?? 1;
    sel = new mo.Selection(line, 1, line, doc.model.getLineMaxColumn(line));
  }
  const instruction = await inputBox({ title: 'Что сделать с выделенным кодом?', placeholder: 'например: добавь обработку ошибок' });
  if (!instruction?.trim()) return;

  const original = doc.model.getValueInRange(sel);
  const range = sel;
  const abort = new AbortHandle();
  const toast = notify('ИИ правит код…', { timeout: 0, actions: [{ label: 'Отмена', run: () => abort.abort() }] });
  let out: string;
  try {
    const res = await streamChat(p, SYSTEM, [{ role: 'user', text: `Instruction: ${instruction.trim()}\nLanguage: ${doc.model.getLanguageId()}\n\nCode:\n${original}` }], [], {}, abort);
    out = stripFence(res.text).replace(/\r?\n/g, doc.model.getEOL());
  } catch (e) {
    toast.close();
    if (!abort.aborted) notify(`ИИ не ответил: ${errText(e)}`, { kind: 'error' });
    return;
  }
  toast.close();
  if (abort.aborted || !out.trim()) return;

  const before = doc.model.getAlternativeVersionId();
  editor.executeEdits('lumen-ai', [{ range, text: out }]);
  const end = doc.model.getPositionAt(doc.model.getOffsetAt(range.getStartPosition()) + out.length);
  const deco = editor.createDecorationsCollection([{ range: new mo.Range(range.startLineNumber, 1, end.lineNumber, 1), options: { isWholeLine: true, className: 'ai-inline-change' } }]);
  editor.revealRangeInCenterIfOutsideViewport(new mo.Range(range.startLineNumber, 1, end.lineNumber, 1));
  const done = (): void => { deco.clear(); t.close(); };
  const t = notify('Правка ИИ применена. Принять изменения?', {
    timeout: 0,
    actions: [
      { label: 'Принять', run: done },
      { label: 'Отклонить', run: () => {
        // Back to the original text, but only when nothing else was typed in the meantime.
        if (doc.model.getAlternativeVersionId() === before + 1) editor.trigger('lumen-ai', 'undo', null);
        else editor.executeEdits('lumen-ai', [{ range: new mo.Range(range.startLineNumber, 1, end.lineNumber, doc.model.getLineMaxColumn(end.lineNumber)), text: original }]);
        done();
      } },
    ],
  });
}

export function registerInlineEdit(): void {
  commands.register({ id: 'ai.inlineEdit', title: 'ИИ: изменить выделенный код по инструкции', category: 'ИИ', keybinding: 'ctrl+k ctrl+i', run: () => inlineEdit() });
}
