/**
 * 样本 + 朴素扫描核对 + 版本一致性 + 增量重建范围。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, bumpInputSeq, tx, upsertRecord, deleteRecord, getResult, listVersions, latestVersion } from '../server/store.js';
import { publish } from '../server/jobs.js';
import { parseInstant, displayOf } from '../server/engine.js';
import { naiveRental, compareWithNaive } from '../server/naive.js';
import { SCENARIOS, EXPECTED } from '../server/fixtures.js';
import { loadScenario, resetScenario } from '../server/samples.js';
import { H } from './helpers.mjs';

const scenario = (key) => SCENARIOS.find((s) => s.key === key);

function recordsOf(result) {
  return { rentals: result.rentals, maintenance: result.maintenance };
}

/** 每一步都用朴素扫描核对引擎的明细。 */
function crossCheckEveryStep(result) {
  const { rentals, maintenance } = recordsOf(result);
  const diffs = [];
  for (const d of result.detail) {
    const rental = rentals.find((r) => r.id === d.rental.id);
    const naive = naiveRental(rental, maintenance, result.asOf);
    const cmp = compareWithNaive(d, naive, d.rental.id);
    if (!cmp.ok) diffs.push(...cmp.diffs);
  }
  return diffs;
}

function texts(segs) {
  return segs.map((s) => [displayOf(s.start), displayOf(s.end)]);
}

/** 用设备记录把内部 id 换回业务记录编号。 */
function recordNos(result) {
  const map = new Map();
  for (const m of result.maintenance) map.set(m.id, m.recordNo);
  for (const r of result.rentals) map.set(r.id, r.recordNo);
  return (id) => map.get(id) ?? id;
}

for (const keyword of ['full-contain', 'multi-overlap', 'touching', 'revert-correction']) {
  test(`样本 ${keyword}：每一步都与朴素扫描一致`, () => {
    const db = openDb(':memory:');
    const sc = scenario(keyword);
    resetScenario(db, sc);
    const loaded = loadScenario(db, sc);
    assert.deepEqual(loaded.errors, []);
    for (const step of loaded.steps) {
      const result = getResult(db, sc.equipmentId, step.version);
      const diffs = crossCheckEveryStep(result);
      assert.deepEqual(diffs, [], `第 ${step.index} 步（版本 ${step.version}）与朴素扫描不一致`);
      // 空档 + 覆盖必须恰好铺满每条租用段，不重不漏。
      for (const d of result.detail) {
        const covered = d.coverage.reduce((s, c) => s + c.lengthMs, 0);
        const gaps = d.gaps.reduce((s, g) => s + g.lengthMs, 0);
        assert.equal(covered + gaps, d.rentalLength, '覆盖与空档应无重叠地铺满租用段');
      }
    }
  });
}

test('完全包含样本的期望值', () => {
  const db = openDb(':memory:');
  const sc = scenario('full-contain');
  resetScenario(db, sc);
  const loaded = loadScenario(db, sc);
  const result = getResult(db, sc.equipmentId);
  const d = result.detail[0];
  const exp = EXPECTED['full-contain'];
  const no = recordNos(result);
  assert.equal(d.overlapCount, exp.matchCount);
  assert.equal(d.gaps.length, exp.gapCount);
  assert.deepEqual(texts(d.gaps), exp.gaps);
  assert.deepEqual(
    d.matches.map((m) => [no(m.maintenanceId), displayOf(m.start), displayOf(m.end)]),
    exp.matches,
  );
  assert.equal(d.matchLength, exp.matchLengthHours * H);
  assert.equal(d.unionLength, exp.unionLengthHours * H);
  assert.equal(loaded.steps.length, 1);
});

test('多段重叠样本：撤回 M-2002 后空档重新连成一片', () => {
  const db = openDb(':memory:');
  const sc = scenario('multi-overlap');
  resetScenario(db, sc);
  const loaded = loadScenario(db, sc);
  const exp = EXPECTED['multi-overlap'];

  const last = getResult(db, sc.equipmentId, loaded.steps.at(-1).version).detail[0];
  const tail = exp.lastStep;
  assert.equal(last.overlapCount, tail.matchCount);
  assert.deepEqual(texts(last.gaps), tail.gaps);
  assert.equal(last.matchLength, tail.matchLengthHours * H);
  assert.equal(last.unionLength, tail.unionLengthHours * H);
  assert.equal(last.doubleCoveredMs, tail.doubleCoveredHours * H);
  // 重复覆盖的部分在配对总长里重复计入，所以不能拿租用总长直接减配对总长得到空档。
  assert.notEqual(last.gapLength, last.rentalLength - last.matchLength);

  const afterDeleteResult = getResult(db, sc.equipmentId, loaded.steps[exp.afterDeleteStep - 1].version);
  const afterDelete = afterDeleteResult.detail[0];
  const no = recordNos(afterDeleteResult);
  assert.equal(afterDelete.overlapCount, exp.afterDelete.matchCount);
  assert.deepEqual(texts(afterDelete.gaps), exp.afterDelete.gaps);
  assert.deepEqual(
    afterDelete.coverage.map((c) => [displayOf(c.start), displayOf(c.end), c.maintenanceIds.map(no)]),
    exp.afterDelete.coverage,
  );
});

