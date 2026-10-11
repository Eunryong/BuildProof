CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  created_at TEXT NOT NULL,
  record_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS submissions_owner_created
  ON submissions(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS interview_proofs (
  id TEXT PRIMARY KEY,
  report_id TEXT,
  owner_id TEXT,
  status TEXT NOT NULL,
  issued_at TEXT,
  record_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS interview_proofs_report_id
  ON interview_proofs(report_id);

CREATE TABLE IF NOT EXISTS interview_state (
  owner_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
