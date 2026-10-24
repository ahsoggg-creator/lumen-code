use crate::util::{command, ExecOut};
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct GitFile {
    path: String,
    index: char,
    work: char,
    orig: Option<String>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct GitStatus {
    is_repo: bool,
    root: String,
    branch: String,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<GitFile>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Hunk {
    start: u32,
    count: u32,
    kind: &'static str,
}

#[derive(Serialize)]
pub struct Commit {
    hash: String,
    author: String,
    date: String,
    subject: String,
}

/// `git` without the repo-config hooks that run a program on a plain `status` (a cloned repo's `core.fsmonitor`) or via `ext::` remotes.
fn git_cmd() -> std::process::Command {
    let mut c = command("git");
    c.args(["-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"]);
    c
}

fn run(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = git_cmd().current_dir(cwd).args(args).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

pub fn parse_status(raw: &str) -> GitStatus {
    let mut st = GitStatus { is_repo: true, ..Default::default() };
    let mut it = raw.split('\0');
    while let Some(rec) = it.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("## ") {
            let (names, tracking) = match h.split_once(" [") {
                Some((a, b)) => (a, Some(b.trim_end_matches(']'))),
                None => (h, None),
            };
            let (branch, upstream) = match names.split_once("...") {
                Some((b, u)) => (b, Some(u.to_owned())),
                None => (names, None),
            };
            st.branch = branch.strip_prefix("No commits yet on ").unwrap_or(branch).to_owned();
            st.upstream = upstream;
            if let Some(t) = tracking {
                for part in t.split(", ") {
                    if let Some(n) = part.strip_prefix("ahead ") {
                        st.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix("behind ") {
                        st.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let mut chars = rec.chars();
        let (Some(x), Some(y)) = (chars.next(), chars.next()) else { continue };
        let path = rec.get(3..).unwrap_or("").to_owned();
        let orig = if x == 'R' || x == 'C' { it.next().map(str::to_owned) } else { None };
        st.files.push(GitFile { path, index: x, work: y, orig });
    }
    st
}

pub fn parse_hunks(diff: &str) -> Vec<Hunk> {
    let mut out = Vec::new();
    for line in diff.lines() {
        let Some(rest) = line.strip_prefix("@@ -") else { continue };
        let Some((old, rest)) = rest.split_once(" +") else { continue };
        let new = rest.split(" @@").next().unwrap_or("");
        let pair = |s: &str| -> (u32, u32) {
            match s.split_once(',') {
                Some((a, b)) => (a.parse().unwrap_or(0), b.parse().unwrap_or(0)),
                None => (s.parse().unwrap_or(0), 1),
            }
        };
        let (_, old_n) = pair(old);
        let (start, count) = pair(new);
        if count == 0 {
            out.push(Hunk { start: start.max(1), count: 1, kind: "deleted" });
        } else if old_n == 0 {
            out.push(Hunk { start, count, kind: "added" });
        } else {
            out.push(Hunk { start, count, kind: "modified" });
        }
    }
    out
}

#[tauri::command(async)]
pub fn git_status(cwd: String) -> GitStatus {
    let Ok(root) = run(&cwd, &["rev-parse", "--show-toplevel"]) else { return GitStatus::default() };
    let raw = run(&cwd, &["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]).unwrap_or_default();
    let mut st = parse_status(&raw);
    st.root = root.trim().replace('/', "\\");
    st
}

/// Content of `path` at `rev` ("HEAD") or in the index (rev = "").
#[tauri::command(async)]
pub fn git_show(root: String, path: String, rev: String) -> Result<String, String> {
    let spec = format!("{rev}:{}", path.replace('\\', "/"));
    run(&root, &["show", &spec])
}

#[tauri::command(async)]
pub fn git_diff_hunks(root: String, path: String) -> Vec<Hunk> {
    let p = path.replace('\\', "/");
    let diff = run(&root, &["diff", "HEAD", "-U0", "--no-color", "--no-ext-diff", "--", &p])
        .or_else(|_| run(&root, &["diff", "-U0", "--no-color", "--no-ext-diff", "--", &p]))
        .unwrap_or_default();
    parse_hunks(&diff)
}

#[tauri::command(async)]
pub fn git_log(root: String, limit: u32, path: Option<String>) -> Vec<Commit> {
    let n = format!("-n{}", limit.min(500));
    let mut args = vec!["log", &n, "--date=short", "--pretty=format:%h%x1f%an%x1f%ad%x1f%s"];
    let p;
    if let Some(path) = &path {
        p = path.replace('\\', "/");
        args.push("--");
        args.push(&p);
    }
    run(&root, &args)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\x1f');
            Some(Commit { hash: f.next()?.into(), author: f.next()?.into(), date: f.next()?.into(), subject: f.next()?.into() })
        })
        .collect()
}

/// Runs `git <args>` and returns the exit code with both streams (used for stage/commit/checkout/push...).
#[tauri::command(async)]
pub fn git_exec(cwd: String, args: Vec<String>) -> ExecOut {
    match git_cmd().current_dir(&cwd).args(&args).output() {
        Ok(o) => ExecOut {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        },
        Err(e) => ExecOut { code: -1, stdout: String::new(), stderr: format!("git: {e}") },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_parsing() {
        let raw = "## main...origin/main [ahead 2, behind 1]\0 M src/a.rs\0A  new.txt\0R  b.txt\0a.txt\0?? u.txt\0";
        let st = parse_status(raw);
        assert_eq!((st.branch.as_str(), st.ahead, st.behind), ("main", 2, 1));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!(st.files.len(), 4);
        assert_eq!(st.files[0], GitFile { path: "src/a.rs".into(), index: ' ', work: 'M', orig: None });
        assert_eq!(st.files[2].orig.as_deref(), Some("a.txt"));
        assert_eq!(st.files[3].work, '?');
    }

    #[test]
    fn fresh_repo_branch() {
        assert_eq!(parse_status("## No commits yet on master\0").branch, "master");
    }

    #[test]
    fn hunks() {
        let d = "@@ -1,0 +2,3 @@\n+a\n@@ -10,2 +12,2 @@\n@@ -20,3 +21,0 @@\n";
        let h = parse_hunks(d);
        assert_eq!(h[0], Hunk { start: 2, count: 3, kind: "added" });
        assert_eq!(h[1].kind, "modified");
        assert_eq!(h[2], Hunk { start: 21, count: 1, kind: "deleted" });
    }
}
