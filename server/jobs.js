/**
 * 加工作业与发布。
 *
 * 一致性：
 *  - 每次发布生成一个全局版本 N（meta.publish_version + 1），记录读取的输入快照 input_seq
 *    与固定截止时刻 asOf；
 *  - 发布事务内：受影响设备重算并写入版本 N；其余设备把上一版的结果行原样复制到版本 N。
 *    因此版本 N 永远是完整视图，读者按版本号查询不会看到半套数据或新旧混合；
 *  - 只有全部写入成功才提交，失败整体回滚（索引与明细同进同退）。
 *
 * 只重建必要区间：
 *  - 记录变更只影响其所属设备（设备编号不可更改，见 store.upsertRecord）；
 *  - 保养记录变化时，只重算“与旧有效区间或新有效区间相交”的租用段：
 *    未相交租用段内部的覆盖并集没有变化，其匹配与空档可以直接沿用上一版本；
 *  - 租用记录变化只重算该租用段本身；
 *  - 截止时刻变化才整设备全量重算（开放段截断位置变了）；
 *  - 受影响的段一律从“当前输入”重新推导，所以撤回保养后空档会重新出现、
 *    重叠区也可能被切成多段 —— 不存在“在旧结果上做减法”的路径。
 */
import { computeRentalDetail, effectiveInterval, intersect } from './engine.js';
import { displayOf, isoOf } from './engine.js';
import {
  bumpPublishVersion,
  currentSeq,
  latestVersion,
  listEquipment,
  nowIso,
  recordsAtSnapshot,
  tx,
  writePublishedDevice,
  writeVersionCatalog,
} from './store.js';

function openCount(rows) {
  return rows.filter((r) => r.end === null).length;
}

/** 由明细行汇总设备级指标。所有长度均来自切段累加。 */
function summarize(equipmentId, version, asOf, rentals, maintenance, detail) {
  let rentalLength = 0;
  let matchLength = 0;
  let unionLength = 0;
  let gapLength = 0;
  let matchCount = 0;
  let gapCount = 0;
  let coveredRentalCount = 0;
  let partialCount = 0;
  let cleanCount = 0;
  let gapOnlyCount = 0;
  let untouchedCount = 0;

  for (const d of detail) {
    rentalLength += d.rentalLength;
    matchLength += d.matchLength;
    unionLength += d.unionLength;
    gapLength += d.gapLength;
    matchCount += d.overlapCount;
    gapCount += d.gaps.length;
    if (d.overlapCount > 0 && d.gapLength > 0) partialCount += 1;
    else if (d.overlapCount > 0) cleanCount += 1;
    else if (d.gaps.length > 0) gapOnlyCount += 1;
    if (d.overlapCount > 0) coveredRentalCount += 1;
    if (d.untouched) untouchedCount += 1;
  }

  return {
    equipmentId,
    version,
    asOf,
    rentalCount: rentals.length,
    maintenanceCount: maintenance.length,
    openRentalCount: openCount(rentals),
    openMaintenanceCount: openCount(maintenance),
    rentalLength,
    unionLength,
    matchLength,
    gapLength,
    matchCount,
    gapCount,
    coveredRentalCount,
    partialCount,
    cleanCount,
    gapOnlyCount,
    untouchedCount,
    doubleCoveredMs: matchLength - unionLength,
    uncoveredRatio: rentalLength > 0 ? gapLength / rentalLength : 0,
  };
}

/** 记录行 -> 用于相交判断的有效区间。 */
function effOf(row, asOf) {
  return effectiveInterval({ start: row.start, end: row.end, openEnded: row.end === null }, asOf);
}

/**
 * 计算单台设备在快照下的结果，并尽量复用上一版本中未受影响租用段的明细。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} equipmentId
 * @param {{asOf:number, version:number, inputSeq:number,
 *          changed:Array<{side:'rental'|'maintenance', id:string, before?:object|null, after?:object|null}>|null,
 *          prevResult:object|null}} ctx
 */
