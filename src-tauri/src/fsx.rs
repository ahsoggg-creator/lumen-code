use crate::util::{command, config_dir, mtime_ms};
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_TEXT: u64 = 64 << 20;
const MAX_IMAGE: u64 = 32 << 20;

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    mtime: u64,
}

#[derive(Serialize)]
pub struct FileData {
    content: String,
    encoding: String,
    binary: bool,
    size: u64,
    mtime: u64,
    eol: &'static str,
}

#[derive(Serialize)]
pub struct Paths {
    config: String,
    plugins: String,
    home: String,
    args: Vec<String>,
}

#[tauri::command(async)]
pub fn get_paths() -> Paths {
    let config = config_dir();
    let plugins = config.join("plugins");
    let _ = fs::create_dir_all(&plugins);
    Paths {
        config: config.to_string_lossy().into_owned(),
        plugins: plugins.to_string_lossy().into_owned(),
        home: std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default(),
        args: std::env::args().skip(1).filter(|a| !a.starts_with("--")).collect(),
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[tauri::command(async)]
pub fn read_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for e in fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?.flatten() {
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mut is_dir = meta.is_dir();
        if meta.file_type().is_symlink() {
            is_dir = fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false);
        }
        out.push(Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: s(&e.path()),
            is_dir,
            size: meta.len(),
            mtime: mtime_ms(&meta),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub fn decode(bytes: &[u8], forced: Option<&str>) -> (String, String) {
    if let Some(label) = forced {
        return decode_with(bytes, label);
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(&bytes[3..]).into_owned(), "utf8bom".into());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_with(bytes, "utf16le");
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_with(bytes, "utf16be");
    }
    match std::str::from_utf8(bytes) {
        Ok(t) => (t.to_owned(), "utf8".into()),
        Err(_) => {
            let mut det = chardetng::EncodingDetector::new();
            det.feed(&bytes[..bytes.len().min(1 << 20)], true);
            let enc = det.guess(None, true);
            let (text, _, _) = enc.decode(bytes);
            (text.into_owned(), label_of(enc.name()))
        }
    }
}

fn label_of(name: &str) -> String {
    name.to_ascii_lowercase().replace('-', "")
}

fn decode_with(bytes: &[u8], label: &str) -> (String, String) {
    match label {
        "utf8" => (String::from_utf8_lossy(bytes).into_owned(), "utf8".into()),
        "utf8bom" => {
            let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
            (String::from_utf8_lossy(b).into_owned(), "utf8bom".into())
        }
        "utf16le" | "utf16be" => {
            let be = label == "utf16be";
            let b = if bytes.len() >= 2 && (bytes[0..2] == [0xFF, 0xFE] || bytes[0..2] == [0xFE, 0xFF]) { &bytes[2..] } else { bytes };
            let units: Vec<u16> = b
                .chunks_exact(2)
                .map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) })
                .collect();
            (String::from_utf16_lossy(&units), label.into())
        }
        other => {
            let enc = encoding_rs::Encoding::for_label(other.as_bytes()).unwrap_or(encoding_rs::UTF_8);
            let (text, _, _) = enc.decode(bytes);
            (text.into_owned(), other.into())
        }
    }
}

pub fn encode(text: &str, label: &str) -> Vec<u8> {
    match label {
        "utf8" => text.as_bytes().to_vec(),
        "utf8bom" => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(text.as_bytes());
            v
        }
        "utf16le" => {
            let mut v = vec![0xFF, 0xFE];
            v.extend(text.encode_utf16().flat_map(|u| u.to_le_bytes()));
            v
        }
        "utf16be" => {
            let mut v = vec![0xFE, 0xFF];
            v.extend(text.encode_utf16().flat_map(|u| u.to_be_bytes()));
            v
        }
        other => {
            let enc = encoding_rs::Encoding::for_label(other.as_bytes()).unwrap_or(encoding_rs::UTF_8);
            enc.encode(text).0.into_owned()
        }
    }
}

#[tauri::command(async)]
pub fn read_file(path: String, encoding: Option<String>) -> Result<FileData, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if meta.len() > MAX_TEXT {
        return Err(format!("file is too large ({} MB)", meta.len() >> 20));
    }
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let utf16 = bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]);
    let binary = !utf16 && encoding.is_none() && bytes[..bytes.len().min(8192)].contains(&0);
    if binary {
        return Ok(FileData { content: String::new(), encoding: "binary".into(), binary: true, size: meta.len(), mtime: mtime_ms(&meta), eol: "\n" });
    }
    let (content, enc) = decode(&bytes, encoding.as_deref());
    let eol = if content.contains("\r\n") { "\r\n" } else { "\n" };
    Ok(FileData { content, encoding: enc, binary: false, size: meta.len(), mtime: mtime_ms(&meta), eol })
}

#[tauri::command(async)]
pub fn read_file_b64(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMAGE {
        return Err("file is too large to preview".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command(async)]
pub fn write_file(path: String, content: String, encoding: Option<String>) -> Result<u64, String> {
    if let Some(dir) = Path::new(&path).parent() {
        let _ = fs::create_dir_all(dir);
    }
    let bytes = encode(&content, encoding.as_deref().unwrap_or("utf8"));
    fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))?;
    Ok(fs::metadata(&path).map(|m| mtime_ms(&m)).unwrap_or(0))
}

