/**
 * 左闭右开区间 [start, end) 加工核心。
 * 纯函数、无 I/O：输入规范化（毫秒整数），输出可解释的匹配明细 / 空档 / 覆盖。
 *
 * 语义约定：
 *  - 相接但不相交的两段（A.end === B.start）不算重叠；
 *  - 每条租用×保养记录对最多产生一个交集（单个连续段）；
 *  - 空档 = 租用段 ÷ 覆盖它的有效保养段（含开放段被截止时刻截断）的并集；
 *  - 覆盖 / 空档可以切成多段，时长一律由切出的段累加，绝不用总时长相减。
 */

export const MS_MINUTE = 60_000;
export const MS_HOUR = 3_600_000;
export const MS_DAY = 86_400_000;

/**
 * 解析页面/接口传入的时刻。
 * 支持 ISO 8601（带或不带时区）与 "YYYY-MM-DD" / "YYYY-MM-DD HH:mm"。
 * 无时区后缀一律按 UTC 解释，避免部署服务器的本地时区让同一份数据算出不同结果。
 * @param {string|null|undefined} value
 * @returns {number|null} null 表示“未结束 / 留空”
 * @throws {RangeError} 无法解析时
 */
export function parseInstant(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  let text;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    text = `${raw}T00:00:00Z`;
  } else {
    text = raw.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) text += ':00Z';
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) text += 'Z';
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new RangeError(`无法解析时刻：${raw}（示例：2026-03-01 08:00）`);
  return ms;
}

/** 毫秒 -> ISO 字符串（UTC，去掉毫秒）。 */
export function isoOf(ms) {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 面向页面展示：UTC 的 YYYY-MM-DD HH:mm。 */
export function displayOf(ms) {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * 把一行原始记录规范化为内部区间。
 * @param {{id:string|number, start:string|number, end?:string|number|null}} row
 * @returns {{id:string, start:number, end:number|null, openEnded:boolean}}
 */
export function normalizeInterval(row, { allowOpen = true, label = '记录' } = {}) {
  const id = String(row.id ?? '');
  const start = typeof row.start === 'number' ? row.start : parseInstant(row.start);
  if (start === null) throw new RangeError(`${label} ${id} 缺少开始时刻`.trim());
  const rawEnd = row.end;
  const end = typeof rawEnd === 'number' ? rawEnd : parseInstant(rawEnd);
  if (end === null) {
    if (!allowOpen) throw new RangeError(`${label} ${id} 结束时刻为空；请先固定截止时刻`.trim());
    return { id, start, end: null, openEnded: true };
  }
  if (end <= start) {
    throw new RangeError(`${label} ${id} 的结束时刻必须晚于开始时刻（左闭右开，不允许零长度区间）`.trim());
  }
  return { id, start, end, openEnded: false };
}

/**
 * 截止时刻下的有效区间。开放段（end=null）在截止时刻截断为 [start, asOf)。
 * @returns {{start:number,end:number,zero:boolean,truncated:boolean}}
 */
export function effectiveInterval(interval, asOf) {
  const declaredEnd = interval.openEnded ? null : interval.end;
  if (declaredEnd === null || declaredEnd === undefined) {
    if (asOf <= interval.start) {
      return { start: interval.start, end: interval.start, zero: true, truncated: true };
    }
    return { start: interval.start, end: asOf, zero: false, truncated: true };
  }
  const end = Math.min(declaredEnd, asOf);
  const zero = end <= interval.start;
  return { start: interval.start, end: zero ? interval.start : end, zero, truncated: declaredEnd > asOf };
}

/**
 * 区间交集，左闭右开。相接不算重叠，故要求 start < end。
 * @returns {{start:number,end:number}|null}
 */
export function intersect(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return start < end ? { start, end } : null;
}

/**
 * 把一组区间按开始时刻排序并合并为不相交的并集。
 * 相接（前段 end === 后段 start）合并成一段连续覆盖，成员仍分别保留。
 * @param {Array<{id?:string,start:number,end:number}>} intervals
 * @returns {Array<{start:number,end:number,memberIds:string[],seams:number[]}>}
 */
export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((iv) => iv.start < iv.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.start === last.end) last.seams.push(iv.start);
      last.end = Math.max(last.end, iv.end);
      last.memberIds.push(String(iv.id));
    } else {
      merged.push({ start: iv.start, end: iv.end, memberIds: [String(iv.id)], seams: [] });
    }
  }
  return merged;
}

/**
 * 单个租用段与若干保养段的重叠加工。
 *
 *  - matches：每对（租用段 × 保养段）的单个交集，按开始时刻排序；彼此可以重叠，
 *    因为它们回答的是“这条保养覆盖了哪一段租用”；
 *  - coverage：租用段内被并集覆盖的切段；一个并集段内可能跨多条保养（memberIds > 1）；
 *  - gaps：租用段内没有被任何保养段覆盖的切段，可能多段；
 *  - 各长度均由切段累加。
 *
 * @param {{id:string,start:number,end:number|null,openEnded?:boolean}} rental
 * @param {Array<{id:string,start:number,end:number|null,openEnded?:boolean}>} maint
 * @param {number} asOf 截止时刻（毫秒）
 */
