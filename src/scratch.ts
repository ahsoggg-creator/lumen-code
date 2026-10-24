import type * as M from 'monaco-editor';
import { app, monaco } from './app';
import { commands } from './commands';
import { docs, editors } from './editor';
import { errText, ipc } from './ipc';
import { settings } from './settings';
import { shell } from './shell';
import { hasTool } from './toolchains';
import { confirmDialog, notify } from './ui';
import { dirname, join } from './util';
import { effectivePython } from './views/python';

/** Result of one run: text to show after a line, plus an error (shown at its line). */
export interface ScratchResult { lines: Map<number, string>; error: { line: number; message: string } | null }

const LANGS = ['python', 'javascript', 'typescript', 'lua'];
const TIMEOUT_MS = 4000;
const DELAY_MS = 600;
const MARK = '@@LUMEN@@';
const MEM_MB = 512;
let lastJob: string | null = null;
let jobSeq = 0;

// ------------------------------------------------------------------ runners

const WORKER_SRC = `
const fmt = (v) => {
  try {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'function') return 'ƒ ' + (v.name || '');
    if (v instanceof Error) return String(v);
    if (typeof v === 'object' && v !== null) return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x + 'n' : x));
    return String(v);
  } catch { return String(v); }
};
let logs = [], lastLine = 1;
self.__q = (line, name, v) => {
  lastLine = line;
  const parts = logs.splice(0);
  if (v !== undefined) parts.push(name ? name + ' = ' + fmt(v) : fmt(v));
  if (parts.length) postMessage({ line, text: parts.join('  ') });
  return v;
};
const mk = (p) => (...a) => { logs.push(p + a.map((x) => (typeof x === 'string' ? x : fmt(x))).join(' ')); };
self.console = { log: mk(''), info: mk(''), debug: mk(''), warn: mk('⚠ '), error: mk('✖ ') };
self.onmessage = async (e) => {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction(e.data)();
    if (logs.length) postMessage({ line: lastLine, text: logs.join('  ') });
    postMessage({ done: true });
  } catch (err) {
    const m = /<anonymous>:(\\d+):\\d+/.exec(String(err && err.stack));
    postMessage({ done: true, error: { line: m ? Math.max(1, Number(m[1]) - 2) : lastLine, message: String(err) } });
  }
};
`;

async function transpileTs(src: string): Promise<string> {
  const mo = monaco();
  const uri = mo.Uri.parse(`file:///__scratch/run${Date.now()}.ts`);
  const model = mo.editor.createModel(src, 'typescript', uri);
  try {
    const worker = await (await mo.typescript.getTypeScriptWorker())(uri);
    const out = await worker.getEmitOutput(uri.toString());
    return out.outputFiles[0]?.text ?? '';
  } finally { model.dispose(); }
}

async function runJs(text: string, lang: string): Promise<ScratchResult> {
  let code = await ipc.scratchInstrument(text, lang);
  if (lang === 'typescript') code = await transpileTs(code);
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  const w = new Worker(url);
  const res: ScratchResult = { lines: new Map(), error: null };
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { res.error = { line: 1, message: `время выполнения вышло (${TIMEOUT_MS / 1000} с)` }; resolve(); }, TIMEOUT_MS);
      w.onmessage = (e: MessageEvent<{ line?: number; text?: string; done?: boolean; error?: ScratchResult['error'] }>) => {
        const d = e.data;
        if (d.text !== undefined && d.line !== undefined) res.lines.set(d.line, d.text);
        if (d.done) { clearTimeout(timer); res.error = d.error ?? null; resolve(); }
      };
      w.onerror = (e) => { clearTimeout(timer); res.error = { line: 1, message: e.message }; resolve(); };
      w.postMessage(code);
    });
  } finally { w.terminate(); URL.revokeObjectURL(url); }
  return res;
}

