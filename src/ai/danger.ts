const RULES: [RegExp, string][] = [
  [/\bRemove-Item\b[^\n]*-Recurse|\brm\s+(-\w*r\w*|--recursive)\b|\brmdir\s+\/s\b|\bdel\s+[^\n]*\/s\b|\brd\s+\/s\b/i, 'рекурсивное удаление файлов'],
  [/\bformat(-volume)?\s+[a-z]:|\bdiskpart\b|\bClear-Disk\b/i, 'форматирование или очистка диска'],
  [/\bgit\s+(push\s+[^\n]*(--force\b|-f\b)|reset\s+--hard|clean\s+-\w*f)/i, 'git-команда, которая стирает историю или несохранённые изменения'],
  [/\b(iex|Invoke-Expression)\b|\|\s*(iex|sh|bash|powershell|pwsh)\b|\b(irm|iwr|Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b[^\n|]*\|\s*\w+/i, 'скачивание и запуск кода из сети'],
  [/\breg\s+(add|delete)\b|\bSet-ItemProperty\b[^\n]*HK(LM|CU)|\bNew-ItemProperty\b[^\n]*HK(LM|CU)|\bRemove-ItemProperty\b/i, 'изменение реестра'],
  [/\bStop-Computer\b|\bRestart-Computer\b|\bshutdown\b/i, 'выключение или перезагрузка компьютера'],
  [/\bnpm\s+(publish|unpublish)\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, 'публикация пакета'],
];

/** Reasons why a command the agent wants to run deserves a closer look (empty when it looks ordinary). */
export function dangerousCommand(cmd: string): string[] {
  return RULES.filter(([re]) => re.test(cmd)).map(([, why]) => why);
}

const SQL_WRITE = /\b(DROP|DELETE|TRUNCATE|ALTER|INSERT|UPDATE|REPLACE|CREATE|GRANT|REVOKE|ATTACH|DETACH|VACUUM|REINDEX)\b|\bPRAGMA\s+\w+\s*=/i;
const WRITE_WORDS = new Set('write delete remove drop truncate create update insert append edit move rename copy save exec execute run kill put post patch upload set click type press fill submit navigate evaluate send commit push merge reset apply deploy install uninstall publish grant revoke'.split(' '));

/** Reasons why an MCP tool call should be confirmed even when command auto-approve is on: it writes, deletes or runs something. */
export function dangerousMcp(tool: string, args: Record<string, unknown>): string[] {
  const why: string[] = [];
  const short = tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  // Words of the tool name, whether it is written snake_case, kebab-case or camelCase (`writeFile`, `execute-query`).
  const words = short.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/);
  if (words.some((w) => WRITE_WORDS.has(w))) why.push(`инструмент «${short}» меняет данные или запускает действие`);
  const text = JSON.stringify(args);
  if (SQL_WRITE.test(text)) why.push('в запросе есть изменяющий SQL (DROP/DELETE/UPDATE/INSERT…)');
  if (/(\.\.(\\\\|\/)|\/etc\/|\\\\Windows\\\\|System32)/i.test(text) && /(path|file|dir)/i.test(text)) why.push('путь выходит за пределы проекта или в системные папки');
  return why;
}
