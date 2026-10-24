//! Syntax-tree features built on tree-sitter: a signature outline (cheap context for the AI agent),
//! structural search / replace with tree-sitter queries, and the statement instrumentation behind the scratchpad.

use ignore::WalkBuilder;
use serde::Serialize;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Node, Parser, Query, QueryCursor};

pub fn language(id: &str) -> Option<Language> {
    Some(match id {
        "python" => tree_sitter_python::LANGUAGE.into(),
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "lua" => tree_sitter_lua::LANGUAGE.into(),
        _ => return None,
    })
}

fn lang_of_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "py" | "pyw" => "python",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "ts" | "mts" | "cts" => "typescript",
        "rs" => "rust",
        "go" => "go",
        "lua" => "lua",
        _ => return None,
    })
}

fn parse(lang: &str, text: &str) -> Result<(Language, tree_sitter::Tree), String> {
    let l = language(lang).ok_or_else(|| format!("язык «{lang}» не поддерживается (python, javascript, typescript, rust, go, lua)"))?;
    let mut p = Parser::new();
    p.set_language(&l).map_err(|e| e.to_string())?;
    let t = p.parse(text, None).ok_or("не удалось разобрать файл")?;
    Ok((l, t))
}

fn txt<'a>(n: Node, src: &'a str) -> &'a str {
    &src[n.start_byte()..n.end_byte()]
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Sig {
    pub kind: String,
    pub name: String,
    pub signature: String,
    pub line: usize,
    pub end_line: usize,
    pub depth: usize,
}

fn decl_kind(lang: &str, kind: &str) -> Option<&'static str> {
    Some(match (lang, kind) {
        ("python", "class_definition") => "class",
        ("python", "function_definition") => "fn",
        ("javascript" | "typescript", "class_declaration" | "abstract_class_declaration") => "class",
        ("javascript" | "typescript", "function_declaration" | "generator_function_declaration" | "method_definition") => "fn",
        ("typescript", "interface_declaration") => "interface",
        ("typescript", "enum_declaration") => "enum",
        ("typescript", "type_alias_declaration") => "type",
        ("rust", "struct_item") => "class",
        ("rust", "enum_item") => "enum",
        ("rust", "trait_item") => "interface",
        ("rust", "impl_item") => "impl",
        ("rust", "function_item") => "fn",
        ("rust", "mod_item") => "mod",
        ("go", "function_declaration" | "method_declaration") => "fn",
        ("go", "type_spec") => "class",
        ("lua", "function_declaration") => "fn",
        _ => return None,
    })
}

fn signature(n: Node, src: &str) -> String {
    let end = n.child_by_field_name("body").map(|b| b.start_byte()).unwrap_or_else(|| n.end_byte());
    let s = &src[n.start_byte()..end.max(n.start_byte())];
    let s = s.lines().next().map(|_| s).unwrap_or("");
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let one = one.trim_end_matches(['{', ':', ' ']).trim().to_string();
    if one.chars().count() > 200 {
        one.chars().take(200).collect::<String>() + "…"
    } else {
        one
    }
}

fn walk_outline(n: Node, src: &str, lang: &str, depth: usize, out: &mut Vec<Sig>) {
    let mut d = depth;
    if let Some(kind) = decl_kind(lang, n.kind()) {
        let name = n
            .child_by_field_name("name")
            .or_else(|| n.child_by_field_name("type"))
            .map(|x| txt(x, src).to_string())
            .unwrap_or_default();
        out.push(Sig {
            kind: kind.into(),
            name,
            signature: signature(n, src),
            line: n.start_position().row + 1,
            end_line: n.end_position().row + 1,
            depth,
        });
        d += 1;
    }
    let mut c = n.walk();
    for ch in n.children(&mut c) {
        walk_outline(ch, src, lang, d, out);
    }
}

pub fn outline_of(text: &str, lang: &str) -> Result<Vec<Sig>, String> {
    let (_, t) = parse(lang, text)?;
    let mut out = Vec::new();
    walk_outline(t.root_node(), text, lang, 0, &mut out);
    Ok(out)
}

#[tauri::command(async)]
pub fn ast_outline(text: String, lang: String) -> Result<Vec<Sig>, String> {
    outline_of(&text, &lang)
}