const PY_RUNNER = String.raw`import sys, os, json, types
src_path, real = sys.argv[1], sys.argv[2]
code = open(src_path, encoding="utf-8").read()
sys.path.insert(0, os.getcwd())
res = {}
cur = [0]
prev = {}
def fmt(v):
    try:
        s = repr(v)
    except Exception:
        s = "<?>"
    return s if len(s) < 140 else s[:137] + "..."
def slot(n):
    return res.setdefault(n, {"val": "", "out": []})
class Out:
    def write(self, s):
        if s.strip():
            o = slot(cur[0])["out"]
            if len(o) < 5:
                o.append(s.rstrip())
        return len(s)
    def flush(self):
        pass
def flush(frame):
    global prev
    s = {k: fmt(v) for k, v in frame.f_locals.items() if not k.startswith("__") and not isinstance(v, (types.ModuleType, types.FunctionType, type))}
    if cur[0]:
        ch = [k + " = " + v for k, v in s.items() if prev.get(k) != v]
        if ch:
            slot(cur[0])["val"] = ", ".join(ch)
    prev = s
def local(frame, event, arg):
    if event == "line":
        flush(frame)
        cur[0] = frame.f_lineno
    elif event == "return":
        flush(frame)
    return local
def tracer(frame, event, arg):
    c = frame.f_code
    if c.co_filename == "<scratch>" and c.co_name == "<module>":
        return local
    return None
err = None
real_out, real_err = sys.stdout, sys.stderr
sys.stdout = sys.stderr = Out()
try:
    sys.settrace(tracer)
    exec(compile(code, "<scratch>", "exec"), {"__name__": "__main__", "__file__": real})
except SystemExit:
    pass
except BaseException as e:
    ln = None
    tb = e.__traceback__
    while tb:
        if tb.tb_frame.f_code.co_filename == "<scratch>":
            ln = tb.tb_lineno
        tb = tb.tb_next
    if ln is None and isinstance(e, SyntaxError):
        ln = e.lineno
    err = {"line": ln or cur[0] or 1, "message": type(e).__name__ + ": " + str(e)}
finally:
    sys.settrace(None)
    sys.stdout, sys.stderr = real_out, real_err
real_out.write("\n` + MARK + String.raw`" + json.dumps({"lines": {str(k): v for k, v in res.items()}, "error": err}))
`;

const LUA_RUNNER = String.raw`local path = arg[1]
local f = assert(io.open(path, "rb")); local code = f:read("a"); f:close()
local res, cur, prev = {}, 0, {}
local function fmt(v, d)
  d = d or 0
  local t = type(v)
  if t == "string" then return string.format("%q", v):gsub("\\\n", "\\n") end
  if t == "table" then
    if d > 1 then return "{…}" end
    local parts, n = {}, 0
    for k, x in pairs(v) do
      n = n + 1
      if n > 6 then parts[#parts + 1] = "…"; break end
      parts[#parts + 1] = (type(k) == "number" and "" or tostring(k) .. "=") .. fmt(x, d + 1)
    end
    return "{" .. table.concat(parts, ", ") .. "}"
  end
  return tostring(v)
end
local function slot(n) if not res[n] then res[n] = { val = "", out = {} } end return res[n] end
local env = setmetatable({}, { __index = _G })
env.print = function(...)
  local a = table.pack(...)
  for i = 1, a.n do a[i] = tostring(a[i]) end
  local o = slot(cur).out
  if #o < 5 then o[#o + 1] = table.concat(a, "\t") end
end
local function flush()
  local s = {}
  for k, v in pairs(env) do if type(v) ~= "function" and k ~= "print" then s[tostring(k)] = fmt(v) end end
  local i = 1
  while true do
    local n, v = debug.getlocal(3, i)
    if not n then break end
    if n:sub(1, 1) ~= "(" and type(v) ~= "function" then s[n] = fmt(v) end
    i = i + 1
  end
  if cur > 0 then
    local ch = {}
    for k, v in pairs(s) do if prev[k] ~= v then ch[#ch + 1] = k .. " = " .. v end end
    table.sort(ch)
    if #ch > 0 then slot(cur).val = table.concat(ch, ", ") end
  end
  prev = s
end
local function hook(ev, line)
  local info = debug.getinfo(2, "S")
  if info.source ~= "=scratch" or info.what ~= "main" then return end
  if ev == "line" then flush(); cur = line else flush() end
end
local chunk, cerr = load(code, "=scratch", "t", env)
local err
if not chunk then
  err = cerr
else
  debug.sethook(hook, "lr")
  local ok, e = pcall(chunk)
  debug.sethook()
  if not ok then err = tostring(e) end
end
local function esc(s) return '"' .. s:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"' end
local parts = {}
for n, v in pairs(res) do
  local o = {}
  for _, x in ipairs(v.out) do o[#o + 1] = esc(x) end
  parts[#parts + 1] = string.format('"%d":{"val":%s,"out":[%s]}', n, esc(v.val), table.concat(o, ","))
end
local errj = "null"
if err then
  local line = tonumber(err:match("^scratch:(%d+):")) or (cur > 0 and cur) or 1
  errj = string.format('{"line":%d,"message":%s}', line, esc((err:gsub("^scratch:%d+: ", ""))))
end
io.stdout:write("\n` + MARK + String.raw`", '{"lines":{', table.concat(parts, ","), '},"error":', errj, "}")
`;

