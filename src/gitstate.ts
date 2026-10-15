import type { GitStatus } from './ipc';
import { Emitter, key, norm } from './util';

export interface Deco { letter: string; cls: string; title: string }

class GitState {
  status: GitStatus | null = null;
  readonly changed = new Emitter<void>();
  private map = new Map<string, Deco>();
  private dirs = new Map<string, Deco>();

  set(s: GitStatus | null): void {
    this.status = s?.is_repo ? s : null;
    this.map.clear();
    this.dirs.clear();
    if (this.status) {
      const root = norm(this.status.root);
      for (const f of this.status.files) {
        const abs = `${root}\\${f.path.replace(/\//g, '\\')}`;
        const d = decoOf(f.index, f.work);
        this.map.set(key(abs), d);
        let dir = abs;
        for (;;) {
          const i = dir.lastIndexOf('\\');
          if (i <= root.length) break;
          dir = dir.slice(0, i);
          if (!this.dirs.has(key(dir))) this.dirs.set(key(dir), { letter: '', cls: 'git-dir', title: 'Содержит изменения' });
        }
      }
    }
    this.changed.fire();
  }

  deco(path: string, isDir: boolean): Deco | null {
    return (isDir ? this.dirs.get(key(path)) : this.map.get(key(path))) ?? null;
  }
}

function decoOf(x: string, y: string): Deco {
  if (x === '?' && y === '?') return { letter: 'U', cls: 'git-new', title: 'Не отслеживается' };
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return { letter: '!', cls: 'git-conflict', title: 'Конфликт' };
  if (x === 'D' || y === 'D') return { letter: 'D', cls: 'git-del', title: 'Удалён' };
  if (x === 'A') return { letter: 'A', cls: 'git-new', title: 'Добавлен' };
  if (x === 'R') return { letter: 'R', cls: 'git-mod', title: 'Переименован' };
  return { letter: 'M', cls: 'git-mod', title: 'Изменён' };
}

export const gitState = new GitState();
