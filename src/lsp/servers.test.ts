/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { BUILTIN_SERVERS, mergeServers, sectionOf, serverForLanguage } from './servers';

describe('mergeServers', () => {
  it('returns the built-in servers by default', () => {
    expect(mergeServers(undefined).map((s) => s.id)).toEqual(BUILTIN_SERVERS.map((s) => s.id));
  });
  it('lets the user replace the command; such a server is not installed by us', () => {
    const python = mergeServers({ python: { command: 'pyright-langserver', args: ['--stdio'] } }).find((s) => s.id === 'python')!;
    expect(python.commands).toEqual(['pyright-langserver']);
    expect(python.install).toBeUndefined();
    expect(python.pythonScripts).toBe(false);
  });
  it('merges settings and honours disabled', () => {
    const s = mergeServers({ python: { settings: { python: { analysis: { diagnosticMode: 'workspace' } } } }, go: { disabled: true } });
    expect(s.some((x) => x.id === 'go')).toBe(false);
    expect((s.find((x) => x.id === 'python')!.settings as any).python.analysis.diagnosticMode).toBe('workspace');
  });
  it('adds a custom server only when it has a command and languages', () => {
    const s = mergeServers({ zls: { command: 'zls', languages: ['zig'] }, broken: { command: 'x' } });
    expect(serverForLanguage(s, 'zig')?.id).toBe('zls');
    expect(s.some((x) => x.id === 'broken')).toBe(false);
  });
});

describe('serverForLanguage', () => {
  it('finds a server by Monaco language id', () => {
    const s = mergeServers(undefined);
    expect(serverForLanguage(s, 'python')?.id).toBe('python');
    expect(serverForLanguage(s, 'cpp')?.id).toBe('clangd');
    expect(serverForLanguage(s, 'javascript')).toBeUndefined();
  });
});

describe('sectionOf', () => {
  const settings = { python: { analysis: { a: 1 } }, x: 2 };
  it('walks dotted sections', () => {
    expect(sectionOf(settings, 'python.analysis')).toEqual({ a: 1 });
    expect(sectionOf(settings, 'x')).toBe(2);
  });
  it('gives null for missing sections and the whole object for none', () => {
    expect(sectionOf(settings, 'python.nothing.deeper')).toBeNull();
    expect(sectionOf(settings, 'rust-analyzer')).toBeNull();
    expect(sectionOf(settings, undefined)).toBe(settings);
  });
});
