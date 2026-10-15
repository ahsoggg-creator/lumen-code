import { getCurrentWebview } from '@tauri-apps/api/webview';
import { app, monaco, monacoLoaded } from './app';
import { ipc } from './ipc';
import { settings, cfg } from './settings';
import { shell } from './shell';
import { cssVars, findTheme, monacoTheme } from './themes';
import { h, join } from './util';

let customStyle: HTMLStyleElement | null = null;
let lastZoom = 1;
let appliedVars: string[] = [];

export async function loadCustomCss(): Promise<void> {
  customStyle ??= document.head.appendChild(h('style', { id: 'custom-css' }));
  try { customStyle.textContent = (await ipc.readFile(join(app.paths.config, 'custom.css'))).content; } catch { customStyle.textContent = ''; }
}

export function applyAppearance(): void {
  const th = findTheme(cfg('workbench.theme'));
  const accent = cfg<string>('workbench.accent');
  const root = document.documentElement;
  const vars = { ...cssVars(th, accent), ...(cfg<Record<string, string>>('workbench.colors') ?? {}) };
  for (const k of appliedVars) if (!(k in vars)) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  appliedVars = Object.keys(vars);
  root.style.setProperty('--ui-font', cfg('workbench.uiFont'));
  root.style.setProperty('--ui-size', `${cfg<number>('workbench.uiFontSize')}px`);
  root.style.setProperty('--radius', `${cfg<number>('workbench.borderRadius')}px`);
  root.style.setProperty('--mono', cfg('editor.fontFamily'));
  root.dataset.theme = th.dark ? 'dark' : 'light';
  root.classList.toggle('no-anim', !cfg('workbench.animations'));
  document.body.style.colorScheme = th.dark ? 'dark' : 'light';
  if (monacoLoaded()) {
    const mo = monaco();
    mo.editor.defineTheme('lumen', monacoTheme(th, accent, cfg<Record<string, string>>('workbench.editorColors') ?? {}));
    mo.editor.setTheme('lumen');
  }
  const zoom = cfg<number>('workbench.uiScale');
  if (zoom !== lastZoom) {
    lastZoom = zoom;
    void getCurrentWebview().setZoom(zoom).catch(() => undefined);
  }
  shell.applyLayout();
}

export function installSettingsSchema(): void {
  const mo = monaco();
  mo.json.jsonDefaults.setDiagnosticsOptions({
    validate: true, allowComments: true, trailingCommas: 'ignore',
    schemas: [{ uri: 'lumen://settings.schema.json', fileMatch: ['*/LumenCode/settings.json', '*/.lumen/settings.json'], schema: settings.jsonSchema() as never }],
  });
}
