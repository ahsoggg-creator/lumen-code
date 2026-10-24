//! SQLite inspector: table pages with filter / sort, ad-hoc SQL (read-only unless asked otherwise) and cell edits.
//! Table and column names always come from the database's own catalogue, never straight from the UI into SQL.

use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Value};

const CELL_CAP: usize = 20_000;
/// Error text of `db_query` for statements that change something; the UI then asks before `db_exec`.
pub const WRITE_REQUIRED: &str = "LUMEN_WRITE_REQUIRED";

fn open(path: &str, write: bool) -> Result<Connection, String> {
    let flags = if write { OpenFlags::SQLITE_OPEN_READ_WRITE } else { OpenFlags::SQLITE_OPEN_READ_ONLY };
    let c = Connection::open_with_flags(path, flags).map_err(|e| format!("{path}: {e}"))?;
    c.busy_timeout(std::time::Duration::from_secs(3)).map_err(|e| e.to_string())?;
    // A database from the internet must not be able to run functions its schema smuggled in.
    c.execute_batch("PRAGMA trusted_schema=OFF;").map_err(|e| e.to_string())?;
    Ok(c)
}

fn quote(id: &str) -> String {
    format!("\"{}\"", id.replace('"', "\"\""))
}

fn cell(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) if i.unsigned_abs() < (1 << 53) => json!(i),
        ValueRef::Integer(i) => json!(i.to_string()),
        ValueRef::Real(f) if f.is_finite() => json!(f),
        ValueRef::Real(f) => json!(f.to_string()),
        ValueRef::Text(t) => {
            let s = String::from_utf8_lossy(t);
            json!(if s.chars().count() > CELL_CAP { s.chars().take(CELL_CAP).collect::<String>() + "…" } else { s.into_owned() })
        }
        ValueRef::Blob(b) => json!(format!("<BLOB {} Б>", b.len())),
    }
}

#[derive(Serialize)]
pub struct TableInfo {
    name: String,
    kind: String,
}

#[derive(Serialize)]
pub struct Page {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    rowids: Vec<i64>,
    total: i64,
    editable: bool,
}