interface RawRun { lines: Record<string, { val: string; out: string[] }>; error: ScratchResult['error'] }

function fromRaw(raw: RawRun): ScratchResult {
  const lines = new Map<number, string>();
  for (const [k, v] of Object.entries(raw.lines)) {
    const text = [v.val, ...v.out].filter(Boolean).join('  ·  ');
    if (text) lines.set(Number(k), text);
  }
  return { lines, error: raw.error };
}

async function runExternal(program: string, runner: string, ext: string, text: string, realPath: string): Promise<ScratchResult> {
  const dir = join(app.paths.config, 'scratch');
  await ipc.mkdir(dir);
  const runnerPath = join(dir, `runner.${ext}`);
  await ipc.writeFile(runnerPath, runner);
  const codePath = join(dir, `code.${ext}`);
  await ipc.writeFile(codePath, text);
  const args = ext === 'py' ? ['-X', 'utf8', runnerPath, codePath, realPath] : [runnerPath, codePath];
  // A newer run replaces the previous one: its whole process tree is killed (Job Object), so typing never piles up processes.
  if (lastJob) void ipc.sandboxCancel(lastJob).catch(() => undefined);
  const job = `scratch-${++jobSeq}`;
  lastJob = job;
  const r = await ipc.sandboxRun(job, program, args, dirname(realPath), { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, TIMEOUT_MS, MEM_MB).catch((e) => ({ code: -1, stdout: '', stderr: errText(e) }));
  if (lastJob === job) lastJob = null;
  if (/\[cancelled\]/.test(r.stderr)) return { lines: new Map(), error: null };
  const at = r.stdout.lastIndexOf(MARK);
  if (at < 0) {
    const msg = /time|таймаут|превыш/i.test(r.stderr) ? `время выполнения вышло (${TIMEOUT_MS / 1000} с)` : (r.stderr.trim().split('\n').pop() || 'нет результата');
    return { lines: new Map(), error: { line: 1, message: msg } };
  }
  return fromRaw(JSON.parse(r.stdout.slice(at + MARK.length)) as RawRun);
}

async function runDoc(text: string, lang: string, path: string): Promise<ScratchResult> {
  if (lang === 'javascript' || lang === 'typescript') return runJs(text, lang);
  if (lang === 'python') return runExternal(await effectivePython(), PY_RUNNER, 'py', text, path);
  const lua = (await hasTool('lua')) ? 'lua' : (await hasTool('luajit')) ? 'luajit' : null;
  if (!lua) return { lines: new Map(), error: { line: 1, message: 'Lua не найден в PATH' } };
  return runExternal(lua, LUA_RUNNER, 'lua', text, path);
}

// ------------------------------------------------------------------ UI

const enabled = new Set<string>();
const results = new Map<string, ScratchResult>();
const hintsChanged = new (class { private fns: (() => void)[] = []; event = (fn: () => void) => { this.fns.push(fn); return { dispose: () => { this.fns = this.fns.filter((f) => f !== fn); } }; }; fire(): void { this.fns.forEach((f) => f()); } })();
const timers = new Map<string, number>();
let seq = 0;
let status: ReturnType<typeof shell.statusItem> | null = null;

const cut = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function refresh(docId: string): Promise<void> {
  const doc = docs.all().find((d) => d.id === docId);
  if (!doc || !enabled.has(docId)) return;
  const lang = doc.model.getLanguageId();
  const mine = ++seq;
  try {
    const r = await runDoc(doc.model.getValue(), lang, doc.path ?? join(app.root ?? app.paths.home, 'scratch.txt'));
    if (mine !== seq || !enabled.has(docId)) return;
    results.set(doc.model.uri.toString(), r);
  } catch (e) {
    results.set(doc.model.uri.toString(), { lines: new Map(), error: { line: 1, message: errText(e) } });
  }
  hintsChanged.fire();
}

function schedule(docId: string): void {
  clearTimeout(timers.get(docId));
  timers.set(docId, window.setTimeout(() => void refresh(docId), DELAY_MS));
}

function paintStatus(): void {
  const d = editors.activeDoc();
  const on = !!d && enabled.has(d.id);
  status?.update({ text: on ? 'Песочница: вкл' : 'Песочница', hidden: !d || !LANGS.includes(d.model.getLanguageId()), color: on ? 'var(--green, #a6e3a1)' : '' });
}

async function toggle(): Promise<void> {
  const d = editors.activeDoc();
  if (!d || !LANGS.includes(d.model.getLanguageId())) { notify('Песочница работает для Python, JavaScript, TypeScript и Lua', { kind: 'warn' }); return; }
  if (enabled.has(d.id)) {
    enabled.delete(d.id);
    if (lastJob) void ipc.sandboxCancel(lastJob).catch(() => undefined);
    results.delete(d.model.uri.toString());
    hintsChanged.fire();
    paintStatus();
    return;
  }
  if (!settings.isTrusted() && app.root) {
    if (!(await confirmDialog('Доверять этой папке?', `Песочница выполняет код из файлов папки «${app.root}». Включайте её только для своих проектов, не для только что скачанных чужих.`, 'Доверять на этот сеанс'))) return;
    settings.trust(app.root, false);
  }
  if (!(await confirmDialog('Песочница скетчей', 'Код этого файла будет выполняться автоматически после каждой паузы в наборе, а значения переменных появятся справа от строк.\n\nPython и Lua запускаются как обычные процессы с вашими правами (без изоляции): не включайте песочницу для кода с удалением файлов, сетью и т.п. JavaScript/TypeScript выполняются в изолированном Worker без доступа к редактору.', 'Включить'))) return;
  enabled.add(d.id);
  paintStatus();
  void refresh(d.id);
}

export function registerScratch(): void {
  const mo = monaco();
  const provider: M.languages.InlayHintsProvider = {
    onDidChangeInlayHints: hintsChanged.event,
    provideInlayHints(model) {
      const r = results.get(model.uri.toString());
      if (!r) return { hints: [], dispose() {} };
      const hints: M.languages.InlayHint[] = [];
      const n = model.getLineCount();
      for (const [line, text] of r.lines) {
        if (line > n) continue;
        hints.push({ position: { lineNumber: line, column: model.getLineMaxColumn(line) }, label: `  ▸ ${cut(text)}`, tooltip: text, paddingLeft: true });
      }
      if (r.error && r.error.line <= n) {
        hints.push({ position: { lineNumber: r.error.line, column: model.getLineMaxColumn(r.error.line) }, label: `  ✖ ${cut(r.error.message)}`, tooltip: r.error.message, paddingLeft: true });
      }
      return { hints, dispose() {} };
    },
  };
  for (const l of LANGS) mo.languages.registerInlayHintsProvider(l, provider);

  docs.onChange.on((d) => { if (enabled.has(d.id)) schedule(d.id); });
  docs.onClose.on((d) => { if (enabled.delete(d.id) && lastJob) void ipc.sandboxCancel(lastJob).catch(() => undefined); results.delete(d.model.uri.toString()); });
  editors.activeChanged.on(paintStatus);
  status = shell.statusItem({ id: 'scratch', align: 'right', priority: 40, text: 'Песочница', tooltip: 'Выполнять код на лету и показывать значения справа от строк', command: 'scratch.toggle' });
  paintStatus();
  commands.register({ id: 'scratch.toggle', title: 'Песочница: выполнять код на лету (значения справа от строк)', category: 'Запуск', run: () => toggle() });
}
