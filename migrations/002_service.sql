
-- 双方主体：电网单位与校内课题组
CREATE TABLE IF NOT EXISTS parties (
    id         TEXT PRIMARY KEY,
    ref        TEXT NOT NULL UNIQUE,
    role       TEXT NOT NULL CHECK (role IN ('grid', 'research')),
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- 需求征集：电网方提交的应用场景，按提交方识别符版本化
CREATE TABLE IF NOT EXISTS demand_versions (
    id               TEXT PRIMARY KEY,
    demand_ref       TEXT NOT NULL,
    party_id         TEXT NOT NULL REFERENCES parties(id),
    version          INTEGER NOT NULL,
    title            TEXT NOT NULL,
    scenario         TEXT,
    target           TEXT,
    metric_code      TEXT NOT NULL,
    metric_revision  TEXT NOT NULL,
    confidentiality  TEXT NOT NULL CHECK (confidentiality IN ('public', 'consortium', 'bilateral')),
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
    created_at       TEXT NOT NULL,
    UNIQUE (demand_ref, version)
);

-- 技术能力声明：校内课题组提交，证据区分实验数据与待验证意向
CREATE TABLE IF NOT EXISTS capability_versions (
    id                TEXT PRIMARY KEY,
    capability_ref    TEXT NOT NULL,
    party_id          TEXT NOT NULL REFERENCES parties(id),
    version           INTEGER NOT NULL,
    title             TEXT NOT NULL,
    metric_code       TEXT NOT NULL,
    metric_revision   TEXT NOT NULL,
    confidentiality   TEXT NOT NULL CHECK (confidentiality IN ('public', 'consortium', 'bilateral')),
    evidence_kind     TEXT NOT NULL CHECK (evidence_kind IN ('experimental', 'intent')),
    evidence_digest   TEXT,
    measured_value    TEXT,
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
    created_at        TEXT NOT NULL,
    UNIQUE (capability_ref, version)
);

-- 配对：同一需求与能力只有一条，确认标记针对当前指标快照；任一方更换指标或保密范围即失效
CREATE TABLE IF NOT EXISTS pairings (
    id                            TEXT PRIMARY KEY,
    demand_ref                    TEXT NOT NULL,
    capability_ref                TEXT NOT NULL,
    demand_version_id             INTEGER NOT NULL REFERENCES demand_versions(id),
    capability_version_id         INTEGER NOT NULL REFERENCES capability_versions(id),
    grid_party_id                 TEXT NOT NULL REFERENCES parties(id),
    research_party_id             TEXT NOT NULL REFERENCES parties(id),
    metric_code_demand            TEXT NOT NULL,
    metric_revision_demand        TEXT NOT NULL,
    confidentiality_demand        TEXT NOT NULL,
    metric_code_capability        TEXT NOT NULL,
    metric_revision_capability    TEXT NOT NULL,
    confidentiality_capability    TEXT NOT NULL,
    status                        TEXT NOT NULL DEFAULT 'proposed'
                                  CHECK (status IN ('proposed', 'confirmed', 'metric_changed')),
    grid_confirmed_at             TEXT,
    research_confirmed_at         TEXT,
    confirmed_at                  TEXT,
    created_at                    TEXT NOT NULL,
    updated_at                    TEXT NOT NULL,
    UNIQUE (demand_ref, capability_ref)
);

-- 联合验证结论：只追加，不更新不删除；失败结论永久保留，归属与当时的指标快照一并固化
CREATE TABLE IF NOT EXISTS verifications (
    id                          TEXT PRIMARY KEY,
    pairing_id                  TEXT NOT NULL REFERENCES pairings(id),
    demand_version_id           TEXT NOT NULL REFERENCES demand_versions(id),
    capability_version_id       TEXT NOT NULL REFERENCES capability_versions(id),
    owner_party_id              TEXT NOT NULL REFERENCES parties(id),
    owner_role                  TEXT NOT NULL CHECK (owner_role IN ('grid', 'research')),
    result                      TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'inconclusive')),
    conclusion                  TEXT NOT NULL,
    evidence_ref                TEXT,
    capability_evidence_kind    TEXT NOT NULL CHECK (capability_evidence_kind IN ('experimental', 'intent')),
    capability_evidence_digest  TEXT,
    metric_code                 TEXT NOT NULL,
    metric_revision_demand      TEXT NOT NULL,
    metric_revision_capability  TEXT NOT NULL,
    confidentiality_demand      TEXT NOT NULL,
    confidentiality_capability  TEXT NOT NULL,
    snapshot                    TEXT NOT NULL,
    created_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_demand_versions_ref ON demand_versions(demand_ref, version);
CREATE INDEX IF NOT EXISTS idx_capability_versions_ref ON capability_versions(capability_ref, version);
CREATE INDEX IF NOT EXISTS idx_verifications_pairing ON verifications(pairing_id, created_at);

INSERT OR IGNORE INTO schema_migrations(version) VALUES ('002_service');
