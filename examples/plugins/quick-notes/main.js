export function activate(lumen) {
  const h = lumen.ui.h;
  lumen.window.addSidebarView({
    id: 'notes', title: 'Заметки', icon: 'fileText',
    render(host) {
      const area = h('textarea.field', { style: 'height:calc(100% - 16px);margin:8px;width:calc(100% - 16px);font-family:var(--mono);resize:none', placeholder: 'Пишите здесь — сохраняется автоматически…' });
      host.style.height = '100%';
      host.append(area);
      void lumen.storage.get('text').then((t) => { area.value = t ?? ''; });
      let timer;
      area.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => lumen.storage.set('text', area.value), 400); });
    },
  });
}
