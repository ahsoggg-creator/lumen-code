const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur'.split(' ');
const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
const sentence = () => { const n = 6 + Math.floor(Math.random() * 9); const s = Array.from({ length: n }, pick).join(' '); return s[0].toUpperCase() + s.slice(1) + '.'; };
const paragraph = () => Array.from({ length: 3 + Math.floor(Math.random() * 3) }, sentence).join(' ');

export function activate(lumen) {
  lumen.commands.register('paragraphs', 'Вставить абзацы…', async () => {
    const n = Number(await lumen.window.input({ title: 'Сколько абзацев?', value: '3' }));
    if (n > 0) lumen.editor.insert(Array.from({ length: Math.min(n, 50) }, paragraph).join('

'));
  });
  lumen.commands.register('sentence', 'Вставить предложение', () => lumen.editor.insert(sentence()));
  lumen.commands.register('words', 'Вставить 10 слов', () => lumen.editor.insert(Array.from({ length: 10 }, pick).join(' ')));
}
