import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface Entry { name: string; path: string; is_dir: boolean; size: number; mtime: number }
export interface FileData { content: string; encoding: string; binary: boolean; size: number; mtime: number; eol: string }
export interface Paths { config: string; plugins: string; home: string; args: string[] }
export interface ExecOut { code: number; stdout: string; stderr: string }
export interface GitFile { path: string; index: string; work: string; orig: string | null }
export interface GitStatus { is_repo: boolean; root: string; branch: string; upstream: string | null; ahead: number; behind: number; files: GitFile[] }
export interface Hunk { start: number; count: number; kind: 'added' | 'modified' | 'deleted' }
export interface Commit { hash: string; author: string; date: string; subject: string }
export interface SearchOpts { root: string; query: string; regex: boolean; case: boolean; word: boolean; include: string[]; exclude: string[]; max_results?: number }
export interface SearchMatch { line: number; col: number; len: number; text: string }
export interface FileMatches { path: string; matches: SearchMatch[] }
export interface SearchResult { files: FileMatches[]; truncated: boolean }
export interface Interp { path: string; version: string; kind: string; is_venv: boolean }
export interface PypiInfo { name: string; version: string; summary: string; home: string; requires_python: string }
export interface Release { tag: string; version: string; notes: string; exe_url: string; sums_url: string; size: number; page: string }
export interface HttpReq { url: string; method?: string; headers?: Record<string, string>; body?: string }