#[derive(Serialize, Debug)]
pub struct Match {
    pub line: usize,
    pub col: usize,
    pub end_line: usize,
    pub end_col: usize,
    pub text: String,
    pub captures: Vec<(String, String)>,
    #[serde(skip)]
    range: (usize, usize),
}

fn run_query(text: &str, lang: &str, query: &str) -> Result<Vec<Match>, String> {
    let (l, t) = parse(lang, text)?;
    let q = Query::new(&l, query).map_err(|e| format!("запрос: {e}"))?;
    let names = q.capture_names();
    let target = names.iter().position(|n| *n == "target");
    let mut cur = QueryCursor::new();
    let mut it = cur.matches(&q, t.root_node(), text.as_bytes());
    let mut out: Vec<Match> = Vec::new();
    while let Some(m) = it.next() {
        let main = target.and_then(|ti| m.captures().iter().find(|c| c.index as usize == ti)).or_else(|| m.captures().first());
        let Some(main) = main else { continue };
        let n = main.node;
        out.push(Match {
            line: n.start_position().row + 1,
            col: n.start_position().column + 1,
            end_line: n.end_position().row + 1,
            end_col: n.end_position().column + 1,
            text: txt(n, text).chars().take(300).collect(),
            captures: m.captures().iter().map(|c| (names[c.index as usize].to_string(), txt(c.node, text).to_string())).collect(),
            range: (n.start_byte(), n.end_byte()),
        });
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct FileMatches {
    path: String,
    matches: Vec<Match>,
}

/// Runs a tree-sitter query over the files of one language under `root`.
#[tauri::command(async)]
pub fn ast_search(root: String, lang: String, query: String, max: Option<usize>) -> Result<Vec<FileMatches>, String> {
    language(&lang).ok_or("язык не поддерживается")?;
    let max = max.unwrap_or(500);
    let (mut out, mut total) = (Vec::new(), 0usize);
    for e in WalkBuilder::new(&root).hidden(false).filter_entry(|e| e.file_name() != ".git" && e.file_name() != "node_modules").build().flatten() {
        let p = e.path();
        if !p.is_file() || p.extension().and_then(|x| x.to_str()).and_then(|x| lang_of_ext(&x.to_ascii_lowercase())) != Some(lang.as_str()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(p) else { continue };
        let ms = run_query(&text, &lang, &query)?;
        if ms.is_empty() {
            continue;
        }
        total += ms.len();
        out.push(FileMatches { path: p.to_string_lossy().into_owned(), matches: ms });
        if total >= max {
            break;
        }
    }
    Ok(out)
}

fn apply_template(tpl: &str, caps: &[(String, String)]) -> String {
    let mut names: Vec<&(String, String)> = caps.iter().collect();
    names.sort_by_key(|c| std::cmp::Reverse(c.0.len()));
    let mut out = tpl.to_string();
    for (n, v) in names {
        out = out.replace(&format!("${n}"), v);
    }
    out
}

/// Replaces the `@target` capture (or the first one) of every match with `template`, where `$name` stands for another capture's text.
pub fn replace_in_text(text: &str, lang: &str, query: &str, template: &str) -> Result<(String, usize), String> {
    let mut ms = run_query(text, lang, query)?;
    ms.sort_by_key(|m| m.range.0);
    let mut out = String::new();
    let (mut pos, mut n) = (0usize, 0usize);
    for m in &ms {
        if m.range.0 < pos {
            continue;
        }
        out.push_str(&text[pos..m.range.0]);
        out.push_str(&apply_template(template, &m.captures));
        pos = m.range.1;
        n += 1;
    }
    out.push_str(&text[pos..]);
    Ok((out, n))
}

#[tauri::command(async)]
pub fn ast_replace(files: Vec<String>, lang: String, query: String, template: String) -> Result<usize, String> {
    let mut total = 0;
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        let (new, n) = replace_in_text(&text, &lang, &query, &template)?;
        if n > 0 {
            std::fs::write(&f, new).map_err(|e| format!("{f}: {e}"))?;
            total += n;
        }
    }
    Ok(total)
}

/// Scratchpad: adds `__q(line, name, value)` probes after top-level declarations and around top-level expressions
/// (all on the original lines, so line numbers stay valid).
#[tauri::command(async)]
pub fn scratch_instrument(text: String, lang: String) -> Result<String, String> {
    if lang != "javascript" && lang != "typescript" {
        return Err("только JavaScript и TypeScript".into());
    }
    let (_, t) = parse(&lang, &text)?;
    let root = t.root_node();
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let mut c = root.walk();
    for st in root.children(&mut c) {
        let line = st.end_position().row + 1;
        match st.kind() {
            "lexical_declaration" | "variable_declaration" => {
                let mut probes = String::new();
                let mut dc = st.walk();
                for d in st.children(&mut dc).filter(|d| d.kind() == "variable_declarator") {
                    if let Some(nm) = d.child_by_field_name("name").filter(|n| n.kind() == "identifier") {
                        let name = txt(nm, &text);
                        probes.push_str(&format!("__q({line},\"{name}\",{name});"));
                    }
                }
                if !probes.is_empty() {
                    edits.push((st.end_byte(), st.end_byte(), format!(";{probes}")));
                }
            }
            "expression_statement" => {
                if let Some(e) = st.named_child(0) {
                    edits.push((e.end_byte(), e.end_byte(), "))".into()));
                    edits.push((e.start_byte(), e.start_byte(), format!("__q({line},null,(")));
                }
            }
            _ => {}
        }
    }
    edits.sort_by_key(|e| std::cmp::Reverse((e.0, e.1)));
    let mut out = text.clone();
    for (a, b, s) in edits {
        out.replace_range(a..b, &s);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_outline_has_signatures_and_nesting() {
        let src = "class A:\n    def m(self, x: int) -> int:\n        return x\n\ndef f(a, b=2):\n    pass\n";
        let o = outline_of(src, "python").unwrap();
        assert_eq!(o.len(), 3);
        assert_eq!((o[0].kind.as_str(), o[0].name.as_str(), o[0].depth), ("class", "A", 0));
        assert_eq!(o[1].signature, "def m(self, x: int) -> int");
        assert_eq!(o[1].depth, 1);
        assert_eq!(o[2].signature, "def f(a, b=2)");
    }

    #[test]
    fn typescript_and_rust_outline() {
        let ts = outline_of("interface I { a: number }\nclass C<T> { run(x: T): void { } }\n", "typescript").unwrap();
        assert!(ts.iter().any(|s| s.kind == "interface" && s.name == "I"));
        assert!(ts.iter().any(|s| s.name == "run" && s.signature.starts_with("run(x: T)")));
        let rs = outline_of("pub struct S;\nimpl S { pub fn go(&self) -> u8 { 1 } }\n", "rust").unwrap();
        assert!(rs.iter().any(|s| s.kind == "fn" && s.signature == "pub fn go(&self) -> u8"));
    }

    #[test]
    fn structural_search_and_replace() {
        let src = "print(1)\nfoo(2)\nprint('a' + 'b')\n";
        let q = r#"(call function: (identifier) @f (#eq? @f "print") arguments: (argument_list) @args) @target"#;
        let ms = run_query(src, "python", q).unwrap();
        assert_eq!(ms.len(), 2);
        let (out, n) = replace_in_text(src, "python", q, "log$args").unwrap();
        assert_eq!(n, 2);
        assert_eq!(out, "log(1)\nfoo(2)\nlog('a' + 'b')\n");
    }

    #[test]
    fn bad_query_and_language_are_errors() {
        assert!(run_query("x = 1", "python", "(nope").is_err());
        assert!(outline_of("x", "cobol").is_err());
    }

    #[test]
    fn scratch_probes_keep_lines() {
        let src = "const a = 1, b = a + 1\nlet s = 'x'\na + b\nconsole.log(s)\nfunction f() { return 1 }\n";
        let out = scratch_instrument(src.into(), "javascript".into()).unwrap();
        assert_eq!(out.lines().count(), src.lines().count());
        assert!(out.contains("__q(1,\"a\",a);__q(1,\"b\",b);"));
        assert!(out.contains("__q(3,null,(a + b))"));
        assert!(out.contains("__q(4,null,(console.log(s)))"));
        assert!(out.contains("function f() { return 1 }"));
    }
}
