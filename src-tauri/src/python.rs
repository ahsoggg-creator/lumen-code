use crate::tasks::run_capture;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct Interp {
    path: String,
    version: String,
    kind: &'static str,
    is_venv: bool,
}

fn is_store_stub(p: &str) -> bool {
    p.to_ascii_lowercase().contains("\\microsoft\\windowsapps\\")
}

/// Lines of `py -0p`: ` -V:3.12 *        C:\Python312\python.exe`
pub fn parse_py_launcher(out: &str) -> Vec<String> {
    out.lines()
        .filter_map(|l| {
            let b = l.as_bytes();
            let i = (0..b.len().saturating_sub(2)).find(|&i| b[i].is_ascii_alphabetic() && b[i + 1] == b':' && (b[i + 2] == b'\\' || b[i + 2] == b'/'))?;
            let p = l[i..].trim();
            p.to_ascii_lowercase().ends_with(".exe").then(|| p.to_owned())
        })
        .collect()
}

pub fn parse_version(out: &str) -> Option<String> {
    let t = out.trim();
    let v = t.strip_prefix("Python ")?.split_whitespace().next()?;
    v.chars().next().filter(char::is_ascii_digit)?;
    Some(v.to_owned())
}

fn sibling_venv(p: &Path) -> bool {
    p.parent().and_then(Path::parent).is_some_and(|d| d.join("pyvenv.cfg").exists())
}

fn glob_dirs(parent: &Path, prefix: &str) -> Vec<PathBuf> {
    std::fs::read_dir(parent)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_name().to_string_lossy().to_ascii_lowercase().starts_with(prefix))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command(async)]
pub fn py_discover(workspace: Option<String>) -> Vec<Interp> {
    let mut cands: Vec<(String, &'static str)> = Vec::new();
    let no_env = HashMap::new();
    let out = run_capture("py", &["-0p".into()], &None, &no_env, 4000);
    if out.code == 0 {
        // `py -0p` writes to stdout on current versions, stderr on old ones.
        cands.extend(parse_py_launcher(&format!("{}\n{}", out.stdout, out.stderr)).into_iter().map(|p| (p, "installed")));
    }
    for name in ["python", "python3"] {
        let w = run_capture("where", &[name.into()], &None, &no_env, 4000);
        if w.code == 0 {
            cands.extend(w.stdout.lines().map(|l| l.trim().to_owned()).filter(|l| !l.is_empty() && !is_store_stub(l)).map(|p| (p, "path")));
        }
    }
    if let Some(ws) = workspace.as_deref() {
        for n in [".venv", "venv", "env", ".env"] {
            let p = Path::new(ws).join(n).join("Scripts").join("python.exe");
            if p.exists() {
                cands.push((p.to_string_lossy().into_owned(), "venv"));
            }
        }
    }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let pf = std::env::var("ProgramFiles").unwrap_or_default();
    let mut roots: Vec<PathBuf> = Vec::new();
    for d in ["anaconda3", "miniconda3", "miniforge3", "mambaforge"] {
        roots.push(Path::new(&home).join(d));
        roots.push(Path::new("C:\\ProgramData").join(d));
    }
    roots.extend(glob_dirs(&Path::new(&local).join("Programs").join("Python"), "python"));
    roots.extend(glob_dirs(Path::new("C:\\"), "python"));
    roots.extend(glob_dirs(Path::new(&pf), "python"));
    for r in roots {
        let p = r.join("python.exe");
        if p.exists() {
            cands.push((p.to_string_lossy().into_owned(), "installed"));
        }
    }

    let mut seen = HashSet::new();
    cands.retain(|(p, _)| seen.insert(p.to_ascii_lowercase().replace('/', "\\")));
    let handles: Vec<_> = cands
        .into_iter()
        .map(|(p, kind)| {
            std::thread::spawn(move || {
                let o = run_capture(&p, &["--version".into()], &None, &HashMap::new(), 5000);
                let v = parse_version(&o.stdout).or_else(|| parse_version(&o.stderr))?;
                let is_venv = sibling_venv(Path::new(&p));
                Some(Interp { path: p, version: v, kind: if is_venv { "venv" } else { kind }, is_venv })
            })
        })
        .collect();
    let mut res: Vec<Interp> = handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect();
    res.sort_by(|a, b| b.is_venv.cmp(&a.is_venv).then(b.version.cmp(&a.version)));
    res
}

#[derive(Serialize)]
pub struct PypiInfo {
    name: String,
    version: String,
    summary: String,
    home: String,
    requires_python: String,
}

#[tauri::command(async)]
pub fn pypi_info(name: String) -> Result<PypiInfo, String> {
    let ok = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !ok {
        return Err("invalid package name".into());
    }
    let body = crate::net::get_text(&format!("https://pypi.org/pypi/{name}/json"))?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let i = &v["info"];
    let g = |k: &str| i[k].as_str().unwrap_or("").to_owned();
    Ok(PypiInfo { name: g("name"), version: g("version"), summary: g("summary"), home: g("home_page"), requires_python: g("requires_python") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_output() {
        let out = " -V:3.13 *        C:\\Python313\\python.exe\n -V:3.12          C:\\Users\\a b\\AppData\\Local\\Programs\\Python\\Python312\\python.exe\n";
        let p = parse_py_launcher(out);
        assert_eq!(p.len(), 2);
        assert!(p[1].contains("a b"));
    }

    #[test]
    fn versions() {
        assert_eq!(parse_version("Python 3.12.10\r\n").as_deref(), Some("3.12.10"));
        assert_eq!(parse_version("Python was not found"), None);
    }
}