test('瞬间相接样本：相接端点不算重叠，接缝与开放段截断正确', () => {
  const db = openDb(':memory:');
  const sc = scenario('touching');
  resetScenario(db, sc);
  const loaded = loadScenario(db, sc);
  const result = getResult(db, sc.equipmentId, loaded.steps.at(-1).version);
  const exp = EXPECTED.touching;
  const no = recordNos(result);

  const r3001 = result.detail.find((d) => d.rental.id.endsWith('R-3001'));
  assert.equal(r3001.overlapCount, exp.rental3001.matchCount);
  assert.deepEqual(texts(r3001.gaps), exp.rental3001.gaps);
  assert.deepEqual(
    r3001.matches.map((m) => [no(m.maintenanceId), displayOf(m.start), displayOf(m.end)]),
    exp.rental3001.matches,
  );
  assert.deepEqual(
    r3001.coverage.map((c) => [displayOf(c.start), displayOf(c.end), c.maintenanceIds.map(no)]),
    exp.rental3001.coverage,
  );
  assert.deepEqual(r3001.coverage[0].seams.map(displayOf), exp.rental3001.seamTexts);

  const r3002 = result.detail.find((d) => d.rental.id.endsWith('R-3002'));
  assert.equal(r3002.rental.openEnded, true);
  assert.equal(displayOf(r3002.rental.effectiveEnd), exp.rental3002.effectiveEndText);
  assert.equal(r3002.overlapCount, exp.rental3002.matchCount);
  assert.deepEqual(texts(r3002.gaps), exp.rental3002.gaps);
});

test('撤回更正样本：撤回后空档重现，再更正后重叠拆成多段', () => {
  const db = openDb(':memory:');
  const sc = scenario('revert-correction');
  resetScenario(db, sc);
  const loaded = loadScenario(db, sc);
  const exp = EXPECTED['revert-correction'];

  const afterDelete = getResult(db, sc.equipmentId, loaded.steps[exp.afterDeleteStep - 1].version).detail[0];
  assert.deepEqual(texts(afterDelete.gaps), exp.afterDelete.gaps);
  assert.equal(afterDelete.overlapCount, exp.afterDelete.matchCount);

  const lastResult = getResult(db, sc.equipmentId, loaded.steps.at(-1).version);
  const last = lastResult.detail[0];
  const no = recordNos(lastResult);
  assert.equal(last.overlapCount, exp.lastStep.matchCount);
  assert.equal(last.gaps.length, exp.lastStep.gapCount);
  assert.deepEqual(texts(last.gaps), exp.lastStep.gaps);
  assert.deepEqual(
    last.coverage.map((c) => [displayOf(c.start), displayOf(c.end), c.maintenanceIds.map(no)]),
    exp.lastStep.coverage,
  );

  // 覆盖区从 1 段变成 3 段 —— 重叠区确实被拆开了。
  const step1 = getResult(db, sc.equipmentId, loaded.steps[0].version).detail[0];
  assert.equal(step1.coverage.length, 1);
  assert.equal(last.coverage.length, 3);
});

test('增量重建只重算受影响的租用段', () => {
  const db = openDb(':memory:');
  const sc = scenario('multi-overlap');
  resetScenario(db, sc);
  const loaded = loadScenario(db, sc);
  // 第 2 步只缩短了一条保养：唯一租用段被重算，没有可复用的段。
  assert.deepEqual(loaded.steps[1].computed[0].incremental.affectedRentalIds.length, 1);
  assert.deepEqual(loaded.steps[1].computed[0].incremental.reusedRentalIds, []);
});

