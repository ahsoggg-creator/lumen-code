import { describe, expect, it } from 'vitest';
import { RESTRICTED_KEYS, sensitivePath } from './trust';

describe('workspace trust', () => {
  it('restricts every key that starts a program or loosens approvals', () => {
    for (const k of ['lsp.servers', 'python.interpreter', 'run.commands', 'ai.mcpServers', 'ai.autoApproveCommands', 'terminal.customShell', 'debug.adapters']) {
      expect(RESTRICTED_KEYS).toContain(k);
    }
  });

  it('flags credential files for agent reads', () => {
    for (const p of ['.env', 'app\\.env.local', 'C:\\w\\id_rsa', 'a/b/server.pem', 'secrets.json', '.npmrc']) expect(sensitivePath(p), p).toBe(true);
    for (const p of ['src\\env.ts', 'README.md', 'keys.ts']) expect(sensitivePath(p), p).toBe(false);
  });
});