fn tables(c: &Connection) -> Result<Vec<TableInfo>, String> {
    let mut st = c
        .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = st.query_map([], |r| Ok(TableInfo { name: r.get(0)?, kind: r.get(1)? })).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn columns_of(c: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut st = c.prepare(&format!("PRAGMA table_info({})", quote(table))).map_err(|e| e.to_string())?;
    let rows = st.query_map([], |r| r.get::<_, String>(1)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// A name that reaches the real rowid even when a column is called `rowid`, `oid` or `_rowid_` (those would shadow it).
fn rowid_alias(cols: &[String]) -> Option<&'static str> {
    ["rowid", "_rowid_", "oid"].into_iter().find(|a| !cols.iter().any(|c| c.eq_ignore_ascii_case(a)))
}

fn checked_table(c: &Connection, table: &str) -> Result<(), String> {
    if tables(c)?.iter().any(|t| t.name == table) { Ok(()) } else { Err(format!("нет таблицы «{table}»")) }
}

#[tauri::command(async)]
pub fn db_tables(path: String) -> Result<Vec<TableInfo>, String> {
    tables(&open(&path, false)?)
}

#[tauri::command(async)]
pub fn db_page(path: String, table: String, filter: String, sort: Option<String>, desc: bool, limit: i64, offset: i64) -> Result<Page, String> {
    let c = open(&path, false)?;
    checked_table(&c, &table)?;
    let cols = columns_of(&c, &table)?;
    let t = quote(&table);
    let alias = rowid_alias(&cols);
    let editable = alias.is_some_and(|a| c.prepare(&format!("SELECT {a} FROM {t} LIMIT 0")).is_ok())
        && tables(&c)?.iter().any(|x| x.name == table && x.kind == "table");

    let like = format!("%{}%", filter.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let wher = if filter.is_empty() || cols.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", cols.iter().map(|k| format!("CAST({} AS TEXT) LIKE ?1 ESCAPE '\\'", quote(k))).collect::<Vec<_>>().join(" OR "))
    };
    let order = match sort.filter(|s| cols.contains(s)) {
        Some(s) => format!(" ORDER BY {} {}", quote(&s), if desc { "DESC" } else { "ASC" }),
        None => String::new(),
    };
    let bind = |st: &mut rusqlite::Statement| -> rusqlite::Result<()> {
        if !wher.is_empty() {
            st.raw_bind_parameter(1, &like)?;
        }
        Ok(())
    };

    let mut cnt = c.prepare(&format!("SELECT COUNT(*) FROM {t}{wher}")).map_err(|e| e.to_string())?;
    bind(&mut cnt).map_err(|e| e.to_string())?;
    let total: i64 = cnt.raw_query().next().map_err(|e| e.to_string())?.map(|r| r.get(0).unwrap_or(0)).unwrap_or(0);

    let select_cols = cols.iter().map(|k| quote(k)).collect::<Vec<_>>().join(", ");
    let rid = if editable { alias.unwrap_or("0") } else { "0" };
    let sql = format!("SELECT {rid}, {select_cols} FROM {t}{wher}{order} LIMIT {} OFFSET {}", limit.clamp(1, 1000), offset.max(0));
    let mut st = c.prepare(&sql).map_err(|e| e.to_string())?;
    bind(&mut st).map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    let mut rowids = Vec::new();
    let mut q = st.raw_query();
    while let Some(r) = q.next().map_err(|e| e.to_string())? {
        rowids.push(r.get::<_, i64>(0).unwrap_or(0));
        rows.push((1..=cols.len()).map(|i| r.get_ref(i).map(cell).unwrap_or(Value::Null)).collect());
    }
    Ok(Page { columns: cols, rows, rowids, total, editable })
}

#[derive(Serialize)]
pub struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    truncated: bool,
}

/// Runs a query on a read-only connection: anything that would write fails inside SQLite itself.
#[tauri::command(async)]
pub fn db_query(path: String, sql: String, limit: usize) -> Result<QueryResult, String> {
    let c = open(&path, false)?;
    let mut st = c.prepare(&sql).map_err(|e| e.to_string())?;
    // `VACUUM INTO` and `ATTACH` create files even on a read-only connection.
    let head = sql.trim_start().to_ascii_uppercase();
    if !st.readonly() || head.starts_with("VACUUM") || head.starts_with("ATTACH") {
        return Err(WRITE_REQUIRED.into());
    }
    let columns: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
    let n = columns.len();
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut q = st.raw_query();
    while let Some(r) = q.next().map_err(|e| e.to_string())? {
        if rows.len() >= limit.clamp(1, 5000) {
            truncated = true;
            break;
        }
        rows.push((0..n).map(|i| r.get_ref(i).map(cell).unwrap_or(Value::Null)).collect());
    }
    Ok(QueryResult { columns, rows, truncated })
}

/// Runs statements that change the database. The UI asks for confirmation before calling it.
#[tauri::command(async)]
pub fn db_exec(path: String, sql: String) -> Result<u64, String> {
    let c = open(&path, true)?;
    let before = c.total_changes();
    c.execute_batch(&sql).map_err(|e| e.to_string())?;
    Ok(c.total_changes() - before)
}

#[tauri::command(async)]
pub fn db_update_cell(path: String, table: String, rowid: i64, column: String, value: Option<String>) -> Result<(), String> {
    let c = open(&path, true)?;
    checked_table(&c, &table)?;
    let cols = columns_of(&c, &table)?;
    if !cols.contains(&column) {
        return Err(format!("нет столбца «{column}»"));
    }
    let alias = rowid_alias(&cols).ok_or("в таблице есть столбцы rowid, _rowid_ и oid: строки нельзя адресовать")?;
    let n = c
        .execute(&format!("UPDATE {} SET {} = ?1 WHERE {alias} = ?2", quote(&table), quote(&column)), rusqlite::params![value, rowid])
        .map_err(|e| e.to_string())?;
    if n == 1 { Ok(()) } else { Err("строка не найдена".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> String {
        let p = std::env::temp_dir().join(format!("lumen-db-test-{}-{:?}.sqlite", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_file(&p);
        let c = Connection::open(&p).unwrap();
        c.execute_batch(
            "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, score REAL, note BLOB);
             INSERT INTO users(name, score) VALUES ('anna', 1.5), ('boris', 2.5), ('50%_off', 3.0);
             CREATE VIEW v AS SELECT name FROM users;",
        )
        .unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn pages_filter_sort_and_edit() {
        let p = sample();
        let t = db_tables(p.clone()).unwrap();
        assert_eq!(t.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["users", "v"]);
        let all = db_page(p.clone(), "users".into(), String::new(), Some("score".into()), true, 100, 0).unwrap();
        assert_eq!((all.total, all.editable), (3, true));
        assert_eq!(all.rows[0][1], json!("50%_off"));
        let f = db_page(p.clone(), "users".into(), "%_".into(), None, false, 100, 0).unwrap();
        assert_eq!(f.total, 1, "wildcards in the filter are literal");
        assert!(!db_page(p.clone(), "v".into(), String::new(), None, false, 10, 0).unwrap().editable);
        db_update_cell(p.clone(), "users".into(), all.rowids[1], "name".into(), Some("zed".into())).unwrap();
        assert!(db_query(p.clone(), "SELECT name FROM users WHERE name='zed'".into(), 10).unwrap().rows.len() == 1);
        assert!(db_update_cell(p.clone(), "users; DROP TABLE users".into(), 1, "name".into(), None).is_err());
        assert!(db_update_cell(p, "users".into(), 1, "nope\" = 1 --".into(), None).is_err());
    }

    #[test]
    fn a_column_named_rowid_does_not_hijack_row_addressing() {
        let p = std::env::temp_dir().join(format!("lumen-db-rowid-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&p);
        let c = Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE t(rowid TEXT, name TEXT); INSERT INTO t VALUES ('a','x'),('b','y');").unwrap();
        drop(c);
        let path = p.to_string_lossy().into_owned();
        let page = db_page(path.clone(), "t".into(), String::new(), None, false, 10, 0).unwrap();
        assert!(page.editable, "_rowid_ still addresses the rows");
        db_update_cell(path.clone(), "t".into(), page.rowids[1], "name".into(), Some("z".into())).unwrap();
        assert_eq!(db_query(path, "SELECT name FROM t ORDER BY name".into(), 10).unwrap().rows, vec![vec![json!("x")], vec![json!("z")]]);
    }

    #[test]
    fn queries_are_read_only() {
        let p = sample();
        assert_eq!(db_query(p.clone(), "DELETE FROM users".into(), 10).err().as_deref(), Some(WRITE_REQUIRED));
        assert!(db_query(p.clone(), "VACUUM INTO 'x.db'".into(), 10).is_err());
        assert!(db_query(p.clone(), "SELECT nope FROM users".into(), 10).err().unwrap() != WRITE_REQUIRED);
        assert_eq!(db_exec(p.clone(), "DELETE FROM users WHERE name='anna'".into()).unwrap(), 1);
        assert_eq!(db_query(p, "SELECT COUNT(*) FROM users".into(), 10).unwrap().rows[0][0], json!(2));
    }
}
