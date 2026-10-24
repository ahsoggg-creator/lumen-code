/** Addresses worth decoding in one line of ESP32 / Arduino crash output (Xtensa and RISC-V formats). */
export function crashAddresses(line: string): string[] {
  const out: string[] = [];
  const bt = /Backtrace:\s*(.*)$/.exec(line);
  if (bt) {
    // Xtensa prints "PC:SP" pairs, RISC-V a plain list: the program counter is the part before the colon.
    for (const tok of bt[1]!.split(/\s+/)) {
      const m = /^(0x[0-9a-fA-F]{1,8})(?::0x[0-9a-fA-F]+)?$/.exec(tok);
      if (m) out.push(m[1]!);
    }
  }
  const reg = /^\s*(?:PC|MEPC|RA)\s*:\s*(0x[0-9a-fA-F]{1,8})/.exec(line);
  if (reg) out.push(reg[1]!);
  // Registers share a line on RISC-V: "MEPC    : 0x42001234  RA      : 0x42005678".
  for (const m of line.matchAll(/\b(?:MEPC|RA)\s*:\s*(0x[0-9a-fA-F]{1,8})/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out.filter((a, i) => out.indexOf(a) === i && !/^0x0+$/.test(a));
}

export const isCrashHeader = (line: string): boolean => /Guru Meditation Error|abort\(\) was called|Fatal exception|\*\*\* ?ERROR|Core\s+\d+ panic'ed|rst:0x.*\(.*PANIC\)/i.test(line);

/** A path from addr2line (often another drive or a temp build copy) matched against the project's files by its tail. */
export function matchProjectFile(file: string, files: string[]): string | null {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  const target = norm(file);
  if (files.some((f) => norm(f) === target)) return files.find((f) => norm(f) === target)!;
  const base = target.split('\\').pop()!;
  const parts = target.split('\\');
  for (let n = Math.min(parts.length, 4); n >= 1; n--) {
    const tail = '\\' + parts.slice(-n).join('\\');
    const hit = files.filter((f) => norm(f).endsWith(tail));
    if (hit.length === 1) return hit[0]!;
  }
  const byBase = files.filter((f) => norm(f).endsWith('\\' + base));
  return byBase.length === 1 ? byBase[0]! : null;
}

/** Network ports out of `arduino-cli board list --format json` (current and older output shapes). */
export function networkPorts(json: string): { address: string; label: string }[] {
  let data: unknown;
  try { data = JSON.parse(json); } catch { return []; }
  const list = Array.isArray(data) ? data : ((data as { detected_ports?: unknown[] }).detected_ports ?? []);
  const out: { address: string; label: string }[] = [];
  for (const e of list as { port?: { address?: string; label?: string; protocol?: string }; address?: string; protocol?: string }[]) {
    const p = e.port ?? e;
    if (p.protocol === 'network' && p.address) out.push({ address: p.address, label: (p as { label?: string }).label ?? p.address });
  }
  return out;
}
