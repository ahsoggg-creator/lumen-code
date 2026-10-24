//! Windows shell integration without admin rights (HKCU only): "Open with" entries for chosen extensions,
//! Explorer context-menu items, and a Default Apps registration so Windows lists Lumen Code in its settings.
//!
//! With `LUMEN_TEST_REG` set, everything is written under `HKCU\Software\LumenTest` instead, so automated tests can
//! exercise this code without touching the user's real file associations.

use crate::util::command;
use serde::Serialize;

const PROG_ID: &str = "LumenCode.File";

fn test_mode() -> bool {
    std::env::var_os("LUMEN_TEST_REG").is_some()
}

/// Root of the file-class tree: the real `Software\Classes`, or a throw-away one for tests.
fn classes() -> &'static str {
    if test_mode() { r"HKCU\Software\LumenTest\Classes" } else { r"HKCU\Software\Classes" }
}

fn caps() -> &'static str {
    if test_mode() { r"HKCU\Software\LumenTest\Capabilities" } else { r"HKCU\Software\Lumen Code\Capabilities" }
}

#[derive(Serialize)]
pub struct AssocStatus {
    exts: Vec<String>,
    context_menu: bool,
    registered: bool,
    /// The registered command points at this very executable (false after the program moved or was reinstalled elsewhere).
    current: bool,
}

fn reg(args: &[&str]) -> bool {
    command("reg").args(args).output().map(|o| o.status.success()).unwrap_or(false)
}

