import { commands } from '../commands';
import { cfg } from '../settings';
import { revealChannel } from '../panels';
import { mergeServers, serverForLanguage, type ServerOverride } from './servers';

/** Wires the language-server support. The heavy part (`manager`) is loaded when the first file that has a server is opened. */
export async function registerLsp(): Promise<void> {
  const { editors, docs } = await import('../editor');
  let loading: Promise<void> | null = null;
  const wanted = (lang: string): boolean => cfg<boolean>('lsp.enabled') && !!serverForLanguage(mergeServers(cfg<Record<string, ServerOverride>>('lsp.servers')), lang);
  const load = (): Promise<void> => (loading ??= import('./manager').then((m) => m.startManager()));

  const check = (d: { path: string | null; model: { getLanguageId(): string } }): void => { if (d.path && wanted(d.model.getLanguageId())) void load(); };
  docs.onOpen.on(check);
  docs.all().forEach(check);

  commands.register({ id: 'lsp.restart', title: 'LSP: перезапустить языковые серверы', category: 'Языки', run: async () => { await load(); await (await import('./manager')).restart(); } });
  commands.register({ id: 'lsp.showLog', title: 'LSP: показать журнал', category: 'Языки', run: () => {
    const d = editors.activeDoc();
    const def = d ? serverForLanguage(mergeServers(cfg<Record<string, ServerOverride>>('lsp.servers')), d.model.getLanguageId()) : undefined;
    revealChannel(def ? `LSP: ${def.name}` : 'Lumen Code');
  } });
}
