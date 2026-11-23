/**
 * 样本场景载入：把 fixtures.js 的步骤真实地写进库并逐步发布，
 * 因此页面上的“版本历史 / 增量重建范围”与手工操作完全一致。
 */
import { bumpInputSeq, deleteRecord, tx, upsertRecord } from './store.js';
import { parseInstant } from './engine.js';
import { publish } from './jobs.js';

function recordId(side, equipmentId, recordNo) {
  return `${side}-${equipmentId}-${recordNo}`;
}

/** 应用单个步骤中的 ops。返回 changed 列表（供增量定位）与错误。 */
function applyOps(db, scenario, ops) {
  const changed = [];
  const errors = [];
  for (const op of ops) {
    const equipmentId = scenario.equipmentId;
    if (op.op === 'rental' || op.op === 'maintenance') {
      const side = op.op;
      const id = recordId(side, equipmentId, op.recordNo);
      const record = {
        id,
        equipmentId,
        recordNo: op.recordNo,
        start: parseInstant(op.start),
        end: parseInstant(op.end ?? null),
      };
      try {
        tx(db, () => {
          const seq = bumpInputSeq(db);
          const out = upsertRecord(db, side, record, seq);
          changed.push({ side, id, equipmentId, before: out.before, after: out.after });
        });
      } catch (err) {
        errors.push({ op, message: err.message });
      }
      continue;
    }
    if (op.op === 'maintenance-update' || op.op === 'rental-update') {
      const side = op.op.startsWith('maintenance') ? 'maintenance' : 'rental';
      const id = recordId(side, equipmentId, op.recordNo);
      const record = {
        id,
        equipmentId,
        recordNo: op.recordNo,
        start: parseInstant(op.start),
        end: parseInstant(op.end ?? null),
      };
      try {
        tx(db, () => {
          const seq = bumpInputSeq(db);
          const out = upsertRecord(db, side, record, seq);
          changed.push({ side, id, equipmentId, before: out.before, after: out.after });
        });
      } catch (err) {
        errors.push({ op, message: err.message });
      }
      continue;
    }
    if (op.op === 'maintenance-delete' || op.op === 'rental-delete') {
      const side = op.op.startsWith('maintenance') ? 'maintenance' : 'rental';
      const id = recordId(side, equipmentId, op.recordNo);
      try {
        tx(db, () => {
          const seq = bumpInputSeq(db);
          const removed = deleteRecord(db, side, id, seq);
          if (!removed) throw new Error(`记录不存在：${op.recordNo}`);
          changed.push({ side, id, equipmentId, before: removed.before, after: null });
        });
      } catch (err) {
        errors.push({ op, message: err.message });
      }
    }
  }
  return { changed, errors };
}

/**
 * 载入一个场景：按步骤发布版本，返回每一步的版本号与设备摘要。
 * @param {object} db
 * @param {object} scenario
 * @param {(label:string, index:number)=>string} [titleOf]
 */
export function loadScenario(db, scenario) {
  const steps = [];
  const errors = [];
  for (let i = 0; i < scenario.steps.length; i += 1) {
    const step = scenario.steps[i];
    const asOf = parseInstant(step.asOf ?? scenario.asOf);
    const { changed, errors: stepErrors } = applyOps(db, scenario, step.ops ?? []);
    errors.push(...stepErrors.map((e) => ({ step: i + 1, ...e })));
    const published = publish(db, {
      asOf,
      equipmentIds: [scenario.equipmentId],
      // 第一步之前场景数据被清空重灌，必须全量重算，不能沿用旧明细。
      changed: i === 0 ? null : changed,
      reason: `sample:${scenario.key}#${i + 1}`,
    });
    steps.push({
      index: i + 1,
      label: step.label,
      asOf,
      version: published.version,
      // 截止时刻变化时会整库重算，这里只报告本样本设备的增量。
      computed: published.computed
        .filter((c) => c.equipmentId === scenario.equipmentId)
        .map((c) => ({
          equipmentId: c.equipmentId,
          summary: c.summary,
          incremental: c.incremental,
        })),
    });
  }
  return {
    key: scenario.key,
    title: scenario.title,
    description: scenario.description,
    equipmentId: scenario.equipmentId,
    steps,
    errors,
  };
}

/** 清空全部样本设备（只删样本）。 */
export function resetScenario(db, scenario) {
  const ids = [scenario.equipmentId];
  const tables = ['rentals', 'maintenance'];
  tx(db, () => {
    for (const table of tables) {
      db.prepare(`DELETE FROM ${table} WHERE equipment_id = ?`).run(ids[0]);
    }
  });
  return true;
}
