-- The whole schema, one file. New changes go in new numbered files next to this one.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  level TEXT NOT NULL DEFAULT 'warn',
  message TEXT NOT NULL,
  module TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- One row per job per slot. The UNIQUE pair is the lock that makes a job run once per slot.
CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  error TEXT,
  ms INTEGER,
  UNIQUE (job, scheduled_for)
);
CREATE INDEX job_runs_started ON job_runs (started_at);

CREATE TABLE login_failures (
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX login_failures_at ON login_failures (at);

CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY,
  tier TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  ms INTEGER,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE goals (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every message comes in here first, so nothing is lost when filing fails.
CREATE TABLE captures (
  id INTEGER PRIMARY KEY,
  raw_text TEXT,
  source TEXT NOT NULL CHECK (source IN ('web', 'token', 'mcp', 'email', 'system')),
  source_ref TEXT,
  parent_id INTEGER REFERENCES captures (id),
  filed_kind TEXT,
  filed_ref_table TEXT,
  filed_ref_id INTEGER,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'filed', 'low_confidence', 'failed', 'archived')),
  error TEXT,
  receipt TEXT,
  created_at TEXT NOT NULL,
  filed_at TEXT
);
CREATE INDEX captures_parent ON captures (parent_id);

-- status 'held': the text came from outside the app and waits for a tap. A held row is never ranked or shown as a to-do.
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT,
  goal_id INTEGER REFERENCES goals (id) ON DELETE SET NULL,
  due TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done', 'archived', 'held')),
  effort_min INTEGER,
  energy TEXT CHECK (energy IN ('low', 'med', 'high')),
  is_shallow INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'todo' CHECK (kind IN ('todo', 'ongoing', 'reminder')),
  remind_on TEXT,
  urgent INTEGER NOT NULL DEFAULT 0,
  urgent_why TEXT,
  triage_by TEXT,
  snoozed_until TEXT,
  snooze_count INTEGER NOT NULL DEFAULT 0,
  left_off TEXT,
  closed_as TEXT,
  completed_at TEXT,
  source_capture_id INTEGER REFERENCES captures (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_open ON tasks (status, due);

-- task_id stays out of sight until waits_on is finished.
CREATE TABLE task_waits (
  task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  waits_on INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, waits_on)
);

CREATE TABLE confirmations (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'failed')),
  result TEXT,
  error TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX confirmations_pending ON confirmations (status);

-- Work for the runner. status 'held' means the bundle carries outside text and waits for a tap.
CREATE TABLE agent_tasks (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  module TEXT,
  input TEXT NOT NULL,
  output_schema TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'fallback', 'held')),
  result TEXT,
  error TEXT,
  due_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  done_at TEXT,
  handled_at TEXT
);
CREATE INDEX agent_tasks_status ON agent_tasks (status, due_at);

-- One runner pass over what was just filed. `steps` is what Undo puts back.
CREATE TABLE capture_reviews (
  id INTEGER PRIMARY KEY,
  agent_task_id INTEGER NOT NULL REFERENCES agent_tasks (id),
  capture_ids TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  untrusted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'applied', 'no_changes', 'late', 'failed', 'undone')),
  lines TEXT,
  steps TEXT,
  dropped TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX capture_reviews_task ON capture_reviews (agent_task_id);
