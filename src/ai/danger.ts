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
