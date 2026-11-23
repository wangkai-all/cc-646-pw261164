/**
 * 朴素区间扫描：不共享任何加工逻辑，用于核对 engine.js 的结果。
 *
 * 做法（刻意笨拙）：
 *  1. 以分钟为粒度，对每个租用段的有效区间逐分钟取样；
 *  2. 每分钟独立遍历全部保养段，判断是否被覆盖 —— 不排序、不合并、不剪枝；
 *  3. 相邻同状态的分钟合并成段，得到“覆盖段 / 空档段”；
 *  4. 配对重叠用双重循环逐对求交。
 *
 * 前提：样本中的所有端点都对齐到分钟（页面与测试都使用分钟精度），
 * 因此“分钟槽被覆盖”等价于点取样。
 */
import { MS_MINUTE } from './engine.js';

function eff(row, asOf, openField = 'openEnded') {
  if (row[openField] || row.end === null || row.end === undefined) {
    return { start: row.start, end: Math.max(row.start, asOf) };
  }
  return { start: row.start, end: Math.min(row.end, asOf) };
}

function overlaps(a, b) {
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

function segsFromMinutes(start, end, coveredFlags) {
  const segments = [];
  let runStart = null;
  for (let i = 0; i < coveredFlags.length; i += 1) {
    const t = start + i * MS_MINUTE;
    if (coveredFlags[i] && runStart === null) runStart = t;
    if (!coveredFlags[i] && runStart !== null) {
      segments.push({ start: runStart, end: t });
      runStart = null;
    }
  }
  if (runStart !== null) segments.push({ start: runStart, end });
  return segments;
}

/**
 * @param {{id:string,start:number,end:number|null,openEnded?:boolean}} rental
 * @param {Array<{id:string,start:number,end:number|null,openEnded?:boolean}>} maintenance
 * @param {number} asOf
 */
export function naiveRental(rental, maintenance, asOf) {
  const re = eff(rental, asOf);
  if (re.start % MS_MINUTE !== 0 || re.end % MS_MINUTE !== 0) {
    throw new Error('朴素扫描需要分钟对齐的端点');
  }
  const minutes = Math.max(0, Math.round((re.end - re.start) / MS_MINUTE));
  const coveredBy = [];
  const flags = new Array(minutes).fill(false);
  for (let i = 0; i < minutes; i += 1) {
    const t0 = re.start + i * MS_MINUTE;
    const t1 = t0 + MS_MINUTE;
    const hitIds = [];
    for (const m of maintenance) {
      const me = eff(m, asOf);
      if (me.start < me.end && Math.max(t0, me.start) < Math.min(t1, me.end)) hitIds.push(String(m.id));
    }
    if (hitIds.length) flags[i] = true;
    coveredBy.push(hitIds);
  }

  const coverage = [];
  const gaps = [];
  let runStart = null;
  let runIds = [];
  let runCovered = false;
  for (let i = 0; i <= minutes; i += 1) {
    const t = re.start + i * MS_MINUTE;
    const covered = i < minutes ? flags[i] : !runCovered;
    if (i === minutes) {
      if (runStart !== null) {
        const seg = { start: runStart, end: re.end };
        if (runCovered) coverage.push({ ...seg, maintenanceIds: [...new Set(runIds)] });
        else gaps.push(seg);
      }
      break;
    }
    if (runStart === null) {
      runStart = t;
      runCovered = covered;
      runIds = [...coveredBy[i]];
      continue;
    }
    if (covered !== runCovered) {
      const seg = { start: runStart, end: t };
      if (runCovered) coverage.push({ ...seg, maintenanceIds: [...new Set(runIds)] });
      else gaps.push(seg);
      runStart = t;
      runCovered = covered;
      runIds = [...coveredBy[i]];
      continue;
    }
    if (runCovered) {
      for (const id of coveredBy[i]) if (!runIds.includes(id)) runIds.push(id);
    }
  }

  const matches = [];
  for (const m of maintenance) {
    const me = eff(m, asOf);
    if (me.start >= me.end) continue;
    const s = Math.max(re.start, me.start);
    const e = Math.min(re.end, me.end);
    if (s < e) {
      matches.push({ maintenanceId: String(m.id), start: s, end: e, lengthMs: e - s });
    }
  }
  matches.sort((a, b) => a.start - b.start || a.end - b.end);

  // 分钟尺度的双重覆盖：命中 >= 2 条保养的分钟总数。
  let doubleMinutes = 0;
  for (const ids of coveredBy) if (ids.length >= 2) doubleMinutes += 1;

  return {
    rentalId: String(rental.id),
    coverage: coverage.map((c) => ({ ...c, lengthMs: c.end - c.start })),
    gaps: gaps.map((g) => ({ ...g, lengthMs: g.end - g.start })),
    matches,
    coverageLength: coverage.reduce((s, c) => s + (c.end - c.start), 0),
    gapLength: gaps.reduce((s, g) => s + (g.end - g.start), 0),
    matchLength: matches.reduce((s, m) => s + m.lengthMs, 0),
    doubleCoveredMs: doubleMinutes * MS_MINUTE,
  };
}

/** 对一组租用段做朴素扫描；返回 Map<rentalId, naive result>。 */
export function naiveDevice(rentals, maintenance, asOf) {
  const map = new Map();
  for (const r of rentals) map.set(String(r.id), naiveRental(r, maintenance, asOf));
  return map;
}

/**
 * 核对引擎结果与朴素扫描是否一致。
 * @returns {{ok:boolean, diffs:Array<object>}}
 */
export function compareWithNaive(engineResult, naive, rentalId) {
  const diffs = [];
  const near = (a, b) => a.start === b.start && a.end === b.end;
  const cmpSegs = (label, actual, expected) => {
    if (actual.length !== expected.length) {
      diffs.push({ rentalId, field: label, message: `段数不一致：引擎 ${actual.length}，朴素 ${expected.length}`, actual, expected });
      return;
    }
    for (let i = 0; i < actual.length; i += 1) {
      if (!near(actual[i], expected[i])) {
        diffs.push({
          rentalId,
          field: label,
          message: `第 ${i + 1} 段不一致`,
          actual: actual[i],
          expected: expected[i],
        });
      }
    }
  };
  cmpSegs('coverage', engineResult.coverage, naive.coverage);
  cmpSegs('gaps', engineResult.gaps, naive.gaps);
  if (engineResult.matches.length !== naive.matches.length) {
    diffs.push({
      rentalId,
      field: 'matches',
      message: `配对数不一致：引擎 ${engineResult.matches.length}，朴素 ${naive.matches.length}`,
    });
  } else {
    for (let i = 0; i < engineResult.matches.length; i += 1) {
      const a = engineResult.matches[i];
      const b = naive.matches[i];
      if (a.maintenanceId !== b.maintenanceId || !near(a, b)) {
        diffs.push({ rentalId, field: 'matches', message: `第 ${i + 1} 个配对不一致`, actual: a, expected: b });
      }
    }
  }
  if (engineResult.gapLength !== naive.gapLength) {
    diffs.push({ rentalId, field: 'gapLength', message: '空档总长不一致', actual: engineResult.gapLength, expected: naive.gapLength });
  }
  if (engineResult.unionLength !== naive.coverageLength) {
    diffs.push({ rentalId, field: 'unionLength', message: '覆盖总长不一致', actual: engineResult.unionLength, expected: naive.coverageLength });
  }
  if (engineResult.matchLength !== naive.matchLength) {
    diffs.push({ rentalId, field: 'matchLength', message: '配对总长不一致', actual: engineResult.matchLength, expected: naive.matchLength });
  }
  if (engineResult.doubleCoveredMs !== naive.doubleCoveredMs) {
    diffs.push({
      rentalId,
      field: 'doubleCoveredMs',
      message: '重复覆盖时长不一致',
      actual: engineResult.doubleCoveredMs,
      expected: naive.doubleCoveredMs,
    });
  }
  return { ok: diffs.length === 0, diffs };
}
