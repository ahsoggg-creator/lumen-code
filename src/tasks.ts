import { ipc, on } from './ipc';
import { uid } from './util';

interface Handler { onLine?: (line: string, stream: 'stdout' | 'stderr') => void; resolve: (code: number) => void }
const handlers = new Map<string, Handler>();
let inited = false;

export function initTasks(): void {
  if (inited) return;
  inited = true;
  void on<{ id: string; stream: 'stdout' | 'stderr'; line: string }>('task-output', (p) => handlers.get(p.id)?.onLine?.(p.line, p.stream));
  void on<{ id: string; code: number }>('task-exit', (p) => {
    const h = handlers.get(p.id);
    handlers.delete(p.id);
    h?.resolve(p.code);
    void ipc.taskForget(p.id);
  });
}

export interface RunningTask { id: string; done: Promise<number>; kill(): void }

/** Starts a program and streams its output line by line; `done` resolves with the exit code (-1 on spawn failure). */
export function runTask(program: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; onLine?: Handler['onLine'] } = {}): RunningTask {
  initTasks();
  const id = uid('task');
  const done = new Promise<number>((resolve) => {
    handlers.set(id, { onLine: opts.onLine, resolve });
    ipc.taskSpawn(id, program, args, opts.cwd, opts.env).catch((e) => {
      handlers.delete(id);
      opts.onLine?.(String(e), 'stderr');
      resolve(-1);
    });
  });
  return { id, done, kill: () => void ipc.taskKill(id) };
}