export const ipc = {
  paths: () => invoke<Paths>('get_paths'),
  ready: () => invoke<void>('app_ready'),
  readDir: (path: string) => invoke<Entry[]>('read_dir', { path }),
  readFile: (path: string, encoding?: string) => invoke<FileData>('read_file', { path, encoding: encoding ?? null }),
  readB64: (path: string) => invoke<string>('read_file_b64', { path }),
  writeFile: (path: string, content: string, encoding?: string) => invoke<number>('write_file', { path, content, encoding: encoding ?? null }),
  mkdir: (path: string) => invoke<void>('create_dir', { path }),
  rename: (from: string, to: string) => invoke<void>('rename_path', { from, to }),
  remove: (path: string, permanent = false) => invoke<void>('delete_path', { path, permanent }),
  copy: (from: string, to: string) => invoke<void>('copy_path', { from, to }),
  exists: (path: string) => invoke<boolean>('path_exists', { path }),
  realPath: (path: string) => invoke<string>('real_path', { path }),
  reveal: (path: string) => invoke<void>('reveal_in_explorer', { path }),
  vsixInstall: (source: string, destRoot: string) => invoke<{ dir: string; id: string; version: string }>('vsix_install', { source, destRoot }),
  assocStatus: (exts: string[]) => invoke<{ exts: string[]; context_menu: boolean; registered: boolean }>('assoc_status', { exts }),
  assocApply: (exts: string[], allKnown: string[], contextMenu: boolean) => invoke<void>('assoc_apply', { exts, allKnown, contextMenu }),
  assocRemoveAll: (allKnown: string[]) => invoke<void>('assoc_remove_all', { allKnown }),
  openDefaultApps: () => invoke<void>('open_default_apps'),
  openPath: (path: string) => invoke<void>('open_path', { path }),
  refreshEnv: () => invoke<void>('refresh_env'),
  freePort: () => invoke<number>('free_port'),
  dapConnect: (id: string, host: string, port: number, timeoutMs: number) => invoke<void>('dap_connect', { id, host, port, timeoutMs }),
  dapSpawn: (id: string, program: string, args: string[], cwd?: string) => invoke<void>('dap_spawn', { id, program, args, cwd: cwd ?? null }),
  dapSend: (id: string, msg: string) => invoke<void>('dap_send', { id, msg }),
  dapClose: (id: string) => invoke<void>('dap_close', { id }),
  lspSpawn: (id: string, program: string, args: string[], cwd?: string) => invoke<void>('lsp_spawn', { id, program, args, cwd: cwd ?? null }),
  lspSend: (id: string, msg: string) => invoke<void>('lsp_send', { id, msg }),
  lspClose: (id: string) => invoke<void>('lsp_close', { id }),
  mcpSpawn: (id: string, program: string, args: string[], cwd?: string, env?: Record<string, string>) => invoke<void>('mcp_spawn', { id, program, args, cwd: cwd ?? null, env: env ?? null }),
  mcpSend: (id: string, msg: string) => invoke<void>('mcp_send', { id, msg }),
  mcpClose: (id: string) => invoke<void>('mcp_close', { id }),
  openUrl: (url: string) => invoke<void>('open_external', { url }),
  search: (opts: SearchOpts) => invoke<SearchResult>('search_text', { opts }),
  replaceIn: (opts: SearchOpts, replacement: string, files: string[]) => invoke<number>('replace_in_files', { opts, replacement, files }),
  listFiles: (root: string, limit?: number) => invoke<string[]>('list_files', { root, limit: limit ?? null }),
  gitStatus: (cwd: string) => invoke<GitStatus>('git_status', { cwd }),
  gitShow: (root: string, path: string, rev: string) => invoke<string>('git_show', { root, path, rev }),
  gitHunks: (root: string, path: string) => invoke<Hunk[]>('git_diff_hunks', { root, path }),
  gitLog: (root: string, limit: number, path?: string) => invoke<Commit[]>('git_log', { root, limit, path: path ?? null }),
  git: (cwd: string, args: string[]) => invoke<ExecOut>('git_exec', { cwd, args }),
  termOpen: (a: { program: string; args: string[]; cwd: string; cols: number; rows: number; env: Record<string, string>; pathPrepend: string[] }) =>
    invoke<number>('term_open', { program: a.program, args: a.args, cwd: a.cwd, cols: a.cols, rows: a.rows, env: a.env, pathPrepend: a.pathPrepend }),
  termWrite: (id: number, data: string) => invoke<void>('term_write', { id, data }),
  termResize: (id: number, cols: number, rows: number) => invoke<void>('term_resize', { id, cols, rows }),
  termClose: (id: number) => invoke<void>('term_close', { id }),
  exec: (program: string, args: string[], cwd?: string, timeoutMs?: number, env?: Record<string, string>) =>
    invoke<ExecOut>('exec_capture', { program, args, cwd: cwd ?? null, env: env ?? null, timeoutMs: timeoutMs ?? null }),
  taskSpawn: (id: string, program: string, args: string[], cwd?: string, env?: Record<string, string>) =>
    invoke<void>('task_spawn', { id, program, args, cwd: cwd ?? null, env: env ?? null }),
  taskKill: (id: string) => invoke<void>('task_kill', { id }),
  taskForget: (id: string) => invoke<void>('task_forget', { id }),
  pyDiscover: (workspace?: string) => invoke<Interp[]>('py_discover', { workspace: workspace ?? null }),
  pypiInfo: (name: string) => invoke<PypiInfo>('pypi_info', { name }),
  http: (req: HttpReq) => invoke<{ status: number; body: string }>('http_request', { req }),
  httpStream: (id: string, req: HttpReq) => invoke<void>('http_stream', { id, req }),
  httpCancel: (id: string) => invoke<void>('http_cancel', { id }),
  secretSet: (name: string, value: string) => invoke<void>('secret_set', { name, value }),
  secretGet: (name: string) => invoke<string | null>('secret_get', { name }),
  secretDelete: (name: string) => invoke<void>('secret_delete', { name }),
  version: () => invoke<string>('app_version'),
  updateCheck: () => invoke<Release | null>('update_check'),
  updateInstall: (release: Release) => invoke<void>('update_install', { release }),
  watch: (root: string | null) => invoke<void>('watch_root', { root }),
};

export function on<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload));
}

export function errText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
