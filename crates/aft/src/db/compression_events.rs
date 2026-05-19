use rusqlite::{params, Connection};

pub struct CompressionEventRow<'a> {
    pub harness: &'a str,
    pub session_id: Option<&'a str>,
    pub project_key: &'a str,
    pub tool: &'a str,
    pub task_id: Option<&'a str>,
    pub command: Option<&'a str>,
    pub compressor: &'a str,
    pub original_bytes: i64,
    pub compressed_bytes: i64,
    pub original_tokens: u32,
    pub compressed_tokens: u32,
    pub created_at: i64,
}

pub fn insert_compression_event(
    conn: &Connection,
    row: &CompressionEventRow<'_>,
) -> rusqlite::Result<()> {
    conn.execute(
        r#"
        INSERT INTO compression_events (
            harness, session_id, project_key, tool, task_id, command, compressor,
            original_bytes, compressed_bytes, original_tokens, compressed_tokens, created_at
        )
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
        WHERE NOT EXISTS (
            SELECT 1
            FROM compression_events
            WHERE harness = ?1
              AND session_id IS ?2
              AND task_id IS ?5
              AND tool = ?4
            LIMIT 1
        )
        "#,
        params![
            row.harness,
            row.session_id,
            row.project_key,
            row.tool,
            row.task_id,
            row.command,
            row.compressor,
            row.original_bytes,
            row.compressed_bytes,
            row.original_tokens,
            row.compressed_tokens,
            row.created_at,
        ],
    )?;
    Ok(())
}
