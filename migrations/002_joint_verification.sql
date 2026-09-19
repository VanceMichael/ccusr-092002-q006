
CREATE TABLE IF NOT EXISTS declarations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_role TEXT NOT NULL CHECK (party_role IN ('research', 'demand')),
    party_ref TEXT NOT NULL,
    metric_code TEXT NOT NULL,
    metric_revision TEXT NOT NULL,
    evidence_digest TEXT NOT NULL,
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('experimental_data', 'intent')),
    confidentiality_level TEXT NOT NULL CHECK (confidentiality_level IN ('public', 'internal', 'restricted')),
    public_scope TEXT NOT NULL,
    submitted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS declaration_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    declaration_id INTEGER NOT NULL REFERENCES declarations(id),
    previous_metric_code TEXT NOT NULL,
    previous_metric_revision TEXT NOT NULL,
    next_metric_code TEXT NOT NULL,
    next_metric_revision TEXT NOT NULL,
    changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    research_declaration_id INTEGER NOT NULL REFERENCES declarations(id),
    demand_declaration_id INTEGER NOT NULL REFERENCES declarations(id),
    status TEXT NOT NULL CHECK (status IN ('pending_confirmation', 'active', 'concluded')),
    research_confirmed_at TEXT,
    demand_confirmed_at TEXT,
    created_at TEXT NOT NULL,
    activated_at TEXT
);

CREATE TABLE IF NOT EXISTS verification_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES verification_sessions(id),
    outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
    conclusion TEXT NOT NULL,
    attribution TEXT NOT NULL CHECK (attribution IN ('research', 'demand', 'shared')),
    recorded_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations(version) VALUES ('002_joint_verification');
