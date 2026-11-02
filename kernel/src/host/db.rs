//! Generic SQLite primitive: one database file per namespace (structural isolation), parameterized
//! statements, transactions. The kernel contains no application schema.
use crate::util::{HResult, HostError};
use base64::Engine;
use parking_lot::Mutex;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::path::Path;

pub struct DbRes {
    pub namespace: String,
    conn: Mutex<Connection>,
}

pub fn valid_namespace(ns: &str) -> bool {
    !ns.is_empty() && ns.len() <= 48 && ns.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn to_sql(v: &Value) -> HResult<SqlValue> {
    Ok(match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() { SqlValue::Integer(i) } else { SqlValue::Real(n.as_f64().unwrap_or(0.0)) }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(o) if o.get("$blob").and_then(|b| b.as_str()).is_some() => {
            let b = base64::engine::general_purpose::STANDARD.decode(o["$blob"].as_str().unwrap()).map_err(|e| HostError::invalid(e.to_string()))?;
            SqlValue::Blob(b)
        }
        other => SqlValue::Text(other.to_string()),
    })
}

fn from_sql(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => json!({"$blob": base64::engine::general_purpose::STANDARD.encode(b)}),
    }
}

fn params(p: &Value) -> HResult<Vec<SqlValue>> {
    match p {
        Value::Null => Ok(vec![]),
        Value::Array(a) => a.iter().map(to_sql).collect(),
        _ => Err(HostError::invalid("params must be an array")),
    }
}

fn sql_err(e: rusqlite::Error) -> HostError {
    let code = match &e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::DatabaseBusy || f.code == rusqlite::ErrorCode::DatabaseLocked => "EBUSY",
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => "ECONSTRAINT",
        _ => "ESQL",
    };
    HostError::new(code, e.to_string())
}

impl DbRes {
    pub fn open(dir: &Path, ns: &str) -> HResult<DbRes> {
        if !valid_namespace(ns) {
            return Err(HostError::invalid(format!("invalid namespace {ns:?}")));
        }
        let conn = Connection::open(dir.join(format!("{ns}.db"))).map_err(sql_err)?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(sql_err)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").map_err(sql_err)?;
        // Generic hardening: modules may not attach other database files.
        conn.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_ATTACHED, 0).map_err(sql_err)?;
        Ok(DbRes { namespace: ns.to_string(), conn: Mutex::new(conn) })
    }

    pub fn query(&self, sql: &str, p: &Value) -> HResult<Value> {
        let conn = self.conn.lock();
        let mut st = conn.prepare(sql).map_err(sql_err)?;
        let names: Vec<String> = st.column_names().into_iter().map(|s| s.to_string()).collect();
        let ps = params(p)?;
        let mut rows = st.query(rusqlite::params_from_iter(ps.iter())).map_err(sql_err)?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().map_err(sql_err)? {
            let mut obj = Map::new();
            for (i, n) in names.iter().enumerate() {
                obj.insert(n.clone(), from_sql(r.get_ref(i).map_err(sql_err)?));
            }
            out.push(Value::Object(obj));
            if out.len() > 100_000 {
                return Err(HostError::new("E2BIG", "query returned too many rows"));
            }
        }
        Ok(Value::Array(out))
    }

    pub fn exec(&self, sql: &str, p: &Value) -> HResult<Value> {
        let conn = self.conn.lock();
        let ps = params(p)?;
        if ps.is_empty() && p.as_array().map(|a| a.is_empty()).unwrap_or(true) && sql.contains(';') && sql.trim_end().trim_end_matches(';').contains(';') {
            conn.execute_batch(sql).map_err(sql_err)?;
            return Ok(json!({"changes": conn.changes()}));
        }
        let n = conn.execute(sql, rusqlite::params_from_iter(ps.iter())).map_err(sql_err)?;
        Ok(json!({"changes": n, "lastInsertRowid": conn.last_insert_rowid()}))
    }

    pub fn transaction(&self, statements: &Value) -> HResult<Value> {
        let arr = statements.as_array().ok_or_else(|| HostError::invalid("statements must be an array"))?;
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(sql_err)?;
        let mut total = 0usize;
        for s in arr {
            let sql = s.get("sql").and_then(|x| x.as_str()).ok_or_else(|| HostError::invalid("statement.sql missing"))?;
            let ps = params(s.get("params").unwrap_or(&Value::Null))?;
            if ps.is_empty() && sql.trim_end().trim_end_matches(';').contains(';') {
                tx.execute_batch(sql).map_err(sql_err)?;
            } else {
                total += tx.execute(sql, rusqlite::params_from_iter(ps.iter())).map_err(sql_err)?;
            }
        }
        tx.commit().map_err(sql_err)?;
        Ok(json!({"changes": total}))
    }
}
