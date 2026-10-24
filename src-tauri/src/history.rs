//! Local history ("Timeline"): every saved or paused-on version of a file goes into a SQLite database,
//! compressed with zstd against the previous version (a delta), with a full keyframe every `KEYFRAME` versions.

use crate::util::config_dir;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::State;

const KEYFRAME: i64 = 20;
const KEEP: i64 = 300;
const LEVEL: i32 = 9;

pub struct History(Mutex<Option<Connection>>);

impl Default for History {
    fn default() -> Self {
        History(Mutex::new(None))
    }
}

#[derive(Serialize)]
pub struct Version {
    id: i64,
    ts: i64,
    size: i64,
}

fn open_db(conn: Connection) -> rusqlite::Result<Connection> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS snap (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            ts INTEGER NOT NULL,
            hash TEXT NOT NULL,
            size INTEGER NOT NULL,
            base INTEGER,
            data BLOB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS snap_path ON snap(path, id);",
    )?;
    Ok(conn)
}

fn key(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn compress(text: &str, dict: Option<&str>) -> Result<Vec<u8>, String> {
    let mut c = match dict {
        Some(d) => zstd::bulk::Compressor::with_dictionary(LEVEL, d.as_bytes()),
        None => zstd::bulk::Compressor::new(LEVEL),
    }
    .map_err(|e| e.to_string())?;
    c.compress(text.as_bytes()).map_err(|e| e.to_string())
}

fn decompress(data: &[u8], dict: Option<&str>, size: usize) -> Result<String, String> {
    let mut d = match dict {
        Some(x) => zstd::bulk::Decompressor::with_dictionary(x.as_bytes()),
        None => zstd::bulk::Decompressor::new(),
    }
    .map_err(|e| e.to_string())?;
    let out = d.decompress(data, size.max(1) + 1).map_err(|e| e.to_string())?;
    String::from_utf8(out).map_err(|e| e.to_string())
}

fn restore(db: &Connection, id: i64) -> Result<String, String> {
    let row: (Option<i64>, Vec<u8>, i64) = db
        .query_row("SELECT base, data, size FROM snap WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?;
    let dict = match row.0 {
        Some(b) => Some(restore(db, b)?),
        None => None,
    };
    decompress(&row.1, dict.as_deref(), row.2 as usize)
}

/// Stores `text` as a new version of `path` unless it equals the latest one. Returns whether a row was added.
fn save(db: &Connection, path: &str, text: &str, now: i64) -> Result<bool, String> {
    let p = key(path);
    let h = hash(text);
    let last: Option<(i64, String)> = db
        .query_row("SELECT id, hash FROM snap WHERE path=?1 ORDER BY id DESC LIMIT 1", [&p], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    if last.as_ref().is_some_and(|(_, lh)| *lh == h) {
        return Ok(false);
    }
    let since_key: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM snap WHERE path=?1 AND id > COALESCE((SELECT MAX(id) FROM snap WHERE path=?1 AND base IS NULL), 0)",
            [&p],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let (base, data) = match &last {
        Some((id, _)) if since_key < KEYFRAME => {
            let prev = restore(db, *id)?;
            (Some(*id), compress(text, Some(&prev))?)
        }
        _ => (None, compress(text, None)?),
    };
    db.execute(
        "INSERT INTO snap(path, ts, hash, size, base, data) VALUES (?1,?2,?3,?4,?5,?6)",
        params![p, now, h, text.len() as i64, base, data],
    )
    .map_err(|e| e.to_string())?;
    prune(db, &p)?;
    Ok(true)
}

/// Drops the oldest versions, always cutting at a keyframe so no kept version loses its base.
fn prune(db: &Connection, p: &str) -> Result<(), String> {
    let count: i64 = db.query_row("SELECT COUNT(*) FROM snap WHERE path=?1", [p], |r| r.get(0)).map_err(|e| e.to_string())?;
    if count <= KEEP {
        return Ok(());
    }
    let cut: Option<i64> = db
        .query_row(
            "SELECT MIN(id) FROM snap WHERE path=?1 AND base IS NULL AND id > (SELECT id FROM snap WHERE path=?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)",
            params![p, KEEP - KEYFRAME * 2],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if let Some(c) = cut {
        db.execute("DELETE FROM snap WHERE path=?1 AND id < ?2", params![p, c]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn with_db<T>(h: &State<'_, History>, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let mut g = h.0.lock().map_err(|_| "history lock")?;
    if g.is_none() {
        let dir = config_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        *g = Some(open_db(Connection::open(dir.join("history.db")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?);
    }
    f(g.as_ref().unwrap())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Files that usually hold secrets never enter the history (it is an unencrypted database), nor do big ones.
const MAX_BYTES: usize = 5 * 1024 * 1024;

pub fn excluded(path: &str, len: usize) -> bool {
    if len > MAX_BYTES {
        return true;
    }
    let name = path.replace('/', "\\").rsplit('\\').next().unwrap_or("").to_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".env")
        || [".pem", ".key", ".pfx", ".p12", ".kdbx", ".ppk", ".jks", ".keystore"].iter().any(|e| name.ends_with(e))
        || [".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].contains(&name.as_str())
        || name.starts_with("secret")
}

#[tauri::command(async)]
pub fn history_save(h: State<'_, History>, path: String, content: String) -> Result<bool, String> {
    if excluded(&path, content.len()) {
        return Ok(false);
    }
    with_db(&h, |db| save(db, &path, &content, now_ms()))
}

/// Deletes every stored version of one file; returns how many were removed.
#[tauri::command(async)]
pub fn history_clear(h: State<'_, History>, path: String) -> Result<usize, String> {
    with_db(&h, |db| db.execute("DELETE FROM snap WHERE path=?1", [key(&path)]).map_err(|e| e.to_string()))
}

/// Deletes the whole history and shrinks the database file.
#[tauri::command(async)]
pub fn history_clear_all(h: State<'_, History>) -> Result<usize, String> {
    with_db(&h, |db| {
        let n = db.execute("DELETE FROM snap", []).map_err(|e| e.to_string())?;
        let _ = db.execute_batch("VACUUM");
        Ok(n)
    })
}

#[tauri::command(async)]
pub fn history_list(h: State<'_, History>, path: String) -> Result<Vec<Version>, String> {
    with_db(&h, |db| {
        let mut st = db.prepare("SELECT id, ts, size FROM snap WHERE path=?1 ORDER BY id DESC").map_err(|e| e.to_string())?;
        let rows = st.query_map([key(&path)], |r| Ok(Version { id: r.get(0)?, ts: r.get(1)?, size: r.get(2)? })).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
}

#[tauri::command(async)]
pub fn history_get(h: State<'_, History>, id: i64) -> Result<String, String> {
    with_db(&h, |db| restore(db, id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        open_db(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn versions_roundtrip_through_deltas() {
        let db = mem();
        let mut texts = Vec::new();
        for i in 0..50 {
            let t = format!("{}line {i} привет\n", "common prefix of the file\n".repeat(40));
            assert!(save(&db, r"C:\A\f.py", &t, i).unwrap());
            texts.push(t);
        }
        let ids: Vec<i64> = db.prepare("SELECT id FROM snap ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect();
        for (id, t) in ids.iter().zip(&texts) {
            assert_eq!(&restore(&db, *id).unwrap(), t);
        }
        let keyframes: i64 = db.query_row("SELECT COUNT(*) FROM snap WHERE base IS NULL", [], |r| r.get(0)).unwrap();
        assert!(keyframes >= 2);
        let total: i64 = db.query_row("SELECT SUM(LENGTH(data)) FROM snap", [], |r| r.get(0)).unwrap();
        assert!(total < texts.iter().map(|t| t.len() as i64).sum::<i64>() / 4);
    }

    #[test]
    fn secrets_and_big_files_are_not_recorded() {
        for p in [r"C:\p\.env", r"C:\p\.env.local", "a/b/server.pem", "k.KEY", "x.pfx", r"C:\u\.ssh\id_rsa", "secrets.json"] {
            assert!(excluded(p, 10), "{p}");
        }
        assert!(excluded("big.txt", MAX_BYTES + 1));
        assert!(!excluded(r"C:\p\main.py", 10) && !excluded("environment.ts", 10) && !excluded("keys.ts", 10));
    }

    #[test]
    fn clearing_removes_only_that_file() {
        let db = mem();
        save(&db, "a", "1", 1).unwrap();
        save(&db, "b", "2", 2).unwrap();
        assert_eq!(db.execute("DELETE FROM snap WHERE path=?1", [key("A")]).unwrap(), 1);
        let n: i64 = db.query_row("SELECT COUNT(*) FROM snap", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn identical_content_is_skipped_and_paths_are_case_insensitive() {
        let db = mem();
        assert!(save(&db, r"C:\A\f.py", "x", 1).unwrap());
        assert!(!save(&db, "c:/a/F.PY", "x", 2).unwrap());
    }

    #[test]
    fn pruning_keeps_every_remaining_version_restorable() {
        let db = mem();
        for i in 0..(KEEP + 80) {
            save(&db, "f", &format!("version {i}\n{}", "body\n".repeat(30)), i).unwrap();
        }
        let n: i64 = db.query_row("SELECT COUNT(*) FROM snap", [], |r| r.get(0)).unwrap();
        assert!(n <= KEEP && n > KEEP / 2, "kept {n}");
        let ids: Vec<i64> = db.prepare("SELECT id FROM snap").unwrap().query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect();
        for id in ids {
            restore(&db, id).unwrap();
        }
    }
}
