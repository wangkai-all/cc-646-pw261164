import { openDb } from '../server/store.js';
import { bumpInputSeq, tx, upsertRecord, deleteRecord } from '../server/store.js';
import { parseInstant } from '../server/engine.js';
import { publish } from '../server/jobs.js';

export const H = 3_600_000;
export const D = 24 * H;

export function at(text) {
  return parseInstant(text);
}

export function freshDb() {
  return openDb(':memory:');
}

/** 直接写入一条记录（自动分配 seq）。 */
export function put(db, side, { id, equipmentId = 'EQ-1', recordNo, start, end = null }) {
  const record = {
    id: id ?? `${side}-${recordNo}`,
    equipmentId,
    recordNo,
    start: typeof start === 'number' ? start : at(start),
    end: end === null || end === undefined ? null : typeof end === 'number' ? end : at(end),
  };
  let out;
  tx(db, () => {
    const seq = bumpInputSeq(db);
    out = upsertRecord(db, side, record, seq);
  });
  return out;
}

export function del(db, side, id) {
  let out;
  tx(db, () => {
    const seq = bumpInputSeq(db);
    out = deleteRecord(db, side, id, seq);
  });
  return out;
}

/** 按 fixtures 的步骤逐步执行并发布，返回逐步结果。 */
export function runScenario(db, scenario, applyOps) {
  const results = [];
  for (let i = 0; i < scenario.steps.length; i += 1) {
    const step = scenario.steps[i];
    const asOf = at(step.asOf ?? scenario.asOf);
    const changed = applyOps(db, scenario, step.ops ?? []);
    const published = publish(db, {
      asOf,
      equipmentIds: [scenario.equipmentId],
      changed: i === 0 ? null : changed,
      reason: `test:${scenario.key}#${i + 1}`,
    });
    results.push({ step: i + 1, version: published.version, asOf, computed: published.computed });
  }
  return results;
}
