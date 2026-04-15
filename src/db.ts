/**
 * Database schema and prepared queries for agent-pulse metrics.
 *
 * Uses bun:sqlite directly — zero external dependencies.
 * All tables are created idempotently (IF NOT EXISTS).
 */
import { Database } from "bun:sqlite"

// ── Schema ──────────────────────────────────────────────────────

export function createTables(db: Database) {
  db.run("PRAGMA journal_mode=WAL")

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id     TEXT PRIMARY KEY,
      start_time     INTEGER NOT NULL,
      end_time       INTEGER,
      agent          TEXT,
      model          TEXT,
      provider       TEXT,
      user_prompt    TEXT,
      step_count     INTEGER DEFAULT 0,
      tool_calls     INTEGER DEFAULT 0,
      tool_errors    INTEGER DEFAULT 0,
      retries        INTEGER DEFAULT 0,
      total_cost     REAL    DEFAULT 0,
      input_tokens   INTEGER DEFAULT 0,
      output_tokens  INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cache_read     INTEGER DEFAULT 0,
      cache_write    INTEGER DEFAULT 0,
      has_error      BOOLEAN DEFAULT 0,
      was_reverted   BOOLEAN DEFAULT 0,
      error_messages TEXT    DEFAULT '[]',
      health_score   INTEGER DEFAULT -1,
      agent_config_hash TEXT,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      message_id  TEXT NOT NULL,
      tool_name   TEXT NOT NULL,
      status      TEXT NOT NULL,
      start_time  INTEGER,
      end_time    INTEGER,
      duration_ms INTEGER,
      error       TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS model_calls (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL,
      message_id       TEXT NOT NULL,
      model            TEXT NOT NULL,
      provider         TEXT NOT NULL,
      agent            TEXT,
      input_tokens     INTEGER DEFAULT 0,
      output_tokens    INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cache_read       INTEGER DEFAULT 0,
      cache_write      INTEGER DEFAULT 0,
      cost             REAL    DEFAULT 0,
      created_time     INTEGER,
      completed_time   INTEGER,
      duration_ms      INTEGER,
      finish_reason    TEXT,
      had_error        BOOLEAN DEFAULT 0,
      error_type       TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS step_metrics (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL,
      message_id       TEXT NOT NULL,
      step_index       INTEGER,
      input_tokens     INTEGER DEFAULT 0,
      output_tokens    INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cache_read       INTEGER DEFAULT 0,
      cache_write      INTEGER DEFAULT 0,
      cost             REAL    DEFAULT 0,
      finish_reason    TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // ── NEW: agent config change log ──
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_changes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent        TEXT NOT NULL,
      config_hash  TEXT NOT NULL,
      file_path    TEXT,
      changed_at   INTEGER NOT NULL,
      snapshot     TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_start       ON sessions(start_time)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_agent       ON sessions(agent)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_model       ON sessions(model)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_health      ON sessions(health_score)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_config_hash ON sessions(agent_config_hash)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_tool_exec_session    ON tool_executions(session_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_tool_exec_name       ON tool_executions(tool_name)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_model_calls_session  ON model_calls(session_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_agent_changes_agent  ON agent_changes(agent)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_agent_changes_hash   ON agent_changes(config_hash)`)
}

// ── Prepared queries ────────────────────────────────────────────

export function createQueries(db: Database) {
  return {
    upsertSession: db.prepare(`
      INSERT OR REPLACE INTO sessions
        (session_id, start_time, end_time, agent, model, provider, user_prompt,
         step_count, tool_calls, tool_errors, retries, total_cost,
         input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write,
         has_error, was_reverted, error_messages, health_score, agent_config_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `),

    insertToolExec: db.prepare(`
      INSERT INTO tool_executions
        (session_id, message_id, tool_name, status, start_time, end_time, duration_ms, error)
      VALUES (?,?,?,?,?,?,?,?)
    `),

    insertModelCall: db.prepare(`
      INSERT INTO model_calls
        (session_id, message_id, model, provider, agent,
         input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write,
         cost, created_time, completed_time, duration_ms, finish_reason, had_error, error_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `),

    insertStep: db.prepare(`
      INSERT INTO step_metrics
        (session_id, message_id, step_index,
         input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write,
         cost, finish_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `),

    markReverted: db.prepare(`
      UPDATE sessions
      SET was_reverted = 1, health_score = MAX(0, health_score - 25)
      WHERE session_id = ?
    `),

    // ── Agent change tracking ──

    getLatestAgentHash: db.prepare(`
      SELECT config_hash FROM agent_changes
      WHERE agent = ?
      ORDER BY changed_at DESC
      LIMIT 1
    `),

    insertAgentChange: db.prepare(`
      INSERT INTO agent_changes (agent, config_hash, file_path, changed_at, snapshot)
      VALUES (?,?,?,?,?)
    `),

    // ── Useful analytics queries ──

    healthByAgent: db.prepare(`
      SELECT agent,
             COUNT(*)              AS sessions,
             ROUND(AVG(health_score), 1) AS avg_health,
             SUM(tool_calls)       AS total_tools,
             SUM(tool_errors)      AS total_tool_errors,
             ROUND(SUM(total_cost), 4)   AS total_cost,
             ROUND(AVG(total_cost), 4)   AS avg_cost
      FROM sessions
      WHERE start_time > ?
      GROUP BY agent
      ORDER BY avg_health DESC
    `),

    healthByModel: db.prepare(`
      SELECT model, provider,
             COUNT(*)              AS sessions,
             ROUND(AVG(health_score), 1) AS avg_health,
             ROUND(SUM(total_cost), 4)   AS total_cost
      FROM sessions
      WHERE start_time > ?
      GROUP BY model
      ORDER BY avg_health DESC
    `),

    toolStats: db.prepare(`
      SELECT tool_name,
             COUNT(*)                                    AS calls,
             SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
             ROUND(AVG(duration_ms), 0)                  AS avg_duration_ms
      FROM tool_executions
      WHERE session_id IN (SELECT session_id FROM sessions WHERE start_time > ?)
      GROUP BY tool_name
      ORDER BY calls DESC
    `),

    worstSessions: db.prepare(`
      SELECT session_id, agent, model, health_score, total_cost,
             tool_calls, tool_errors, retries, has_error, was_reverted,
             user_prompt, start_time, agent_config_hash
      FROM sessions
      WHERE start_time > ?
      ORDER BY health_score ASC
      LIMIT ?
    `),

    // Compare health before/after an agent config change
    healthAroundChange: db.prepare(`
      SELECT
        CASE WHEN s.start_time < ac.changed_at THEN 'before' ELSE 'after' END AS period,
        COUNT(*)                       AS sessions,
        ROUND(AVG(s.health_score), 1)  AS avg_health,
        ROUND(AVG(s.total_cost), 4)    AS avg_cost,
        ROUND(AVG(s.tool_errors * 1.0 / MAX(s.tool_calls, 1)), 3) AS avg_tool_error_rate
      FROM sessions s
      JOIN agent_changes ac ON ac.agent = s.agent AND ac.id = ?
      WHERE s.agent = ?
        AND s.start_time BETWEEN ac.changed_at - 604800000 AND ac.changed_at + 604800000
      GROUP BY period
    `),

    recentAgentChanges: db.prepare(`
      SELECT id, agent, config_hash, file_path, changed_at
      FROM agent_changes
      ORDER BY changed_at DESC
      LIMIT ?
    `),
  }
}
