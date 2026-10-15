use ignore::{overrides::OverrideBuilder, WalkBuilder, WalkState};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const MAX_FILE: u64 = 5 << 20;
const PER_FILE: usize = 500;

#[derive(Deserialize, Clone)]
pub struct SearchOpts {
    root: String,
    query: String,
    #[serde(default)]
    regex: bool,
    #[serde(default)]
    case: bool,
    #[serde(default)]
    word: bool,
    #[serde(default)]
    include: Vec<String>,
    #[serde(default)]
    exclude: Vec<String>,
    max_results: Option<usize>,
}

#[derive(Serialize)]
pub struct Match {
    line: u32,
    col: u32,
    len: u32,
    text: String,
}

#[derive(Serialize)]
pub struct FileMatches {
    path: String,
    matches: Vec<Match>,
}

#[derive(Serialize)]
pub struct SearchResult {
    files: Vec<FileMatches>,
    truncated: bool,
}

fn build_regex(o: &SearchOpts) -> Result<Regex, String> {
    if o.query.is_empty() {
        return Err("empty query".into());
    }
    let mut pat = if o.regex { o.query.clone() } else { regex::escape(&o.query) };
    if o.word {
        pat = format!(r"\b(?:{pat})\b");
    }
    RegexBuilder::new(&pat)
        .case_insensitive(!o.case)
        .multi_line(true)
        .size_limit(10 << 20)
        .build()
        .map_err(|e| e.to_string())
}

fn walker(root: &str, include: &[String], exclude: &[String]) -> Result<WalkBuilder, String> {
    let mut b = WalkBuilder::new(root);
    b.hidden(false).require_git(false).filter_entry(|e| {
        let n = e.file_name().to_string_lossy();
        n != ".git" && n != "node_modules"
    });
    if !include.is_empty() || !exclude.is_empty() {
        let mut ov = OverrideBuilder::new(root);
        for p in include {
            ov.add(p).map_err(|e| e.to_string())?;
        }
        for p in exclude {
            ov.add(&format!("!{p}")).map_err(|e| e.to_string())?;
        }
        b.overrides(ov.build().map_err(|e| e.to_string())?);
    }
    Ok(b)
}

fn read_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

#[tauri::command(async)]
pub fn search_text(opts: SearchOpts) -> Result<SearchResult, String> {
    let re = build_regex(&opts)?;
    let cap = opts.max_results.unwrap_or(5000);
    let results: Arc<Mutex<Vec<FileMatches>>> = Arc::default();
    let total = Arc::new(AtomicUsize::new(0));
    walker(&opts.root, &opts.include, &opts.exclude)?.build_parallel().run(|| {
        let re = re.clone();
        let results = results.clone();
        let total = total.clone();
        Box::new(move |entry| {
            if total.load(Ordering::Relaxed) >= cap {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let Some(text) = read_text(entry.path()) else { return WalkState::Continue };
            let mut matches = Vec::new();
            for (i, line) in text.lines().enumerate() {
                for m in re.find_iter(line) {
                    if m.start() == m.end() {
                        continue;
                    }
                    matches.push(Match {
                        line: i as u32 + 1,
                        col: utf16_len(&line[..m.start()]) + 1,
                        len: utf16_len(m.as_str()),
                        text: line.chars().take(400).collect(),
                    });
                    if matches.len() >= PER_FILE {
                        break;
                    }
                }
                if matches.len() >= PER_FILE {
                    break;
                }
            }
            if !matches.is_empty() {
                total.fetch_add(matches.len(), Ordering::Relaxed);
                results.lock().unwrap().push(FileMatches { path: entry.path().to_string_lossy().into_owned(), matches });
            }
            WalkState::Continue
        })
    });
    let mut files = std::mem::take(&mut *results.lock().unwrap());
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(SearchResult { files, truncated: total.load(Ordering::Relaxed) >= cap })
}

#[tauri::command(async)]
pub fn replace_in_files(opts: SearchOpts, replacement: String, files: Vec<String>) -> Result<usize, String> {
    let re = build_regex(&opts)?;
    let mut changed = 0;
    for f in files {
        let Some(text) = read_text(Path::new(&f)) else { continue };
        let out = if opts.regex {
            re.replace_all(&text, replacement.as_str())
        } else {
            re.replace_all(&text, regex::NoExpand(&replacement))
        };
        if out != text {
            fs::write(&f, out.as_bytes()).map_err(|e| format!("{f}: {e}"))?;
            changed += 1;
        }
    }
    Ok(changed)
}

#[tauri::command(async)]
pub fn list_files(root: String, limit: Option<usize>) -> Result<Vec<String>, String> {
    let limit = limit.unwrap_or(100_000);
    let mut out = Vec::new();
    for e in walker(&root, &[], &[])?.build().flatten() {
        if e.file_type().is_some_and(|t| t.is_file()) {
            out.push(e.path().to_string_lossy().into_owned());
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(root: &str, q: &str) -> SearchOpts {
        SearchOpts { root: root.into(), query: q.into(), regex: false, case: false, word: false, include: vec![], exclude: vec![], max_results: None }
    }

    #[test]
    fn finds_and_replaces() {
        let dir = std::env::temp_dir().join(format!("lumen-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), "Hello world\nhello again\n").unwrap();
        fs::write(dir.join("sub/b.txt"), "nothing").unwrap();
        fs::write(dir.join("bin.dat"), [0u8, 1, 2, b'h', b'e', b'l', b'l', b'o']).unwrap();
        let root = dir.to_string_lossy().into_owned();
        let r = search_text(opts(&root, "hello")).unwrap();
        assert_eq!(r.files.len(), 1);
        assert_eq!(r.files[0].matches.len(), 2);
        assert_eq!(r.files[0].matches[1].line, 2);
        let mut o = opts(&root, "hello");
        o.case = true;
        assert_eq!(search_text(o.clone()).unwrap().files[0].matches.len(), 1);
        let n = replace_in_files(o, "bye".into(), vec![dir.join("a.txt").to_string_lossy().into_owned()]).unwrap();
        assert_eq!(n, 1);
        assert!(fs::read_to_string(dir.join("a.txt")).unwrap().contains("Hello world\nbye again"));
        let _ = fs::remove_dir_all(&dir);
    }
}
