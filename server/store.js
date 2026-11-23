/**
 * SQLite 持久化（node:sqlite，零第三方依赖）。
 *
 * 版本模型：
 *  - meta.seq：输入变更计数器。每次新增 / 更正 / 撤回记录 +1；
 *  - meta.publish_version：发布计数器。每次发布快照 +1；
 *  - result_versions：一次发布一行，记录该版本读取的输入快照 input_seq 与截止时刻；
 *  - 结果行（overlap_matches / overlap_gaps / device_results）与版本目录在同一事务内写入，
 *    失败则整体回滚。读者按版本读取，永远看不到半套数据。
 */
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rentals (
  id           TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL,
  record_no    TEXT NOT NULL,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER,
  seq          INTEGER NOT NULL,
  revision     INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rentals_equipment ON rentals(equipment_id, deleted);
CREATE INDEX IF NOT EXISTS idx_rentals_seq ON rentals(seq);

CREATE TABLE IF NOT EXISTS maintenance (
  id           TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL,
  record_no    TEXT NOT NULL,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER,
  seq          INTEGER NOT NULL,
  revision     INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintenance_equipment ON maintenance(equipment_id, deleted);
CREATE INDEX IF NOT EXISTS idx_maintenance_seq ON maintenance(seq);

CREATE TABLE IF NOT EXISTS result_versions (
  version       INTEGER PRIMARY KEY,
  input_seq     INTEGER NOT NULL,
  as_of_ms      INTEGER NOT NULL,
  generated_at  TEXT NOT NULL,
  equipment_ids TEXT NOT NULL,
  CHECK (json_valid(equipment_ids))
);

CREATE TABLE IF NOT EXISTS device_results (
  equipment_id TEXT NOT NULL,
  version      INTEGER NOT NULL,
  input_seq    INTEGER NOT NULL,
  as_of_ms     INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  detail_json  TEXT NOT NULL,
  incremental_json TEXT,
  PRIMARY KEY (equipment_id, version),
  CHECK (json_valid(summary_json)),
  CHECK (json_valid(detail_json))
);
CREATE INDEX IF NOT EXISTS idx_device_results_version ON device_results(version);

CREATE TABLE IF NOT EXISTS overlap_matches (
  equipment_id   TEXT NOT NULL,
  version        INTEGER NOT NULL,
  as_of_ms       INTEGER NOT NULL,
  rental_id      TEXT NOT NULL,
  maintenance_id TEXT NOT NULL,
  start_ms       INTEGER NOT NULL,
  end_ms         INTEGER NOT NULL,
  length_ms      INTEGER NOT NULL,
  PRIMARY KEY (equipment_id, version, rental_id, maintenance_id)
);
CREATE INDEX IF NOT EXISTS idx_overlap_matches_version ON overlap_matches(version);
CREATE INDEX IF NOT EXISTS idx_overlap_matches_rental ON overlap_matches(rental_id);

CREATE TABLE IF NOT EXISTS overlap_gaps (
  equipment_id TEXT NOT NULL,
  version      INTEGER NOT NULL,
  as_of_ms     INTEGER NOT NULL,
  rental_id    TEXT NOT NULL,
  segment_no   INTEGER NOT NULL,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  length_ms    INTEGER NOT NULL,
  PRIMARY KEY (equipment_id, version, rental_id, segment_no)
);
CREATE INDEX IF NOT EXISTS idx_overlap_gaps_version ON overlap_gaps(version);

CREATE TABLE IF NOT EXISTS equipment_index (
  equipment_id TEXT PRIMARY KEY,
  version      INTEGER NOT NULL,
  as_of_ms     INTEGER NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  action       TEXT NOT NULL,
  equipment_id TEXT,
  payload      TEXT,
  CHECK (payload IS NULL OR json_valid(payload))
);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 约束错误可能已自动回滚 */
    }
    throw err;
  }
}

function getMetaNumber(db, key, fallback = 0) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
  return row ? Number(row.value) : fallback;
}

