import type * as M from 'monaco-editor';
import type { Paths } from './ipc';
import { Emitter } from './util';

export type Monaco = typeof M;
let mon: Monaco | null = null;
export const monaco = (): Monaco => {
  if (!mon) throw new Error('Monaco is not loaded yet');
  return mon;
};
export const setMonaco = (m: Monaco): void => { mon = m; };
export const monacoLoaded = (): boolean => mon !== null;

/** Global app state shared between modules. */
export const app = {
  paths: { config: '', plugins: '', home: '', args: [] } as Paths,
  version: '0.0.0',
  root: null as string | null,
  rootChanged: new Emitter<string | null>(),
  fsChanged: new Emitter<string[]>(),
  /** Fired when the extension host or a view asks something to be revealed in the explorer. */
  revealRequest: new Emitter<string>(),
  focusTerminal: false,
};
