import { INITIAL, Registry, parseRawGrammar, type IGrammar, type StateStack } from 'vscode-textmate';
import { loadWASM, createOnigScanner, createOnigString } from 'vscode-oniguruma';
import onigWasm from 'vscode-oniguruma/release/onig.wasm?url';
import type * as Mn from 'monaco-editor';
import { ipc } from '../ipc';

const scopeFiles = new Map<string, string>();
let registry: Registry | null = null;
let ready: Promise<void> | null = null;

export function addGrammarFile(scopeName: string, path: string): void { scopeFiles.set(scopeName, path); }

function init(): Promise<void> {
  ready ??= (async () => {
    const wasm = await (await fetch(onigWasm)).arrayBuffer();
    await loadWASM(wasm);
    registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner: (s) => createOnigScanner(s), createOnigString: (s) => createOnigString(s) }),
      loadGrammar: async (scope) => {
        const p = scopeFiles.get(scope);
        if (!p) return null;
        const text = (await ipc.readFile(p)).content;
        return parseRawGrammar(text, p);
      },
    });
  })();
  return ready;
}

class State implements Mn.languages.IState {
  constructor(readonly stack: StateStack) {}
  clone(): State { return new State(this.stack); }
  equals(o: Mn.languages.IState): boolean { return o instanceof State && (o.stack === this.stack || o.stack.equals(this.stack)); }
}

/** The most specific scope that carries meaning for a theme (skips pure structure such as meta.* and the root source.*). */
function pickScope(scopes: string[]): string {
  for (let i = scopes.length - 1; i > 0; i--) if (!scopes[i]!.startsWith('meta.') && !scopes[i]!.startsWith('source.') && !scopes[i]!.startsWith('text.')) return scopes[i]!;
  return scopes[scopes.length - 1] ?? '';
}

export async function tokensProviderFor(scopeName: string): Promise<Mn.languages.TokensProvider> {
  await init();
  const grammar: IGrammar | null = await registry!.loadGrammar(scopeName);
  if (!grammar) throw new Error(`грамматика ${scopeName} не загрузилась`);
  return {
    getInitialState: () => new State(INITIAL),
    tokenize(line, state) {
      const r = grammar.tokenizeLine(line, (state as State).stack);
      return { tokens: r.tokens.map((t) => ({ startIndex: t.startIndex, scopes: pickScope(t.scopes) })), endState: new State(r.ruleStack) };
    },
  };
}