function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}

export function currentSeq(db) {
  return getMetaNumber(db, 'seq', 0);
}

/** 在一个写事务内递增输入变更计数器。 */
export function bumpInputSeq(db) {
  const next = currentSeq(db) + 1;
  setMeta(db, 'seq', next);
  return next;
}

export function currentPublishVersion(db) {
  return getMetaNumber(db, 'publish_version', 0);
}

export function bumpPublishVersion(db) {
  const next = currentPublishVersion(db) + 1;
  setMeta(db, 'publish_version', next);
  return next;
}

function audit(db, action, equipmentId, payload) {
  db.prepare(`INSERT INTO audit_log(at, action, equipment_id, payload) VALUES (?, ?, ?, ?)`).run(
    new Date().toISOString(),
    action,
    equipmentId ?? null,
    payload ? JSON.stringify(payload) : null,
  );
}

/* ------------------------------------------------------------------ 输入记录 */

export function mapRow(row) {
  return {
    id: row.id,
    equipmentId: row.equipment_id,
    recordNo: row.record_no,
    start: row.start_ms,
    end: row.end_ms,
    openEnded: row.end_ms === null,
    seq: row.seq,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export function listEquipment(db) {
  return db
    .prepare(
      `SELECT equipment_id FROM rentals WHERE deleted = 0
       UNION
       SELECT equipment_id FROM maintenance WHERE deleted = 0
       ORDER BY equipment_id`,
    )
    .all()
    .map((r) => r.equipment_id);
}

export function getRental(db, id) {
  return db.prepare(`SELECT * FROM rentals WHERE id = ? AND deleted = 0`).get(id) ?? null;
}

export function getMaintenance(db, id) {
  return db.prepare(`SELECT * FROM maintenance WHERE id = ? AND deleted = 0`).get(id) ?? null;
}

export function listRecords(db, equipmentId) {
  const rentals = db
    .prepare(`SELECT * FROM rentals WHERE equipment_id = ? AND deleted = 0 ORDER BY start_ms, record_no`)
    .all(equipmentId);
  const maintenance = db
    .prepare(`SELECT * FROM maintenance WHERE equipment_id = ? AND deleted = 0 ORDER BY start_ms, record_no`)
    .all(equipmentId);
  return { rentals: rentals.map(mapRow), maintenance: maintenance.map(mapRow) };
}

/** 快照读取：只取 seq <= maxSeq 且未删除的行。 */
export function recordsAtSnapshot(db, equipmentId, maxSeq) {
  const rentals = db
    .prepare(`SELECT * FROM rentals WHERE equipment_id = ? AND deleted = 0 AND seq <= ? ORDER BY start_ms, record_no`)
    .all(equipmentId, maxSeq);
  const maintenance = db
    .prepare(`SELECT * FROM maintenance WHERE equipment_id = ? AND deleted = 0 AND seq <= ? ORDER BY start_ms, record_no`)
    .all(equipmentId, maxSeq);
  return { rentals: rentals.map(mapRow), maintenance: maintenance.map(mapRow) };
}

/**
 * 新增或更正（含撤回后的恢复）。调用方负责在事务中递增 seq 并传入。
 * 设备不可变更（避免把一条记录挂到另一台设备导致两边索引失真）。
 * 返回变更前后的记录，供增量定位受影响的租用段。
 */
export function upsertRecord(db, side, record, seq) {
  const table = side === 'rental' ? 'rentals' : 'maintenance';
  const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(record.id);
  const now = new Date().toISOString();
  if (existing) {
    if (existing.equipment_id !== record.equipmentId) {
      throw new RangeError('不允许把记录改挂到其他设备');
    }
    db.prepare(
      `UPDATE ${table}
       SET record_no = ?, start_ms = ?, end_ms = ?, seq = ?, revision = revision + 1, deleted = 0, updated_at = ?
       WHERE id = ?`,
    ).run(record.recordNo, record.start, record.end, seq, now, record.id);
    audit(db, `${side}.update`, record.equipmentId, { id: record.id, seq });
    return {
      id: record.id,
      seq,
      created: existing.deleted === 1,
      before: existing.deleted === 1 ? null : mapRow(existing),
      after: { id: record.id, equipmentId: record.equipmentId, start: record.start, end: record.end },
    };
  }
  db.prepare(
    `INSERT INTO ${table}(id, equipment_id, record_no, start_ms, end_ms, seq, revision, deleted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`,
  ).run(record.id, record.equipmentId, record.recordNo, record.start, record.end, seq, now);
  audit(db, `${side}.create`, record.equipmentId, { id: record.id, seq });
  return {
    id: record.id,
    seq,
    created: true,
    before: null,
    after: { id: record.id, equipmentId: record.equipmentId, start: record.start, end: record.end },
  };
}

/** 撤回（软删除）。返回设备编号、撤回前的记录与 seq；不存在或已删除返回 null。 */
export function deleteRecord(db, side, id, seq) {
  const table = side === 'rental' ? 'rentals' : 'maintenance';
  const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted = 0`).get(id);
  if (!existing) return null;
  db.prepare(`UPDATE ${table} SET deleted = 1, seq = ?, revision = revision + 1, updated_at = ? WHERE id = ?`).run(
    seq,
    new Date().toISOString(),
    id,
  );
  audit(db, `${side}.delete`, existing.equipment_id, { id, seq });
  return { equipmentId: existing.equipment_id, id, before: mapRow(existing) };
}

/* ------------------------------------------------------------------ 发布结果 */

export function getResult(db, equipmentId, version = null) {
  const row = version === null
    ? db.prepare(`SELECT * FROM device_results WHERE equipment_id = ? ORDER BY version DESC LIMIT 1`).get(equipmentId)
    : db.prepare(`SELECT * FROM device_results WHERE equipment_id = ? AND version = ?`).get(equipmentId, version);
  if (!row) return null;
  const payload = JSON.parse(row.detail_json);
  return {
    equipmentId: row.equipment_id,
    version: row.version,
    inputSeq: row.input_seq,
    asOf: row.as_of_ms,
    generatedAt: row.generated_at,
    summary: JSON.parse(row.summary_json),
    incremental: row.incremental_json ? JSON.parse(row.incremental_json) : null,
    detail: payload.detail,
    rentals: payload.rentals,
    maintenance: payload.maintenance,
  };
}

export function listResults(db) {
  return db
    .prepare(
      `SELECT r.* FROM device_results r
       JOIN (SELECT equipment_id, MAX(version) AS v FROM device_results GROUP BY equipment_id) latest
         ON latest.equipment_id = r.equipment_id AND latest.v = r.version
       ORDER BY r.equipment_id`,
    )
    .all()
    .map((row) => ({
      equipmentId: row.equipment_id,
      version: row.version,
      inputSeq: row.input_seq,
      asOf: row.as_of_ms,
      generatedAt: row.generated_at,
      summary: JSON.parse(row.summary_json),
      incremental: row.incremental_json ? JSON.parse(row.incremental_json) : null,
    }));
}

export function getVersion(db, version) {
  return db.prepare(`SELECT * FROM result_versions WHERE version = ?`).get(version) ?? null;
}

export function latestVersion(db) {
  const row = db.prepare(`SELECT MAX(version) AS v FROM result_versions`).get();
  return row?.v ?? null;
}

export function listVersions(db, limit = 30) {
  const rows = db
    .prepare(`SELECT * FROM result_versions ORDER BY version DESC LIMIT ?`)
    .all(limit);
  const incremental = db.prepare(
    `SELECT equipment_id, incremental_json FROM device_results WHERE version = ? AND incremental_json IS NOT NULL`,
  );
  return rows.map((r) => ({
    version: r.version,
    inputSeq: r.input_seq,
    asOf: r.as_of_ms,
    generatedAt: r.generated_at,
    equipmentIds: JSON.parse(r.equipment_ids),
    incremental: Object.fromEntries(
      incremental
        .all(r.version)
        .map((x) => [x.equipment_id, JSON.parse(x.incremental_json)]),
    ),
  }));
}

export function getEquipmentIndex(db, equipmentId) {
  return db.prepare(`SELECT * FROM equipment_index WHERE equipment_id = ?`).get(equipmentId) ?? null;
}

export function listEquipmentIndex(db) {
  return db
    .prepare(`SELECT * FROM equipment_index ORDER BY equipment_id`)
    .all()
    .map((r) => ({
      equipmentId: r.equipment_id,
      version: r.version,
      asOf: r.as_of_ms,
      updatedAt: r.updated_at,
    }));
}

export function getAudit(db, limit = 200) {
  return db
    .prepare(`SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?`)
    .all(limit)
    .map((r) => ({
      seq: r.seq,
      at: r.at,
      action: r.action,
      equipmentId: r.equipment_id,
      payload: r.payload ? JSON.parse(r.payload) : null,
    }));
}

/**
 * 写入一个完整的发布批次（调用方已开启事务）。
 * 每台设备：替换该版本的结果行 + 明细文档 + 设备索引。
 */
export function writePublishedDevice(db, version, inputSeq, result) {
  const equipmentId = result.equipmentId;
  db.prepare(`DELETE FROM overlap_matches WHERE equipment_id = ? AND version = ?`).run(equipmentId, version);
  db.prepare(`DELETE FROM overlap_gaps WHERE equipment_id = ? AND version = ?`).run(equipmentId, version);

  const insertMatch = db.prepare(
    `INSERT INTO overlap_matches(equipment_id, version, as_of_ms, rental_id, maintenance_id, start_ms, end_ms, length_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertGap = db.prepare(
    `INSERT INTO overlap_gaps(equipment_id, version, as_of_ms, rental_id, segment_no, start_ms, end_ms, length_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of result.detail) {
    for (const m of d.matches) {
      insertMatch.run(equipmentId, version, result.asOf, d.rental.id, m.maintenanceId, m.start, m.end, m.lengthMs);
    }
    d.gaps.forEach((g, i) => {
      insertGap.run(equipmentId, version, result.asOf, d.rental.id, i + 1, g.start, g.end, g.lengthMs);
    });
  }

  db.prepare(
    `INSERT INTO device_results(equipment_id, version, input_seq, as_of_ms, generated_at, summary_json, detail_json, incremental_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(equipment_id, version) DO UPDATE SET
       input_seq = excluded.input_seq, as_of_ms = excluded.as_of_ms, generated_at = excluded.generated_at,
       summary_json = excluded.summary_json, detail_json = excluded.detail_json,
       incremental_json = excluded.incremental_json`,
  ).run(
    equipmentId,
    version,
    inputSeq,
    result.asOf,
    result.generatedAt,
    JSON.stringify(result.summary),
    JSON.stringify({ detail: result.detail, rentals: result.rentals, maintenance: result.maintenance }),
    result.incremental ? JSON.stringify(result.incremental) : null,
  );

  db.prepare(
    `INSERT INTO equipment_index(equipment_id, version, as_of_ms, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(equipment_id) DO UPDATE SET version = excluded.version, as_of_ms = excluded.as_of_ms, updated_at = excluded.updated_at`,
  ).run(equipmentId, version, result.asOf, result.generatedAt);
}

export function writeVersionCatalog(db, version, inputSeq, asOf, generatedAt, equipmentIds) {
  db.prepare(
    `INSERT INTO result_versions(version, input_seq, as_of_ms, generated_at, equipment_ids) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(version) DO UPDATE SET
       input_seq = excluded.input_seq, as_of_ms = excluded.as_of_ms,
       generated_at = excluded.generated_at, equipment_ids = excluded.equipment_ids`,
  ).run(version, inputSeq, asOf, generatedAt, JSON.stringify([...new Set(equipmentIds)].sort()));
}

export { audit, setMeta };

export function nowIso() {
  return new Date().toISOString();
}
