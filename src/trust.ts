/** Settings that start programs, redirect network traffic or loosen approvals. A workspace `.lumen/settings.json` may set them only in a trusted folder. */
export const RESTRICTED_KEYS: readonly string[] = [
  'lsp.servers', 'python.interpreter', 'terminal.customShell', 'run.commands', 'debug.adapters', 'keybindings',
  'ai.mcpServers', 'ai.terminalAgents', 'ai.providers', 'ai.activeProvider', 'ai.systemPrompt', 'ai.inline.enabled', 'ai.inline.url',
  'ai.autoApproveReads', 'ai.autoApproveEdits', 'ai.autoApproveCommands', 'plugins.registry', 'security.trustedFolders',
];

/** Files that usually hold credentials: the agent asks before reading them even with auto-approved reads. */
export const sensitivePath = (p: string): boolean =>
  /(^|[\\/])(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|credentials|secrets?\.[\w.]+|[^\\/]+\.(pem|key|pfx|p12|kdbx))$/i.test(p);

