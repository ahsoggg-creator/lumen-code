# Lumen Code

[English](README.en.md) · [Русский](README.md)

A light, fast, fully customizable code editor for Windows, in the spirit of VS Code but built on Tauri + Rust instead of Electron. One `.exe`, no installer.

- **Monaco editor engine** (the one VS Code uses): multi-cursor, minimap, folding, sticky scroll, diff, IntelliSense for JS/TS/JSON/CSS/HTML.
- **Look:** 10 themes, accent colour, fonts, UI scale, radius, side of the panels, animations; arbitrary restyling with your own CSS file and colour overrides.
- **Settings:** searchable settings page plus `settings.json` with schema hints, per-project `.lumen/settings.json`, every shortcut rebindable (including chords).
- **Lean:** Rust backend, framework-free UI, lazy-loaded Monaco/terminal/Git/Python/AI, virtualized file tree, parallel search, batched file watching.
- **Plugins:** JavaScript modules (commands, keys, views, status bar, themes, AI agents), plugin catalog, install from a GitHub URL. See [docs/PLUGINS.md](docs/PLUGINS.md).
- **AI agents:** chat with an agent mode (read/search/edit/run, each action confirmed). Anthropic, OpenAI, OpenRouter, DeepSeek, Groq, Gemini, Ollama/LM Studio, any OpenAI-compatible API; keys live in the Windows credential store. Launchers for Claude Code, Codex, Gemini CLI, Aider in the terminal.
- **Python:** interpreter picker, venv creation, pip package manager UI, F5 to run.
- **Run & debug:** Ctrl+F5 runs ~25 file types (offers winget install / download when a compiler is missing); F5 debugger via DAP (Python built in, others configurable); new-file templates and project scaffolds. See [docs/DEBUG_AND_RUN.md](docs/DEBUG_AND_RUN.md).
- **Updates:** Help → Check for Updates downloads a new release from GitHub and verifies its SHA-256 before replacing the executable.

Limitations: debugger built in for Python only, no full LSP, no MCP yet, plugins are not sandboxed, Windows only. MIT licensed.

Build: `npm ci && npx tauri build --no-bundle`; tests: `cd src-tauri && cargo test`.
