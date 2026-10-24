/** Pulls plottable numbers out of one line: `a:1 b:2`, `1,2,3` or `T=21.5 H=40`. Unlabelled values get names v0, v1… */
export function parsePlot(line: string): [string, number][] {
  const out: [string, number][] = [];
  const re = /(?:([A-Za-zА-Яа-я_][\w .-]*?)\s*[:=]\s*)?(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line))) out.push([m[1]?.trim() || `v${i++}`, Number(m[2])]);
  return out;
}
