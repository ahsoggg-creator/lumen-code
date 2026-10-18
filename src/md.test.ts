import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './md';

describe('renderMarkdown', () => {
  it('does not pass raw HTML through', () => {
    const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
  });
  it('escapes quotes so a link cannot break out of its attribute', () => {
    const html = renderMarkdown('[x](https://a.test/"onmouseover="alert(1))');
    expect(html).not.toMatch(/"onmouseover=/);
  });
  it('only links http(s)', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href="javascript');
  });
  it('renders fences as <pre data-lang> with escaped code', () => {
    const html = renderMarkdown('```ts\nconst a = "<b>";\n```');
    expect(html).toContain('<pre data-lang="ts">');
    expect(html).toContain('&lt;b&gt;');
  });
});