export function computeDeviceResult(db, equipmentId, { asOf, version, inputSeq, changed, prevResult }) {
  const { rentals, maintenance } = recordsAtSnapshot(db, equipmentId, inputSeq);
  const prevDetail = prevResult?.detail ?? [];
  const cutoffChanged = !prevResult || prevResult.asOf !== asOf;
  const prevDetailMap = new Map(prevDetail.map((d) => [d.rental.id, d]));

  const affected = new Set();
  const reasons = new Map();
  const mark = (rentalId, reason) => {
    affected.add(rentalId);
    if (!reasons.has(rentalId)) reasons.set(rentalId, []);
    if (!reasons.get(rentalId).includes(reason)) reasons.get(rentalId).push(reason);
  };

  if (cutoffChanged) {
    for (const r of rentals) mark(r.id, prevResult ? '截止时刻变化，整设备重算' : '首次发布，全量加工');
  } else if (!changed || changed.length === 0) {
    for (const r of rentals) mark(r.id, '未提供变更定位，保守全量重算');
  } else {
    const maintenanceChanges = changed.filter((c) => c.side === 'maintenance');
    if (maintenanceChanges.length) {
      const intervals = [];
      for (const c of maintenanceChanges) {
        if (c.before) intervals.push(effOf(c.before, asOf));
        if (c.after) intervals.push(effOf(c.after, asOf));
      }
      for (const r of rentals) {
        const re = effOf(r, asOf);
        if (re.start >= re.end) continue;
        const hit = intervals.some((iv) => iv.start < iv.end && intersect(re.start, re.end, iv.start, iv.end));
        if (hit) mark(r.id, '保养区间变化且与该租用段相交');
      }
    }
    for (const c of changed.filter((x) => x.side === 'rental')) {
      mark(c.id, c.after ? '租用段新增/更正' : '租用段撤回');
    }
    for (const r of rentals) {
      if (!prevDetailMap.has(r.id)) mark(r.id, '上一版本无该租用段明细，补算');
    }
  }

  const detail = [];
  const carried = [];
  for (const rental of rentals) {
    if (!affected.has(rental.id) && prevDetailMap.has(rental.id)) {
      detail.push({ ...prevDetailMap.get(rental.id), untouched: true, rebuildReasons: [] });
      carried.push(rental.id);
      continue;
    }
    const computation = computeRentalDetail(rental, maintenance, asOf);
    computation.untouched = false;
    computation.rebuildReasons = reasons.get(rental.id) ?? ['首次加工'];
    detail.push(computation);
  }
  detail.sort((a, b) => a.rental.start - b.rental.start || a.rental.id.localeCompare(b.rental.id));

  const summary = summarize(equipmentId, version, asOf, rentals, maintenance, detail);
  return {
    equipmentId,
    version,
    inputSeq,
    asOf,
    generatedAt: nowIso(),
    summary,
    detail,
    rentals,
    maintenance,
    incremental: {
      affectedRentalIds: [...affected].filter((id) => rentals.some((r) => r.id === id)),
      reusedRentalIds: carried,
      reasons: Object.fromEntries(reasons),
      cutoffChanged,
      copiedFromVersion: prevResult?.version ?? null,
    },
  };
}

/** 读取某版本的完整结果（含原始记录），供导出/复制。 */
function loadVersionResults(db, version) {
  if (version === null) return new Map();
  const rows = db.prepare(`SELECT * FROM device_results WHERE version = ?`).all(version);
  return new Map(
    rows.map((row) => [
      row.equipment_id,
      {
        equipmentId: row.equipment_id,
        version: row.version,
        inputSeq: row.input_seq,
        asOf: row.as_of_ms,
        generatedAt: row.generated_at,
        summary: JSON.parse(row.summary_json),
        incremental: row.incremental_json ? JSON.parse(row.incremental_json) : null,
        ...JSON.parse(row.detail_json),
      },
    ]),
  );
}

/**
 * 发布一个批次（同一事务内）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{asOf:number, equipmentIds?:string[]|null,
 *          changed?:Array<{side:'rental'|'maintenance',id:string,equipmentId?:string,before?:object|null,after?:object|null}>|null,
 *          reason?:string}} options
 */
