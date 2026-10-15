import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    switch (label) {
      case 'json': return new JsonWorker();
      case 'css': case 'scss': case 'less': return new CssWorker();
      case 'html': case 'handlebars': case 'razor': return new HtmlWorker();
      case 'typescript': case 'javascript': return new TsWorker();
      default: return new EditorWorker();
    }
  },
};

registerExtraLanguages();

function registerExtraLanguages(): void {
  const L = monaco.languages;
  L.register({ id: 'gdscript', extensions: ['.gd'], aliases: ['GDScript'] });
  L.setLanguageConfiguration('gdscript', {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string'] }],
    indentationRules: { increaseIndentPattern: /^\s*(func|if|elif|else|for|while|match|class|static func).*:\s*(#.*)?$/, decreaseIndentPattern: /^\s*$/ },
  });
  L.setMonarchTokensProvider('gdscript', {
    keywords: ['if', 'elif', 'else', 'for', 'while', 'match', 'break', 'continue', 'pass', 'return', 'class', 'class_name', 'extends', 'is', 'in', 'as', 'and', 'or', 'not', 'signal', 'func', 'static', 'const', 'enum', 'var', 'await', 'assert', 'void', 'super', 'self', 'preload', 'when'],
    constants: ['true', 'false', 'null', 'PI', 'TAU', 'INF', 'NAN'],
    types: ['int', 'float', 'bool', 'String', 'StringName', 'Vector2', 'Vector2i', 'Vector3', 'Vector3i', 'Vector4', 'Color', 'Rect2', 'Transform2D', 'Transform3D', 'Basis', 'Quaternion', 'NodePath', 'RID', 'Array', 'Dictionary', 'Callable', 'Signal', 'Object', 'Node', 'Node2D', 'Node3D', 'Control', 'Resource', 'PackedScene', 'Variant'],
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/@[a-zA-Z_]\w*/, 'annotation'],
        [/[a-zA-Z_]\w*(?=\s*\()/, { cases: { '@keywords': 'keyword', '@default': 'function' } }],
        [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@constants': 'constant', '@types': 'type', '@default': 'identifier' } }],
        [/\$[\w/]+|%[A-Z]\w*/, 'variable.predefined'],
        [/0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?/, 'number'],
        [/"""/, 'string', '@tripleString'],
        [/&?\^?"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/[{}()[\]]/, '@brackets'],
        [/[=><!~?:&|+\-*/^%]+/, 'operator'],
      ],
      tripleString: [[/[^"]+/, 'string'], [/"""/, 'string', '@pop'], [/"/, 'string']],
    },
  } as monaco.languages.IMonarchLanguage);

  L.register({ id: 'toml', extensions: ['.toml'], filenames: ['Cargo.lock', 'poetry.lock', 'Pipfile'], aliases: ['TOML'] });
  L.setLanguageConfiguration('toml', { comments: { lineComment: '#' }, brackets: [['{', '}'], ['[', ']']], autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }, { open: "'", close: "'" }] });
  L.setMonarchTokensProvider('toml', {
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/^\s*\[\[?[^\]]+\]\]?/, 'type'],
        [/^\s*[A-Za-z0-9_.\-"']+(?=\s*=)/, 'key'],
        [/"""/, 'string', '@ml'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\b(true|false)\b/, 'keyword'],
        [/\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?/, 'number'],
        [/[+-]?(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)/, 'number'],
        [/[{}[\],=]/, 'delimiter'],
      ],
      ml: [[/[^"]+/, 'string'], [/"""/, 'string', '@pop'], [/"/, 'string']],
    },
  } as monaco.languages.IMonarchLanguage);
}

export { monaco };