export function computeRentalDetail(rental, maint, asOf) {
  if (!Number.isFinite(asOf)) throw new RangeError('必须提供固定的截止时刻 asOf');
  const eff = effectiveInterval(rental, asOf);
  const start = eff.start;
  const end = eff.end;
  const asOfBeforeStart = rental.startedAfterAsOf ?? false; // 预留字段，默认 false
  const rentalTruncated = eff.truncated;

  const clipped = [];
  const matches = [];
  for (const m of maint) {
    const me = effectiveInterval(m, asOf);
    if (me.start >= me.end) continue; // 空段，或开放保养段在截止时刻前尚未开始
    const hit = intersect(start, end, me.start, me.end);
    if (!hit) continue;
    if (hit.end > asOf) hit.end = asOf; // 保养段超出截止时刻的部分不参与加工
    if (hit.start >= hit.end) continue;
    const reasons = [];
    if (hit.start === start && hit.start === me.start) reasons.push('起点一致：租用段与保养段同时开始');
    else if (hit.start === start) reasons.push('交集起点 = 租用段起点');
    else reasons.push('交集起点 = 保养段起点');
    if (hit.end === end && hit.end === me.end) reasons.push('终点一致：租用段与保养段同时结束');
    else if (hit.end === end) reasons.push('交集终点 = 租用段终点');
    else reasons.push('交集终点 = 保养段终点');
    if (me.start < start) reasons.push('保养段在租用段开始前已开始');
    if (me.end > end) reasons.push('保养段在租用段结束后仍持续');
    if (hit.end === asOf) {
      const sides = [];
      if (rental.openEnded) sides.push('租用段未结束');
      else if (rental.end > asOf) sides.push('租用段超出');
      if (m.openEnded) sides.push('保养段未结束');
      else if (m.end > asOf) sides.push('保养段超出');
      if (sides.length) reasons.push(`终点按截止时刻封闭（${sides.join('、')}）`);
    }
    if (hit.start === start && hit.end === end && me.start <= start && me.end >= end) reasons.push('保养段完全覆盖租用段');
    clipped.push({ id: m.id, start: hit.start, end: hit.end });
    matches.push({
      maintenanceId: String(m.id),
      maintenanceRecordNo: m.recordNo ?? null,
      start: hit.start,
      end: hit.end,
      lengthMs: hit.end - hit.start,
      maintenanceStart: me.start,
      maintenanceEnd: me.end,
      maintenanceOpenEnded: !!m.openEnded,
      maintenanceTruncated: me.truncated,
      reasons,
    });
  }
  matches.sort((a, b) => a.start - b.start || a.end - b.end);

  const unionParts = mergeIntervals(clipped);
  const coverage = [];
  const gaps = [];
  let cursor = start;
  for (const part of unionParts) {
    if (part.start > cursor) gaps.push({ start: cursor, end: part.start, lengthMs: part.start - cursor });
    coverage.push({
      start: part.start,
      end: part.end,
      lengthMs: part.end - part.start,
      maintenanceIds: part.memberIds,
      seams: part.seams,
    });
    cursor = part.end;
  }
  if (cursor < end) gaps.push({ start: cursor, end, lengthMs: end - cursor });

  const matchLength = matches.reduce((sum, m) => sum + m.lengthMs, 0);
  const coverageLength = coverage.reduce((sum, c) => sum + c.lengthMs, 0);
  const gapLength = gaps.reduce((sum, g) => sum + g.lengthMs, 0);
  const rentalLength = end - start;

  return {
    rental: {
      id: String(rental.id),
      recordNo: rental.recordNo ?? null,
      start: rental.start,
      end: rental.end,
      openEnded: !!rental.openEnded,
      effectiveEnd: end,
      truncated: rentalTruncated,
      asOfBeforeStart,
    },
    matches,
    coverage,
    gaps,
    rentalLength,
    unionLength: coverageLength,
    matchLength,
    gapLength,
    overlapCount: matches.length,
    // 同一租用段被多条保养同时覆盖造成的重复计量；unionLength 与 matchLength 的差即证据。
    doubleCoveredMs: matchLength - coverageLength,
    uncoveredRatio: rentalLength > 0 ? gapLength / rentalLength : 0,
  };
}

/**
 * 设备级加工：每条租用段独立与全部有效保养段配对。
 * 输入必须已规范化（毫秒）；空档只在单条租用段内部寻找，租用段之间的间隔不算空档。
 * @returns {Array<ReturnType<typeof computeRentalDetail>>}
 */
export function computeDevice({ rentals, maintenance, asOf }) {
  if (!Number.isFinite(asOf)) throw new RangeError('必须提供固定的截止时刻 asOf');
  return rentals.map((rental) => computeRentalDetail(rental, maintenance, asOf));
}

/**
 * 校验一组已规范化记录自身是否合法（端点缺失 / 零长度 / 逆序）。
 */
export function validateRecordSet({ rentals, maintenance }, asOf) {
  const errors = [];
  const check = (side, rows) => {
    for (const row of rows) {
      if (!Number.isFinite(row.start)) {
        errors.push({ side, id: row.id, message: '开始时刻为空或无法解析' });
      }
      if (row.end !== null && !Number.isFinite(row.end)) {
        errors.push({ side, id: row.id, message: '结束时刻无法解析' });
      }
      if (row.end !== null && Number.isFinite(row.start) && row.end <= row.start) {
        errors.push({ side, id: row.id, message: '结束时刻不晚于开始时刻（零长度或逆序）' });
      }
      if (Number.isFinite(asOf) && Number.isFinite(row.start) && row.start > asOf) {
        errors.push({ side, id: row.id, message: '开始时刻晚于截止时刻，在本次查询中不产生任何区间' });
      }
    }
  };
  check('rental', rentals);
  check('maintenance', maintenance);
  return errors;
}
