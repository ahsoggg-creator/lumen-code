export interface HttpRequest {
  /** 1-based line of the request line (where the ▶ button goes). */
  line: number;
  /** 1-based last line of the request, headers and body included. */
  endLine: number;
  title: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);
const isComment = (l: string): boolean => /^\s*(#(?!##)|\/\/)/.test(l);

/** Parses the `.http` / `.rest` format: requests split by `###`, `@name = value` variables, headers, then a body after a blank line. */
export function parseHttpFile(text: string): { requests: HttpRequest[]; vars: Record<string, string> } {
  const lines = text.split(/\r?\n/);
  const vars: Record<string, string> = {};
  const requests: HttpRequest[] = [];
  let cur: HttpRequest | null = null;
  let inBody = false;
  let title = '';

  const finish = (end: number): void => {
    if (!cur) return;
    cur.body = cur.body.replace(/\s+$/, '');
    cur.endLine = Math.max(cur.line, end);
    requests.push(cur);
    cur = null;
    inBody = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^###/.test(l)) { finish(i); title = l.replace(/^#+\s*/, '').trim(); continue; }
    if (!cur) {
      const v = /^\s*@([\w.-]+)\s*=\s*(.*)$/.exec(l);
      if (v) { vars[v[1]!] = v[2]!.trim(); continue; }
      if (!l.trim() || isComment(l)) {
        const nm = /^\s*(?:#|\/\/)\s*@name\s+(\S+)/.exec(l);
        if (nm) title = nm[1]!;
        continue;
      }
      const m = /^\s*(?:([A-Za-z]+)\s+)?(\S+?)(?:\s+HTTP\/[\d.]+)?\s*$/.exec(l);
      if (!m) continue;
      const method = (m[1] ?? 'GET').toUpperCase();
      if (m[1] && !METHODS.has(method)) continue;
      // A line with no method must at least look like a URL, so a stray `}` or word does not become a request.
      if (!m[1] && !/^(https?:\/\/|\{\{|\/)/i.test(m[2]!)) continue;
      cur = { line: i + 1, endLine: i + 1, title, method, url: m[2]!, headers: [], body: '' };
      title = '';
      continue;
    }
    if (inBody) { cur.body += `${l}\n`; continue; }
    if (!l.trim()) { inBody = true; continue; }
    if (isComment(l)) continue;
    if (/^\s+[?&]/.test(l)) { cur.url += l.trim(); continue; }
    const h = /^([^:\s][^:]*):\s*(.*)$/.exec(l);
    if (h) cur.headers.push([h[1]!.trim(), h[2]!.trim()]);
  }
  finish(lines.length);
  // A request ends where the next one starts (minus the separator), which the loop already handled; trim trailing blank lines.
  for (const r of requests) {
    let e = r.endLine;
    while (e > r.line && !(lines[e - 1] ?? '').trim()) e--;
    r.endLine = e;
  }
  return { requests, vars };
}

/** Replaces `{{name}}` with a variable, `{{$guid}}` with a fresh UUID and `{{$timestamp}}` with Unix seconds; unknown names stay as they are. */
export function applyVars(s: string, vars: Record<string, string>): string {
  return s.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (m, name: string) => {
    if (name === '$guid') return crypto.randomUUID();
    if (name === '$timestamp') return String(Math.floor(Date.now() / 1000));
    if (name === '$randomInt') return String(Math.floor(Math.random() * 1000));
    return vars[name] ?? m;
  });
}

/** The request the cursor is in (or the nearest one above it). */
export function requestAt(requests: HttpRequest[], line: number): HttpRequest | undefined {
  return [...requests].reverse().find((r) => r.line <= line);
}