export function publish(db, { asOf, equipmentIds = null, changed = null, reason = 'records' }) {
  if (!Number.isFinite(asOf)) throw new RangeError('必须提供固定的截止时刻 asOf');
  const inputSeq = currentSeq(db);
  const prevVersion = latestVersion(db);
  const prevMeta = prevVersion === null ? null : db.prepare(`SELECT as_of_ms FROM result_versions WHERE version = ?`).get(prevVersion);
  const prevResults = loadVersionResults(db, prevVersion);
  // 截止时刻是加工口径的一部分：变化时开放段的截断位置会变，
  // 因此不能沿用上一版本的其他设备结果，必须整库重算，保证同一版本只有一套截止时刻。
  const cutoffChanged = !prevMeta || prevMeta.as_of_ms !== asOf;
  const requested = equipmentIds ?? listEquipment(db);
  const targets = cutoffChanged ? [...new Set([...listEquipment(db), ...requested])] : [...new Set(requested)];

  return tx(db, () => {
    const version = bumpPublishVersion(db);
    const genAt = nowIso();
    const computed = [];

    for (const equipmentId of targets) {
      const prevResult = prevResults.get(equipmentId) ?? null;
      const changedForDevice = changed
        ? changed.filter((c) => !c.equipmentId || c.equipmentId === equipmentId)
        : null;
      const result = computeDeviceResult(db, equipmentId, {
        asOf,
        version,
        inputSeq,
        changed: changedForDevice,
        prevResult,
      });
      writePublishedDevice(db, version, inputSeq, result);
      computed.push(result);
    }

    // 未受影响设备：把上一版本结果原样复制到新版本，保证版本 N 是完整视图。
    if (prevVersion !== null && !cutoffChanged) {
      const targetSet = new Set(targets);
      const others = [...prevResults.keys()].filter((id) => !targetSet.has(id));
      if (others.length) {
        const marks = others.map(() => '?').join(',');
        db.prepare(
          `INSERT INTO device_results(equipment_id, version, input_seq, as_of_ms, generated_at, summary_json, detail_json, incremental_json)
           SELECT equipment_id, ?, input_seq, as_of_ms, generated_at,
                  json_set(summary_json, '$.version', ?), detail_json, ?
           FROM device_results WHERE version = ? AND equipment_id IN (${marks})`,
        ).run(
          version,
          version,
          JSON.stringify({ reusedAll: true, copiedFromVersion: prevVersion }),
          prevVersion,
          ...others,
        );
        db.prepare(
          `INSERT INTO overlap_matches(equipment_id, version, as_of_ms, rental_id, maintenance_id, start_ms, end_ms, length_ms)
           SELECT equipment_id, ?, as_of_ms, rental_id, maintenance_id, start_ms, end_ms, length_ms
           FROM overlap_matches WHERE version = ? AND equipment_id IN (${marks})`,
        ).run(version, prevVersion, ...others);
        db.prepare(
          `INSERT INTO overlap_gaps(equipment_id, version, as_of_ms, rental_id, segment_no, start_ms, end_ms, length_ms)
           SELECT equipment_id, ?, as_of_ms, rental_id, segment_no, start_ms, end_ms, length_ms
           FROM overlap_gaps WHERE version = ? AND equipment_id IN (${marks})`,
        ).run(version, prevVersion, ...others);
      }
    }

    const allEquipment = db
      .prepare(`SELECT DISTINCT equipment_id FROM device_results WHERE version = ? ORDER BY equipment_id`)
      .all(version)
      .map((r) => r.equipment_id);
    writeVersionCatalog(db, version, inputSeq, asOf, genAt, allEquipment);
    return {
      version,
      inputSeq,
      asOf,
      generatedAt: genAt,
      equipmentIds: allEquipment,
      computed: computed.map((c) => ({
        equipmentId: c.equipmentId,
        summary: c.summary,
        incremental: c.incremental,
      })),
      reason,
    };
  });
}

/**
 * 生成一个“分析仓友好”的版本包：某版本下全部设备的明细与行级数据。
 * 同一版本内数据完整，可整体落仓。
 */
export function exportVersion(db, version) {
  const catalog = db.prepare(`SELECT * FROM result_versions WHERE version = ?`).get(version);
  const rows = db.prepare(`SELECT * FROM device_results WHERE version = ? ORDER BY equipment_id`).all(version);
  const matches = db
    .prepare(`SELECT * FROM overlap_matches WHERE version = ? ORDER BY equipment_id, rental_id, start_ms`)
    .all(version);
  const gaps = db
    .prepare(`SELECT * FROM overlap_gaps WHERE version = ? ORDER BY equipment_id, rental_id, segment_no`)
    .all(version);
  return {
    version,
    inputSeq: catalog?.input_seq ?? null,
    asOf: catalog?.as_of_ms ?? null,
    generatedAt: catalog?.generated_at ?? null,
    equipment: rows.map((r) => ({
      equipmentId: r.equipment_id,
      summary: JSON.parse(r.summary_json),
      detail: JSON.parse(r.detail_json),
    })),
    matches: matches.map((r) => ({
      equipmentId: r.equipment_id,
      rentalId: r.rental_id,
      maintenanceId: r.maintenance_id,
      start: r.start_ms,
      end: r.end_ms,
      lengthMs: r.length_ms,
      startText: displayOf(r.start_ms),
      endText: displayOf(r.end_ms),
      startIso: isoOf(r.start_ms),
      endIso: isoOf(r.end_ms),
    })),
    gaps: gaps.map((r) => ({
      equipmentId: r.equipment_id,
      rentalId: r.rental_id,
      segmentNo: r.segment_no,
      start: r.start_ms,
      end: r.end_ms,
      lengthMs: r.length_ms,
      startText: displayOf(r.start_ms),
      endText: displayOf(r.end_ms),
      startIso: isoOf(r.start_ms),
      endIso: isoOf(r.end_ms),
    })),
  };
}
