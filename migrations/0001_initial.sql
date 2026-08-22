PRAGMA foreign_keys = ON;

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  service TEXT NOT NULL,
  project_details TEXT NOT NULL,
  deadline TEXT,
  artwork_status TEXT,
  source_path TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  email_sent_at TEXT,
  email_error TEXT
);

CREATE TABLE lead_files (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  original_name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
);

CREATE INDEX idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX idx_lead_files_lead_id ON lead_files(lead_id);