fn reg_out(args: &[&str]) -> Option<String> {
    command("reg").args(args).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// The (Default) value of a key; None when the key or the value does not exist ("(value not set)" in any language).
fn default_value(key: &str) -> Option<String> {
    let out = reg_out(&["query", key, "/ve"])?;
    let line = out.lines().find(|l| l.contains("REG_SZ"))?;
    let v = line.split("REG_SZ").nth(1)?.trim();
    // An unset value prints as "(value not set)" in the console language (OEM-encoded, so never match its text); real class names never start with a bracket.
    (!v.is_empty() && !v.starts_with('(')).then(|| v.to_string())
}

fn add_default(key: &str, value: &str) -> bool {
    reg(&["add", key, "/ve", "/d", value, "/f"])
}

fn add_value(key: &str, name: &str, value: &str) -> bool {
    reg(&["add", key, "/v", name, "/d", value, "/f"])
}

fn exe() -> Result<String, String> {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

pub fn open_command(exe: &str, arg: &str) -> String {
    format!("\"{exe}\" \"{arg}\"")
}

fn clean_ext(e: &str) -> Option<String> {
    let e = e.trim().trim_start_matches('.').to_ascii_lowercase();
    (!e.is_empty() && e.len() <= 16 && e.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '+')).then_some(e)
}

fn register_prog(exe: &str) -> bool {
    let root = format!(r"{}\{PROG_ID}", classes());
    add_default(&root, "Файл Lumen Code")
        && add_default(&format!(r"{root}\DefaultIcon"), &format!("\"{exe}\",0"))
        && add_default(&format!(r"{root}\shell\open\command"), &open_command(exe, "%1"))
}

fn register_capabilities(exe: &str, exts: &[String]) {
    let caps = caps();
    let _ = add_value(caps, "ApplicationName", "Lumen Code");
    let _ = add_value(caps, "ApplicationDescription", "Лёгкий редактор кода");
    let _ = add_value(&format!(r"{caps}\FileAssociations"), ".txt", PROG_ID);
    for e in exts {
        let _ = add_value(&format!(r"{caps}\FileAssociations"), &format!(".{e}"), PROG_ID);
    }
    if !test_mode() {
        let _ = add_value(r"HKCU\Software\RegisteredApplications", "LumenCode", r"Software\Lumen Code\Capabilities");
        let app = r"HKCU\Software\Classes\Applications\LumenCode.exe";
        let _ = add_default(&format!(r"{app}\shell\open\command"), &open_command(exe, "%1"));
        let _ = add_value(app, "FriendlyAppName", "Lumen Code");
    }
}

#[tauri::command(async)]
pub fn assoc_status(exts: Vec<String>) -> AssocStatus {
    let mut on = Vec::new();
    for e in exts.iter().filter_map(|e| clean_ext(e)) {
        if reg(&["query", &format!(r"{}\.{e}\OpenWithProgids", classes()), "/v", PROG_ID]) {
            on.push(e);
        }
    }
    let command_line = reg_out(&["query", &format!(r"{}\{PROG_ID}\shell\open\command", classes()), "/ve"]);
    let current = match (&command_line, exe()) {
        (Some(out), Ok(exe)) => out.to_lowercase().contains(&exe.to_lowercase()),
        _ => false,
    };
    AssocStatus {
        exts: on,
        context_menu: reg(&["query", &format!(r"{}\*\shell\LumenCode", classes())]),
        registered: command_line.is_some(),
        current,
    }
}

#[tauri::command(async)]
pub fn assoc_apply(exts: Vec<String>, all_known: Vec<String>, context_menu: bool) -> Result<(), String> {
    let exe = exe()?;
    if !register_prog(&exe) {
        return Err("не удалось записать данные в реестр (HKCU)".into());
    }
    let want: Vec<String> = exts.iter().filter_map(|e| clean_ext(e)).collect();
    for e in all_known.iter().filter_map(|e| clean_ext(e)) {
        let key = format!(r"{}\.{e}\OpenWithProgids", classes());
        if want.contains(&e) {
            add_value(&key, PROG_ID, "");
        } else {
            reg(&["delete", &key, "/v", PROG_ID, "/f"]);
        }
    }
    register_capabilities(&exe, &want);

    let c = classes();
    let items = [
        (format!(r"{c}\*\shell\LumenCode"), "Открыть в Lumen Code", "%1"),
        (format!(r"{c}\Directory\shell\LumenCode"), "Открыть папку в Lumen Code", "%1"),
        (format!(r"{c}\Directory\Background\shell\LumenCode"), "Открыть папку в Lumen Code", "%V"),
    ];
    for (key, label, arg) in items {
        if context_menu {
            add_default(&key, label);
            add_value(&key, "Icon", &format!("\"{exe}\",0"));
            add_default(&format!(r"{key}\command"), &open_command(&exe, arg));
        } else {
            reg(&["delete", &key, "/f"]);
        }
    }
    Ok(())
}

/// Makes Lumen Code the program that opens these extensions where Windows allows it without the user's own choice:
/// nothing has claimed the extension in HKCU and there is no "UserChoice". Returns the extensions that stay with another
/// program (those can only be changed by the user in Windows Settings, which cannot be done from a program).
#[tauri::command(async)]
pub fn assoc_set_default(exts: Vec<String>) -> Vec<String> {
    let mut blocked = Vec::new();
    for e in exts.iter().filter_map(|e| clean_ext(e)) {
        let user_choice = reg_out(&["query", &format!(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{e}\UserChoice"), "/v", "ProgId"]);
        if user_choice.as_deref().is_some_and(|o| o.contains(PROG_ID)) {
            continue;
        }
        let key = format!(r"{}\.{e}", classes());
        let claimed = default_value(&key).is_some_and(|v| v != PROG_ID);
        if user_choice.is_some() || claimed {
            blocked.push(e);
        } else {
            add_default(&key, PROG_ID);
        }
    }
    blocked
}

#[tauri::command(async)]
pub fn assoc_remove_all(all_known: Vec<String>) {
    let c = classes();
    for e in all_known.iter().filter_map(|e| clean_ext(e)) {
        reg(&["delete", &format!(r"{c}\.{e}\OpenWithProgids"), "/v", PROG_ID, "/f"]);
        // Only undo a default this program set itself.
        if default_value(&format!(r"{c}\.{e}")).as_deref() == Some(PROG_ID) {
            reg(&["delete", &format!(r"{c}\.{e}"), "/ve", "/f"]);
        }
    }
    for key in [
        format!(r"{c}\{PROG_ID}"),
        format!(r"{c}\*\shell\LumenCode"),
        format!(r"{c}\Directory\shell\LumenCode"),
        format!(r"{c}\Directory\Background\shell\LumenCode"),
        caps().to_string(),
    ] {
        reg(&["delete", &key, "/f"]);
    }
    if test_mode() {
        reg(&["delete", r"HKCU\Software\LumenTest", "/f"]);
    } else {
        reg(&["delete", r"HKCU\Software\Classes\Applications\LumenCode.exe", "/f"]);
        reg(&["delete", r"HKCU\Software\Lumen Code", "/f"]);
        reg(&["delete", r"HKCU\Software\RegisteredApplications", "/v", "LumenCode", "/f"]);
    }
}

/// Opens Windows "Default apps" so the user can make Lumen Code the default for the extensions it registered.
#[tauri::command(async)]
pub fn open_default_apps() {
    let _ = command("cmd").args(["/c", "start", "", "ms-settings:defaultapps"]).spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_is_quoted() {
        assert_eq!(open_command(r"C:\Program Files\Lumen\LumenCode.exe", "%1"), r#""C:\Program Files\Lumen\LumenCode.exe" "%1""#);
    }

    #[test]
    fn extensions_are_sanitised() {
        assert_eq!(clean_ext(".PY").as_deref(), Some("py"));
        assert_eq!(clean_ext("c++").as_deref(), Some("c++"));
        assert_eq!(clean_ext("a\\b"), None);
        assert_eq!(clean_ext(""), None);
    }

    /// Writes to the throw-away `HKCU\Software\LumenTest` tree only (env is process-wide, so keep it one test).
    #[test]
    #[cfg(windows)]
    fn registration_roundtrip_in_the_test_tree() {
        std::env::set_var("LUMEN_TEST_REG", "1");
        assert_eq!(classes(), r"HKCU\Software\LumenTest\Classes");
        assoc_apply(vec!["zzt".into(), "zzu".into()], vec!["zzt".into(), "zzu".into()], true).unwrap();
        let s = assoc_status(vec!["zzt".into(), "zzu".into()]);
        assert!(s.registered && s.context_menu && s.current);
        assert_eq!(s.exts, vec!["zzt".to_string(), "zzu".to_string()]);
        assert!(assoc_set_default(vec!["zzt".into()]).is_empty(), "an unclaimed extension becomes ours");
        assert!(reg_out(&["query", r"HKCU\Software\LumenTest\Classes\.zzt", "/ve"]).is_some_and(|o| o.contains(PROG_ID)));
        // A different program already owns .zzu: it must be left alone and reported.
        assert!(add_default(r"HKCU\Software\LumenTest\Classes\.zzu", "Other.File"));
        assert_eq!(assoc_set_default(vec!["zzu".into()]), vec!["zzu".to_string()]);
        assoc_apply(vec!["zzt".into()], vec!["zzt".into(), "zzu".into()], false).unwrap();
        assert!(!assoc_status(vec!["zzt".into()]).context_menu);
        assoc_remove_all(vec!["zzt".into(), "zzu".into()]);
        assert!(!assoc_status(vec!["zzt".into()]).registered);
        assert!(!reg(&["query", r"HKCU\Software\LumenTest"]));
        std::env::remove_var("LUMEN_TEST_REG");
    }
}
