const EMOJI = '😀 smile|😂 laugh|😍 love|😎 cool|🤔 think|😭 cry|😡 angry|👍 thumbs up|👎 thumbs down|👏 clap|🙏 pray|🔥 fire|✨ sparkles|🎉 party|❤️ heart|💔 broken heart|⭐ star|✅ check|❌ cross|⚠️ warning|🐛 bug|🚀 rocket|💡 idea|🔧 wrench|📦 package|📝 note|📌 pin|🔒 lock|🔑 key|⏰ alarm|☕ coffee|🍕 pizza|🐍 snake python|🦀 crab rust|☁️ cloud|🌙 moon|☀️ sun|⚡ lightning|🎯 target|🧪 test|📈 chart up|📉 chart down'.split('|');
export function activate(lumen) {
  lumen.commands.register('pick', 'Вставить эмодзи…', async () => {
    const v = await lumen.window.pick(EMOJI.map((e) => ({ label: e.split(' ')[0], description: e.split(' ').slice(1).join(' '), value: e.split(' ')[0] })), { placeholder: 'Найдите эмодзи' });
    if (v) lumen.editor.insert(v);
  }, { keybinding: 'ctrl+alt+e' });
}
