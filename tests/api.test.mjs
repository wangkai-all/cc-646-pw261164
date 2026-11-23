/**
 * HTTP 接口层测试：导入预检、截止时刻固定、版本发布、撤回后重建、时间解析边界。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NO_LISTEN = '1';
process.env.DB_PATH = ':memory:';

const { server } = await import('../server/index.js');
const { parseImportText } = await import('../server/index.js');

let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

test('未提供截止时刻时沿用固定值（不会每次取当前时钟）', async () => {
  const first = await call('GET', '/api/config');
  assert.equal(first.status, 200);
  const second = await call('GET', '/api/config');
  assert.equal(first.data.asOf, second.data.asOf);
});

test('导入预检报告逐行错误，不会写入任何数据', async () => {
  const bad = await call('POST', '/api/import', {
    text: [
      'equipment_id,record_no,start,end,kind',
      'EQ-X,I-1,2026-03-01 08:00,2026-03-05 08:00,rental',
      'EQ-X,I-2,2026-03-05 08:00,2026-03-05 08:00,maintenance',
      'EQ-X,I-3,,2026-03-05 08:00,maintenance',
    ].join('\n'),
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.data.errors.length, 2);
  const equip = await call('GET', '/api/equipment');
  assert.ok(!equip.data.equipment.some((e) => e.equipmentId === 'EQ-X'));

  const dry = await call('POST', '/api/import', {
    text: 'EQ-X,I-1,2026-03-01 08:00,2026-03-05 08:00,rental',
    dryRun: true,
  });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.dryRun, true);
  const equip2 = await call('GET', '/api/equipment');
  assert.ok(!equip2.data.equipment.some((e) => e.equipmentId === 'EQ-X'));
});

test('导入后查询：重叠明细、空档、截止时刻固定', async () => {
  const imported = await call('POST', '/api/import', {
    asOf: '2026-03-15 00:00',
    text: [
      '设备编号,记录编号,开始时刻,结束时刻,类型',
      'EQ-Y,R-1,2026-03-01 00:00,2026-03-10 00:00,租用',
      'EQ-Y,M-1,2026-03-03 00:00,2026-03-05 00:00,保养',
      'EQ-Y,M-2,2026-03-07 00:00,2026-03-08 00:00,保养',
    ].join('\n'),
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.equal(imported.data.imported, 3);

  const q = await call('POST', '/api/query', { asOf: '2026-03-15 00:00', equipmentId: 'EQ-Y' });
  assert.equal(q.status, 200);
  assert.equal(q.data.version, imported.data.version);
  assert.equal(q.data.asOfText, '2026-03-15 00:00');
  const row = q.data.rows[0];
  assert.equal(row.matches.length, 2);
  assert.deepEqual(
    row.gaps.map((g) => [g.startText, g.endText]),
    [
      ['2026-03-01 00:00', '2026-03-03 00:00'],
      ['2026-03-05 00:00', '2026-03-07 00:00'],
      ['2026-03-08 00:00', '2026-03-10 00:00'],
    ],
  );

  // 不带截止时刻时沿用最近发布的截止时刻，结果完全一致。
  const q2 = await call('POST', '/api/query', { equipmentId: 'EQ-Y' });
  assert.equal(q2.data.asOfText, '2026-03-15 00:00');
  assert.equal(q2.data.version, q.data.version);

  // 换一个截止时刻：发布新版本，两个版本互不混合。
  const q3 = await call('POST', '/api/query', { asOf: '2026-03-08 00:00', equipmentId: 'EQ-Y' });
  assert.equal(q3.status, 200);
  assert.notEqual(q3.data.version, q.data.version);
  const old = await call('POST', '/api/query', { version: q.data.version });
  assert.equal(old.data.version, q.data.version);
  assert.equal(old.data.asOfText, '2026-03-15 00:00');

  // 版本与截止时刻不一致时明确拒绝，而不是悄悄混用。
  const mismatch = await call('POST', '/api/query', { version: q.data.version, asOf: '2026-03-09 00:00' });
  assert.equal(mismatch.status, 409);
});

test('未结束的记录：必须按固定截止时刻封闭', async () => {
  await call('POST', '/api/import', {
    asOf: '2026-04-01 00:00',
    text: [
      'equipment_id,record_no,start,end,kind',
      'EQ-Z,R-9,2026-03-01 00:00,,rental',
      'EQ-Z,M-9,2026-03-02 00:00,,maintenance',
    ].join('\n'),
  });
  const q = await call('POST', '/api/query', { asOf: '2026-04-01 00:00', equipmentId: 'EQ-Z' });
  const row = q.data.rows[0];
  assert.equal(row.rentalView.declaredEndText, '未结束');
  assert.equal(row.rentalView.endText, '2026-04-01 00:00');
  assert.deepEqual(row.matches.map((m) => [m.startText, m.endText]), [['2026-03-02 00:00', '2026-04-01 00:00']]);
});

test('更正与撤回通过接口生效，并发布新版本', async () => {
  await call('POST', '/api/import', {
    asOf: '2026-03-15 00:00',
    text: [
      'equipment_id,record_no,start,end,kind',
      'EQ-W,R-1,2026-03-01 00:00,2026-03-10 00:00,rental',
      'EQ-W,M-1,2026-03-02 00:00,2026-03-04 00:00,maintenance',
    ].join('\n'),
  });
  const before = await call('POST', '/api/query', { asOf: '2026-03-15 00:00', equipmentId: 'EQ-W' });
  const deleted = await call('DELETE', '/api/maintenance/imp-maintenance-EQ-W-M-1');
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.notEqual(deleted.data.version, before.data.version);
  const after = await call('POST', '/api/query', { asOf: '2026-03-15 00:00', equipmentId: 'EQ-W' });
  assert.equal(after.data.rows[0].matches.length, 0);
  assert.equal(after.data.rows[0].gaps.length, 1);
  assert.deepEqual(
    [after.data.rows[0].gaps[0].startText, after.data.rows[0].gaps[0].endText],
    ['2026-03-01 00:00', '2026-03-10 00:00'],
  );

  // 恢复同一条记录（更正回原区间），重叠重新出现。
  const restored = await call('PUT', '/api/maintenance/imp-maintenance-EQ-W-M-1', {
    start: '2026-03-02 00:00',
    end: '2026-03-05 00:00',
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const again = await call('POST', '/api/query', { asOf: '2026-03-15 00:00', equipmentId: 'EQ-W' });
  assert.equal(again.data.rows[0].matches.length, 1);
});

test('版本导出包含该版本的行级数据，历史版本可回看', async () => {
  const q = await call('POST', '/api/query', { asOf: '2026-03-15 00:00' });
  const version = q.data.version;
  const pack = await call('GET', `/api/versions/${version}/export`);
  assert.equal(pack.status, 200);
  assert.equal(pack.data.version, version);
  assert.ok(pack.data.matches.length >= 1);
  assert.ok(pack.data.gaps.length >= 1);
  assert.ok(pack.data.equipment.length >= 1);
  // 行级数据里的时刻与明细一致。
  for (const m of pack.data.matches) {
    assert.equal(typeof m.startIso, 'string');
    const detailMatch = pack.data.equipment
      .flatMap((e) => e.detail.detail)
      .flatMap((d) => d.matches)
      .find((x) => x.maintenanceId === m.maintenanceId && x.start === m.start);
    assert.ok(detailMatch, '导出的行级数据必须能在明细中找到');
  }

  const csv = await fetch(`${base}/api/versions/${version}/export?format=csv`).then((r) => r.text());
  assert.match(csv, /equipment_id,rental_id,maintenance_id,start,end,length_ms/);
});

test('样本接口：载入四种样本并返回逐步版本', async () => {
  const list = await call('GET', '/api/samples');
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.data.scenarios.map((s) => s.key).sort(),
    ['full-contain', 'multi-overlap', 'revert-correction', 'touching'],
  );
  for (const s of list.data.scenarios) {
    const loaded = await call('POST', `/api/samples/${s.key}`, { reset: true });
    assert.equal(loaded.status, 200, JSON.stringify(loaded.data));
    assert.equal(loaded.data.steps.length, s.stepCount);
    assert.ok(loaded.data.result.detail.length >= 1);
  }
  const after = await call('GET', '/api/samples');
  assert.ok(after.data.scenarios.every((s) => s.loaded));

  // 单独撤回一个样本：输入记录被清空，“已载入”标记应立即消失。
  const reset = await call('POST', '/api/samples/reset', { keys: ['touching'] });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.data.reset, ['touching']);
  const resetList = await call('GET', '/api/samples');
  assert.equal(resetList.data.scenarios.find((s) => s.key === 'touching').loaded, false);
  assert.ok(resetList.data.scenarios.filter((s) => s.key !== 'touching').every((s) => s.loaded));
});

test('非法输入被拒绝', async () => {
  const empty = await call('POST', '/api/rentals', { equipmentId: 'EQ-V', recordNo: '', start: '2026-03-01 00:00' });
  assert.equal(empty.status, 400);
  const inverted = await call('POST', '/api/rentals', {
    equipmentId: 'EQ-V',
    recordNo: 'R-1',
    start: '2026-03-05 00:00',
    end: '2026-03-01 00:00',
  });
  assert.equal(inverted.status, 400);
  const zero = await call('POST', '/api/rentals', {
    equipmentId: 'EQ-V',
    recordNo: 'R-1',
    start: '2026-03-05 00:00',
    end: '2026-03-05 00:00',
  });
  assert.equal(zero.status, 400);
  const missing = await call('DELETE', '/api/rentals/does-not-exist');
  assert.equal(missing.status, 404);
});

test('导入解析：带表头 / 不带表头 / 缺类型默认租用', () => {
  const withHeader = parseImportText('equipment_id,record_no,start,end,kind\nEQ-A,R1,2026-03-01 00:00,2026-03-02 00:00,rental');
  assert.equal(withHeader.errors.length, 0);
  assert.equal(withHeader.records[0].side, 'rental');
  const noHeader = parseImportText('EQ-A,R1,2026-03-01 00:00,2026-03-02 00:00,maintenance');
  assert.equal(noHeader.errors.length, 0);
  assert.equal(noHeader.records[0].side, 'maintenance');
  const defaulted = parseImportText('EQ-A,R1,2026-03-01 00:00,2026-03-02 00:00', { defaultKind: 'maintenance' });
  assert.equal(defaulted.records[0].side, 'maintenance');
  const open = parseImportText('EQ-A,R1,2026-03-01 00:00,,rental');
  assert.equal(open.records[0].end, null);
});
