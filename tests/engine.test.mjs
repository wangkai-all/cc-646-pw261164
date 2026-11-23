/**
 * 引擎单元测试：左闭右开、单对单交集、并集切段、开放段截断、切段依据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRentalDetail,
  intersect,
  mergeIntervals,
  parseInstant,
  displayOf,
  normalizeInterval,
} from '../server/engine.js';
import { H } from './helpers.mjs';

const t = (s) => parseInstant(s);
const T0 = '2026-03-01 00:00';

function rental(start, end) {
  return { id: 'R1', start: t(start), end: end === null ? null : t(end), openEnded: end === null };
}
function maint(id, start, end) {
  return { id, start: t(start), end: end === null ? null : t(end), openEnded: end === null };
}
const texts = (segs) => segs.map((s) => [displayOf(s.start), displayOf(s.end)]);

test('相接的两段不算重叠', () => {
  assert.equal(intersect(0, 10, 10, 20), null);
  assert.equal(intersect(10, 20, 0, 10), null);
  assert.deepEqual(intersect(0, 10, 5, 20), { start: 5, end: 10 });
});

test('完全包含：一条匹配、无空档', () => {
  const r = computeRentalDetail(rental('2026-03-01 00:00', '2026-03-10 00:00'), [maint('M1', '2026-02-25 00:00', '2026-03-20 00:00')], t('2026-03-15'));
  assert.equal(r.overlapCount, 1);
  assert.deepEqual(texts(r.gaps), []);
  assert.deepEqual(texts(r.coverage), [['2026-03-01 00:00', '2026-03-10 00:00']]);
  assert.equal(r.gapLength, 0);
  assert.equal(r.rentalLength, 9 * 24 * H);
  assert.ok(r.matches[0].reasons.some((x) => x.includes('保养段完全覆盖租用段')), r.matches[0].reasons.join('|'));
});

test('多段重叠：每对一个交集，覆盖按并集切段，空档由切段累加', () => {
  const r = computeRentalDetail(
    rental('2026-03-01 08:00', '2026-03-10 08:00'),
    [
      maint('M1', '2026-03-01 00:00', '2026-03-03 00:00'),
      maint('M2', '2026-03-02 12:00', '2026-03-05 12:00'),
      maint('M3', '2026-03-07 00:00', '2026-03-08 00:00'),
    ],
    t('2026-03-15'),
  );
  assert.equal(r.overlapCount, 3);
  assert.deepEqual(texts(r.matches.map((m) => ({ start: m.start, end: m.end }))), [
    ['2026-03-01 08:00', '2026-03-03 00:00'],
    ['2026-03-02 12:00', '2026-03-05 12:00'],
    ['2026-03-07 00:00', '2026-03-08 00:00'],
  ]);
  assert.deepEqual(texts(r.gaps), [
    ['2026-03-05 12:00', '2026-03-07 00:00'],
    ['2026-03-08 00:00', '2026-03-10 08:00'],
  ]);
  assert.deepEqual(r.coverage[0].maintenanceIds, ['M1', 'M2']);
  // M1 与 M2 重叠 12 小时：配对总长比并集覆盖长 12 小时。
  assert.equal(r.matchLength - r.unionLength, 12 * H);
  // 空档总长必须等于两段切出之和，而不是租用总长减去（可能重复计量的）配对总长。
  assert.equal(r.gapLength, (36 + 56) * H);
  assert.notEqual(r.gapLength, r.rentalLength - r.matchLength);
});

test('瞬间相接：保养段恰在租用端点结束/开始都不产生匹配', () => {
  const r = computeRentalDetail(rental('2026-03-01 08:00', '2026-03-05 08:00'), [
    maint('BEFORE', '2026-02-28 08:00', '2026-03-01 08:00'),
    maint('AFTER', '2026-03-05 08:00', '2026-03-06 08:00'),
  ], t('2026-03-10'));
  assert.equal(r.overlapCount, 0);
  assert.deepEqual(texts(r.gaps), [['2026-03-01 08:00', '2026-03-05 08:00']]);
  assert.equal(r.gapLength, r.rentalLength);
});

test('相接的两条保养合并为连续覆盖，接缝与成员保留', () => {
  const r = computeRentalDetail(rental('2026-03-01 00:00', '2026-03-06 00:00'), [
    maint('M1', '2026-03-02 00:00', '2026-03-03 00:00'),
    maint('M2', '2026-03-03 00:00', '2026-03-04 00:00'),
  ], t('2026-03-10'));
  assert.equal(r.coverage.length, 1);
  assert.deepEqual(r.coverage[0].maintenanceIds, ['M1', 'M2']);
  assert.deepEqual(r.coverage[0].seams, [t('2026-03-03 00:00')]);
  assert.deepEqual(texts(r.gaps), [
    ['2026-03-01 00:00', '2026-03-02 00:00'],
    ['2026-03-04 00:00', '2026-03-06 00:00'],
  ]);
});

test('撤回后空档重现：覆盖断开成两段，中间的空档回到结果里', () => {
  const all = [maint('M1', '2026-03-02 00:00', '2026-03-04 00:00'), maint('M2', '2026-03-04 00:00', '2026-03-08 00:00')];
  const before = computeRentalDetail(rental('2026-03-01 00:00', '2026-03-10 00:00'), all, t('2026-03-15'));
  assert.equal(before.coverage.length, 1);
  assert.deepEqual(texts(before.gaps), [['2026-03-01 00:00', '2026-03-02 00:00'], ['2026-03-08 00:00', '2026-03-10 00:00']]);
  const after = computeRentalDetail(rental('2026-03-01 00:00', '2026-03-10 00:00'), [all[0]], t('2026-03-15'));
  assert.deepEqual(texts(after.gaps), [['2026-03-01 00:00', '2026-03-02 00:00'], ['2026-03-04 00:00', '2026-03-10 00:00']]);
  assert.equal(after.gapLength, 1 * 24 * H + 6 * 24 * H);
});

test('更正后重叠拆成多段：一条保养被拆开，匹配数增加', () => {
  const before = computeRentalDetail(rental('2026-03-01 00:00', '2026-03-10 00:00'), [
    maint('M1', '2026-03-02 00:00', '2026-03-08 00:00'),
  ], t('2026-03-15'));
  assert.equal(before.overlapCount, 1);
  const after = computeRentalDetail(rental('2026-03-01 00:00', '2026-03-10 00:00'), [
    maint('M1', '2026-03-02 00:00', '2026-03-04 00:00'),
    maint('M2', '2026-03-06 00:00', '2026-03-08 00:00'),
  ], t('2026-03-15'));
  assert.equal(after.overlapCount, 2);
  assert.equal(after.coverage.length, 2);
  assert.deepEqual(texts(after.gaps), [
    ['2026-03-01 00:00', '2026-03-02 00:00'],
    ['2026-03-04 00:00', '2026-03-06 00:00'],
    ['2026-03-08 00:00', '2026-03-10 00:00'],
  ]);
});

test('未结束的租用段与保养段在截止时刻封闭', () => {
  const r = computeRentalDetail(rental('2026-03-01 00:00', null), [maint('M1', '2026-03-05 00:00', null)], t('2026-03-08 00:00'));
  assert.equal(r.rental.openEnded, true);
  assert.equal(r.rental.effectiveEnd, t('2026-03-08 00:00'));
  assert.deepEqual(texts(r.matches.map((m) => ({ start: m.start, end: m.end }))), [['2026-03-05 00:00', '2026-03-08 00:00']]);
  assert.ok(r.matches[0].reasons.some((x) => x.includes('保养段未结束')), r.matches[0].reasons.join('|'));
  assert.deepEqual(texts(r.gaps), [['2026-03-01 00:00', '2026-03-05 00:00']]);
});

test('截止时刻改变会改变开放段的截断位置', () => {
  const a = computeRentalDetail(rental('2026-03-01 00:00', null), [], t('2026-03-05'));
  const b = computeRentalDetail(rental('2026-03-01 00:00', null), [], t('2026-03-09'));
  assert.equal(a.rentalLength, 4 * 24 * H);
  assert.equal(b.rentalLength, 8 * 24 * H);
});

test('保养段超出截止时刻的部分不参与加工，并给出依据', () => {
  const r = computeRentalDetail(rental('2026-03-01 00:00', '2026-03-10 00:00'), [
    maint('M1', '2026-03-02 00:00', '2026-03-20 00:00'),
  ], t('2026-03-06'));
  assert.equal(r.matches[0].end, t('2026-03-06'));
  assert.ok(r.matches[0].reasons.some((x) => x.includes('保养段超出')), r.matches[0].reasons.join('|'));
  assert.equal(r.gapLength, 24 * H);
});

test('保养段完全落在截止时刻之后：不产生匹配', () => {
  const r = computeRentalDetail(rental('2026-03-01 00:00', '2026-03-10 00:00'), [
    maint('M1', '2026-03-20 00:00', '2026-03-22 00:00'),
  ], t('2026-03-15'));
  assert.equal(r.overlapCount, 0);
  assert.equal(r.gapLength, 9 * 24 * H);
});

test('零长度 / 逆序区间被 normalize 拒绝', () => {
  assert.throws(() => normalizeInterval({ id: 'X', start: T0, end: T0 }), /零长度/);
});

test('租用段完全在截止时刻之后：租用长度为零，不报错', () => {
  const r = computeRentalDetail(rental('2026-04-01 00:00', '2026-04-05 00:00'), [], t('2026-03-15'));
  assert.equal(r.rentalLength, 0);
  assert.equal(r.overlapCount, 0);
  assert.deepEqual(r.gaps, []);
});

test('mergeIntervals 不合并真正分离的段', () => {
  assert.deepEqual(
    mergeIntervals([
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 10, end: 20 },
      { id: 'c', start: 30, end: 40 },
    ]).map((m) => [m.start, m.end, m.memberIds]),
    [[0, 20, ['a', 'b']], [30, 40, ['c']]],
  );
});