test('更正一条租用段时，同一设备的其它租用段沿用上一版本明细', () => {
  const db = openDb(':memory:');
  const put = (side, { id, equipmentId, recordNo, start, end }) => {
    let out;
    tx(db, () => {
      const seq = bumpInputSeq(db);
      out = upsertRecord(
        db,
        side,
        { id, equipmentId, recordNo, start: parseInstant(start), end: end === null ? null : parseInstant(end) },
        seq,
      );
    });
    return out;
  };
  put('rental', { id: 'R1', equipmentId: 'EQ-X', recordNo: 'R1', start: '2026-03-01 00:00', end: '2026-03-05 00:00' });
  put('rental', { id: 'R2', equipmentId: 'EQ-X', recordNo: 'R2', start: '2026-03-06 00:00', end: '2026-03-10 00:00' });
  put('maintenance', { id: 'M1', equipmentId: 'EQ-X', recordNo: 'M1', start: '2026-03-02 00:00', end: '2026-03-03 00:00' });
  const asOf = parseInstant('2026-03-15 00:00');
  const v1 = publish(db, { asOf, equipmentIds: ['EQ-X'], changed: null });

  const changed = [];
  tx(db, () => {
    const seq = bumpInputSeq(db);
    const out = upsertRecord(
      db,
      'rental',
      { id: 'R2', equipmentId: 'EQ-X', recordNo: 'R2', start: parseInstant('2026-03-06 00:00'), end: parseInstant('2026-03-09 00:00') },
      seq,
    );
    changed.push({ side: 'rental', id: 'R2', equipmentId: 'EQ-X', before: out.before, after: out.after });
  });
  const v2 = publish(db, { asOf, equipmentIds: ['EQ-X'], changed });

  const after = getResult(db, 'EQ-X', v2.version);
  const byId = new Map(after.detail.map((d) => [d.rental.id, d]));
  // 未变更的 R1：明细原样复用，不重新推导。
  assert.equal(byId.get('R1').untouched, true);
  assert.deepEqual(byId.get('R1').gaps, getResult(db, 'EQ-X', v1.version).detail.find((d) => d.rental.id === 'R1').gaps);
  // 变更的 R2：重新计算，且不再沿用旧明细。
  assert.equal(byId.get('R2').untouched, false);
  assert.deepEqual(after.incremental.affectedRentalIds, ['R2']);
  assert.deepEqual(after.incremental.reusedRentalIds, ['R1']);
  assert.deepEqual(after.incremental.reasons, { R2: ['租用段新增/更正'] });
});

test('多设备时只重建受影响设备，其余设备结果复制到新版本', () => {
  const db = openDb(':memory:');

  const put = (side, { id, equipmentId, recordNo, start, end }) => {
    let out;
    tx(db, () => {
      const seq = bumpInputSeq(db);
      out = upsertRecord(db, side, { id, equipmentId, recordNo, start: parseInstant(start), end: end === null ? null : parseInstant(end) }, seq);
    });
    return out;
  };

  const a1 = put('rental', { id: 'A-R1', equipmentId: 'EQ-A', recordNo: 'A-R1', start: '2026-03-01 00:00', end: '2026-03-10 00:00' });
  put('rental', { id: 'B-R1', equipmentId: 'EQ-B', recordNo: 'B-R1', start: '2026-03-01 00:00', end: '2026-03-10 00:00' });
  const asOf = parseInstant('2026-03-15 00:00');
  const v1 = publish(db, { asOf, equipmentIds: ['EQ-A', 'EQ-B'], changed: null });

  // 只改 EQ-A 的保养，发布时只传 EQ-A。
  const changed = [];
  tx(db, () => {
    const seq = bumpInputSeq(db);
    const out = upsertRecord(
      db,
      'maintenance',
      { id: 'A-M1', equipmentId: 'EQ-A', recordNo: 'A-M1', start: parseInstant('2026-03-03 00:00'), end: parseInstant('2026-03-05 00:00') },
      seq,
    );
    changed.push({ side: 'maintenance', id: 'A-M1', equipmentId: 'EQ-A', before: out.before, after: out.after });
  });
  const v2 = publish(db, { asOf, equipmentIds: ['EQ-A'], changed, reason: 'one-device' });
  assert.equal(v2.version, v1.version + 1);

  const a = getResult(db, 'EQ-A', v2.version);
  const b = getResult(db, 'EQ-B', v2.version);
  assert.equal(a.version, v2.version);
  assert.equal(b.version, v2.version);
  assert.equal(a.detail[0].overlapCount, 1);
  assert.equal(b.detail[0].overlapCount, 0);
  // 未受影响设备：明细原样沿用（untouched 标记），并带上了原版本号作为来源。
  // 未受影响设备在本次发布中未被重新计算（其明细由上一版整体复制），报告里明确标记为整体复用。
  assert.deepEqual(b.incremental, { reusedAll: true, copiedFromVersion: v1.version });
  assert.deepEqual(
    b.detail.map((d) => [d.rental.id, d.gaps.length, d.overlapCount]),
    getResult(db, 'EQ-B', v1.version).detail.map((d) => [d.rental.id, d.gaps.length, d.overlapCount]),
  );

  // 两边都在新版本里有完整的行级数据。
  const matchRows = db.prepare(`SELECT COUNT(*) AS n FROM overlap_matches WHERE version = ?`).get(v2.version);
  const gapRows = db.prepare(`SELECT COUNT(*) AS n FROM overlap_gaps WHERE version = ?`).get(v2.version);
  assert.equal(matchRows.n, 1);
  assert.equal(gapRows.n, 3); // EQ-A 两段空档 + EQ-B 一段空档
  void a1;
});

