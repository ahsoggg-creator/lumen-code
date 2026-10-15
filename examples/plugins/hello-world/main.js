// Пример плагина Lumen Code. Скопируйте папку в %APPDATA%\LumenCode\plugins\ и выполните «Плагины: перезагрузить все».
export function activate(lumen) {
  let clicks = 0;

  const status = lumen.window.status({ text: 'Привет 👋', align: 'right', tooltip: 'Плагин hello-world', onClick: () => lumen.commands.execute('hello-world.hello') });

  lumen.commands.register('hello', 'Сказать привет', () => {
    clicks += 1;
    const file = lumen.editor.active();
    lumen.window.info(file ? `Привет! Сейчас открыт ${file.path ?? 'файл без имени'} (нажатий: ${clicks})` : `Привет из плагина! (нажатий: ${clicks})`);
    status.update({ text: `Привет ×${clicks}` });
  }, { keybinding: 'ctrl+alt+h' });

  lumen.commands.register('wrap', 'Обернуть выделение в кавычки', () => {
    const a = lumen.editor.active();
    if (a?.selectionText) lumen.editor.replaceSelection(`"${a.selectionText}"`);
  });
}

export function deactivate() {}
