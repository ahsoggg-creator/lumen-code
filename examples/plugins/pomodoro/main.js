export function activate(lumen) {
  let timer = null;
  let left = 0;
  let phase = 'idle';

  const item = lumen.window.status({ text: '🍅 старт', align: 'left', priority: 10, tooltip: 'Pomodoro: нажмите, чтобы запустить или остановить', onClick: () => toggle() });

  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  function stop() {
    clearInterval(timer);
    timer = null;
    phase = 'idle';
    item.update({ text: '🍅 старт' });
  }

  function begin(next) {
    phase = next;
    left = (next === 'work' ? lumen.settings.get('pomodoro.work') : lumen.settings.get('pomodoro.rest')) * 60;
    clearInterval(timer);
    timer = setInterval(() => {
      left -= 1;
      item.update({ text: `${phase === 'work' ? '🍅' : '☕'} ${fmt(left)}` });
      if (left <= 0) {
        const wasWork = phase === 'work';
        lumen.window.info(wasWork ? 'Время отдохнуть ☕' : 'Отдых закончился — за работу 🍅');
        begin(wasWork ? 'rest' : 'work');
      }
    }, 1000);
  }

  function toggle() {
    if (timer) stop(); else begin('work');
  }

  lumen.commands.register('toggle', 'Старт / стоп', toggle);
  return () => clearInterval(timer);
}

export function deactivate() {}