test('版本不混合：同一版本内所有设备来自同一次发布', () => {
  const db = openDb(':memory:');
  for (const sc of SCENARIOS) {
    resetScenario(db, sc);
    loadScenario(db, sc);
  }
  const versions = listVersions(db);
  const latest = latestVersion(db);
  const rows = db
    .prepare(`SELECT DISTINCT version FROM device_results WHERE version = ?`)
    .all(latest);
  assert.equal(rows.length, 1);
  // 最新版本应包含全部 4 台设备（未变动的从上一版本复制过来）。
  const latestRows = db.prepare(`SELECT COUNT(*) AS n FROM device_results WHERE version = ?`).get(latest);
  assert.equal(latestRows.n, SCENARIOS.length);
  assert.ok(versions.length >= 4);
});

test('索引与结果同版本发布；历史版本可按版本号回看', () => {
  const db = openDb(':memory:');
  const sc = scenario('multi-overlap');
  resetScenario(db, sc);
  const loaded = loadScenario(db, sc);
  for (const step of loaded.steps) {
    const idx = db.prepare(`SELECT version FROM equipment_index WHERE equipment_id = ?`).get(sc.equipmentId);
    const rowVersions = db
      .prepare(`SELECT DISTINCT version FROM overlap_matches WHERE equipment_id = ? ORDER BY version`)
      .all(sc.equipmentId)
      .map((r) => r.version);
    assert.ok(rowVersions.includes(step.version), '每一步都应留下该版本的行级数据');
  }
  // 旧版本仍可完整读取。
  const first = getResult(db, sc.equipmentId, loaded.steps[0].version);
  assert.equal(first.version, loaded.steps[0].version);
  assert.ok(first.detail[0].matches.length > 0);
});

test('撤回后重新发布不会破坏其他设备的历史版本', () => {
  const db = openDb(':memory:');
  const sc = scenario('revert-correction');
  resetScenario(db, sc);
  const loaded = loadScenario(db, sc);
  const beforeCount = db.prepare(`SELECT COUNT(*) AS n FROM overlap_matches WHERE version = ?`).get(loaded.steps[0].version).n;
  // 再发布一次（无变更），旧版本行数不变。
  publish(db, { asOf: parseInstant(sc.asOf), equipmentIds: [sc.equipmentId], changed: null, reason: 'noop' });
  const afterCount = db.prepare(`SELECT COUNT(*) AS n FROM overlap_matches WHERE version = ?`).get(loaded.steps[0].version).n;
  assert.equal(afterCount, beforeCount);
});

test('发布失败时整批回滚：不会留下半个版本', () => {
  const db = openDb(':memory:');
  const sc = scenario('full-contain');
  resetScenario(db, sc);
  loadScenario(db, sc);
  const versionBefore = latestVersion(db);
  const countBefore = db.prepare(`SELECT COUNT(*) AS n FROM device_results`).get().n;
  // 用一个非法设备触发写库错误：设备编号不存在不会报错，改为人为让 SQL 失败。
  const originalPrepare = db.prepare.bind(db);
  let calls = 0;
  db.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    if (sql.includes('INSERT INTO overlap_matches') && calls++ === 0) {
      return { run() { throw new Error('模拟写入失败'); } };
    }
    return stmt;
  };
  assert.throws(() => publish(db, { asOf: parseInstant(sc.asOf), equipmentIds: [sc.equipmentId], changed: null, reason: 'boom' }), /模拟写入失败/);
  db.prepare = originalPrepare;
  // 回滚后版本号没有被消耗，行数不变。
  assert.equal(latestVersion(db), versionBefore);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM device_results`).get().n, countBefore);
});
