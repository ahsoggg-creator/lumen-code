import { describe, expect, it } from 'vitest';
import { fuzzyScore, isUnder, join, normalizePath } from './util';

describe('normalizePath', () => {
  it('resolves . and ..', () => {
    expect(normalizePath('C:\\a\\.\\b\\..\\c')).toBe('C:\\a\\c');
    expect(normalizePath('C:/a/b/../../c/')).toBe('C:\\c');
  });
  it('never climbs above the drive', () => {
    expect(normalizePath('C:\\a\\..\\..\\..\\x')).toBe('C:\\x');
    expect(normalizePath('C:\\..')).toBe('C:');
  });
  it('keeps a UNC share as the root', () => {
    expect(normalizePath('\\\\srv\\share\\a\\..\\..\\b')).toBe('\\\\srv\\share\\b');
  });
});

describe('isUnder', () => {
  const root = 'C:\\proj';
  it('accepts the root and its children, ignoring case and slash style', () => {
    expect(isUnder(root, 'c:/PROJ')).toBe(true);
    expect(isUnder(root, 'C:\\proj\\src\\a.ts')).toBe(true);
  });
  it('rejects siblings with the same prefix', () => {
    expect(isUnder(root, 'C:\\proj-other\\a.ts')).toBe(false);
  });
  it('rejects ".." escapes built with join', () => {
    expect(isUnder(root, join(root, '..\\secret.txt'))).toBe(false);
    expect(isUnder(root, join(root, 'src\\..\\..\\..\\Windows'))).toBe(false);
    expect(isUnder(root, join(root, 'src\\..\\a.ts'))).toBe(true);
  });
});

describe('join', () => {
  it('collapses repeated separators and skips empty parts', () => {
    expect(join('C:\\a\\', '', '/b//c')).toBe('C:\\a\\b\\c');
  });
});

describe('fuzzyScore', () => {
  it('matches subsequences and ranks tighter matches higher', () => {
    expect(fuzzyScore('abc', 'xyz')).toBeLessThanOrEqual(0);
    expect(fuzzyScore('app', 'app.ts')).toBeGreaterThan(fuzzyScore('app', 'a_p_p.ts'));
  });
});