#[tauri::command(async)]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command(async)]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() && !from.eq_ignore_ascii_case(&to) {
        return Err(format!("{to} already exists"));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn delete_path(path: String, permanent: bool) -> Result<(), String> {
    if permanent {
        let p = Path::new(&path);
        if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }.map_err(|e| e.to_string())
    } else {
        trash::delete(&path).map_err(|e| e.to_string())
    }
}

fn copy_rec(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for e in fs::read_dir(from)? {
            let e = e?;
            copy_rec(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(d) = to.parent() {
            fs::create_dir_all(d)?;
        }
        fs::copy(from, to).map(|_| ())
    }
}

#[tauri::command(async)]
pub fn copy_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("{to} already exists"));
    }
    copy_rec(Path::new(&from), Path::new(&to)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Canonical form of `p` (symlinks, junctions and `..` resolved) without the `\\?\` prefix. A path that does not exist yet
/// (a file about to be created) is resolved through its nearest existing parent.
pub fn real_path_of(p: &Path) -> std::io::Result<PathBuf> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    let base = loop {
        match fs::canonicalize(&cur) {
            Ok(b) => break b,
            Err(e) => {
                let (Some(name), Some(parent)) = (cur.file_name().map(|n| n.to_owned()), cur.parent().map(Path::to_path_buf)) else { return Err(e) };
                if name == ".." {
                    return Err(e);
                }
                tail.push(name);
                cur = parent;
            }
        }
    };
    let mut out = base.to_string_lossy().into_owned();
    if let Some(rest) = out.strip_prefix(r"\\?\UNC\") {
        out = format!(r"\\{rest}");
    } else if let Some(rest) = out.strip_prefix(r"\\?\") {
        out = rest.to_owned();
    }
    let mut out = PathBuf::from(out);
    for part in tail.iter().rev() {
        out.push(part);
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn real_path(path: String) -> Result<String, String> {
    // `..` in the non-existing tail would escape the check, so resolve it lexically first.
    let mut lexical = PathBuf::new();
    for c in Path::new(&path).components() {
        match c {
            std::path::Component::ParentDir => {
                lexical.pop();
            }
            std::path::Component::CurDir => {}
            other => lexical.push(other.as_os_str()),
        }
    }
    real_path_of(&lexical).map(|p| s(&p)).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command(async)]
pub fn reveal_in_explorer(path: String) {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        let _ = command("explorer").arg(&path).spawn();
    } else {
        let _ = command("explorer").arg(format!("/select,{}", path.replace('/', "\\"))).spawn();
    }
}

#[tauri::command(async)]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links can be opened".into());
    }
    command("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encodings() {
        for label in ["utf8", "utf8bom", "utf16le", "utf16be", "windows1251"] {
            let bytes = encode("Привет, мир", label);
            let (text, _) = decode(&bytes, Some(label));
            assert_eq!(text, "Привет, мир", "{label}");
        }
    }

    #[test]
    fn detects_cp1251() {
        let bytes = encode("Это текст в кодировке windows-1251, достаточно длинный для детектора.", "windows1251");
        let (text, enc) = decode(&bytes, None);
        assert!(text.contains("Это текст"), "{enc}");
    }

    #[test]
    fn real_path_resolves_parent_dirs_and_missing_tail() {
        let base = std::env::temp_dir().join(format!("lumen-realpath-{}", std::process::id()));
        fs::create_dir_all(base.join("a")).unwrap();
        let canon_base = real_path_of(&base).unwrap();
        let up = real_path(format!("{}\\a\\..\\..\\{}\\x.txt", base.display(), base.file_name().unwrap().to_string_lossy())).unwrap();
        assert_eq!(up, s(&canon_base.join("x.txt")));
        let outside = real_path(format!("{}\\a\\..\\..\\outside.txt", base.display())).unwrap();
        assert!(!outside.to_lowercase().starts_with(&s(&canon_base).to_lowercase()), "{outside}");
        assert!(!outside.starts_with(r"\\?\"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn bom_stripped() {
        let (t, e) = decode(&[0xEF, 0xBB, 0xBF, b'a'], None);
        assert_eq!((t.as_str(), e.as_str()), ("a", "utf8bom"));
    }
}

/// Opens an existing local file with its default program (browser for .html, etc.).
#[tauri::command(async)]
pub fn open_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("{path}: файл не найден"));
    }
    command("rundll32").args(["url.dll,FileProtocolHandler", &path]).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Re-reads PATH from the registry so programs installed after the editor started (winget) become visible.
#[tauri::command(async)]
pub fn refresh_env() -> Result<(), String> {
    let out = command("powershell")
        .args(["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"])
        .output()
        .map_err(|e| e.to_string())?;
    let fresh = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let old = std::env::var("PATH").unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let merged: Vec<&str> = fresh.split(';').chain(old.split(';')).filter(|p| !p.is_empty() && seen.insert(p.to_ascii_lowercase())).collect();
    std::env::set_var("PATH", merged.join(";"));
    Ok(())
}
