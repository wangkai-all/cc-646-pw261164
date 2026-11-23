/**
 * 零依赖 HTTP 服务：REST API + 静态页面 + 分析仓友好的版本导出。
 *
 * 设计要点：
 *  - 查询 / 变更都必须带截止时刻（asOf）；缺省沿用最近一次发布使用的截止时刻；
 *  - 输入变更后只重算受影响设备并发布新版本（索引与结果同事务）；
 *  - 查询固定在一个版本上：若请求的 asOf 与已发布版本不同，先按该截止时刻发布新版本，
 *    再读该版本，绝不混用两套数据；
 *  - version 参数可回看历史版本（结果行与输入快照一起保存）。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  bumpInputSeq,
  deleteRecord,
  getAudit,
  getEquipmentIndex,
  getMaintenance,
  getRental,
  getResult,
  getVersion,
  latestVersion,
  listEquipment,
  listEquipmentIndex,
  listRecords,
  listResults,
  listVersions,
  openDb,
  tx,
  upsertRecord,
} from './store.js';
import { displayOf, isoOf, parseInstant, validateRecordSet } from './engine.js';
import { exportVersion, publish } from './jobs.js';
import { SCENARIOS } from './fixtures.js';
import { compareWithNaive, naiveRental } from './naive.js';
import { loadScenario, resetScenario } from './samples.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const STATIC_DIR = join(ROOT, 'server', 'static');

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? join(ROOT, 'data', 'app.db');

if (DB_PATH !== ':memory:') mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = openDb(DB_PATH);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

/**
 * 解析请求中的截止时刻。合法则返回毫秒，否则抛 400。
 * 缺省（undefined / null / 空串）返回 null，由调用方补默认值。
 */
function readAsOf(value, field = 'asOf') {
  try {
    return value === undefined || value === null || value === '' ? null : parseInstant(value);
  } catch (err) {
    throw new HttpError(400, `${field}：${err.message}`);
  }
}

/** 默认截止时刻：最近一次发布用的值；没有发布过则取当前整分钟。 */
function defaultAsOf() {
  const v = getVersion(db, latestVersion(db));
  if (v) return v.as_of_ms;
  return Math.floor(Date.now() / 60_000) * 60_000;
}

function resolveAsOf(value) {
  const explicit = readAsOf(value);
  return explicit === null ? defaultAsOf() : explicit;
}

/** 为结果文档补上展示文本，前端不做时区推断。 */
function decorateDetail(result) {
  if (!result) return null;
  return {
    ...result,
    asOfText: displayOf(result.asOf),
    asOfIso: isoOf(result.asOf),
    generatedAtText: displayOf(Date.parse(result.generatedAt)),
    detail: result.detail.map((rd) => ({
      ...rd,
      rentalView: {
        ...rd.rental,
        startText: displayOf(rd.rental.start),
        endText: displayOf(rd.rental.effectiveEnd),
        declaredEndText: rd.rental.openEnded ? '未结束' : displayOf(rd.rental.end),
      },
      matches: rd.matches.map((m) => ({
        ...m,
        startText: displayOf(m.start),
        endText: displayOf(m.end),
        maintenanceStartText: displayOf(m.maintenanceStart),
        maintenanceEndText: m.maintenanceOpenEnded ? '未结束' : displayOf(m.maintenanceEnd),
      })),
      coverage: rd.coverage.map((c) => ({ ...c, startText: displayOf(c.start), endText: displayOf(c.end) })),
      gaps: rd.gaps.map((g) => ({ ...g, startText: displayOf(g.start), endText: displayOf(g.end) })),
    })),
    rentalsView: result.rentals.map((r) => ({
      ...r,
      startText: displayOf(r.start),
      endText: r.end === null ? '未结束' : displayOf(r.end),
    })),
    maintenanceView: result.maintenance.map((m) => ({
      ...m,
      startText: displayOf(m.start),
      endText: m.end === null ? '未结束' : displayOf(m.end),
    })),
  };
}

function decorateSummary(result) {
  return {
    ...result,
    asOfText: displayOf(result.asOf),
    generatedAtText: displayOf(Date.parse(result.generatedAt)),
  };
}

function parseRecordInput(body, { equipmentId, id } = {}) {
  const recordId = String(body.id ?? id ?? `rec-${randomUUID()}`);
  if (recordId.length > 120) throw new HttpError(400, '内部记录 ID 过长');
  const recordNo = String(body.recordNo ?? '').trim();
  if (!recordNo) throw new HttpError(400, '记录编号不能为空');
  if (recordNo.length > 120) throw new HttpError(400, '记录编号过长');
  const eq = String(body.equipmentId ?? equipmentId ?? '').trim();
  if (!eq) throw new HttpError(400, '设备编号不能为空');
  if (eq.length > 120) throw new HttpError(400, '设备编号过长');
  let start;
  let end;
  try {
    start = typeof body.start === 'number' ? body.start : parseInstant(body.start);
    end = typeof body.end === 'number' ? body.end : parseInstant(body.end);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  if (start === null) throw new HttpError(400, '开始时刻不能为空');
  if (end !== null) {
    if (end <= start) throw new HttpError(400, '结束时刻必须晚于开始时刻（左闭右开）');
    if (end - start > 100 * 365 * 86_400_000) throw new HttpError(400, '区间跨度过大（超过 100 年）');
  }
  return { id: recordId, equipmentId: eq, recordNo, start, end };
}

/**
 * 写一条记录并发布受影响设备。
 * asOf 固定后发布，页面随后按同一截止时刻查询。
 */
function mutate(side, record, asOf) {
  const changed = [];
  tx(db, () => {
    const seq = bumpInputSeq(db);
    const out = upsertRecord(db, side, record, seq);
    changed.push({ side, id: record.id, equipmentId: record.equipmentId, before: out.before, after: out.after });
  });
  const published = publish(db, {
    asOf,
    equipmentIds: [record.equipmentId],
    changed,
    reason: `${side}.upsert`,
  });
  return published;
}

function mutateDelete(side, id, asOf) {
  let removed = null;
  tx(db, () => {
    const seq = bumpInputSeq(db);
    removed = deleteRecord(db, side, id, seq);
    if (!removed) throw new HttpError(404, side === 'rental' ? '租用记录不存在' : '保养记录不存在');
  });
  const published = publish(db, {
    asOf,
    equipmentIds: [removed.equipmentId],
    changed: [{ side, id, equipmentId: removed.equipmentId, before: removed.before, after: null }],
    reason: `${side}.delete`,
  });
  return { published, removed };
}

function durationText(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const hours = ms / 3_600_000;
  if (Math.abs(hours) >= 48) return `${(hours / 24).toFixed(1)} 天`;
  return `${hours.toFixed(1)} 小时`;
}

/** 版本增量的一句话说明，供版本列表直接展示。 */
function describeIncremental(byEquipment) {
  const parts = [];
  for (const [equipmentId, inc] of Object.entries(byEquipment ?? {})) {
    if (!inc) continue;
    if (inc.reusedAll) {
      continue;
    }
    if (inc.cutoffChanged) {
      parts.push(`${equipmentId}：截止时刻变化，全量重算`);
      continue;
    }
    const affected = inc.affectedRentalIds?.length ?? 0;
    const reused = inc.reusedRentalIds?.length ?? 0;
    const why = [...new Set(Object.values(inc.reasons ?? {}).flat())].slice(0, 2).join('、');
    if (affected || reused) {
      parts.push(`${equipmentId}：重算 ${affected} 段 / 复用 ${reused} 段${why ? `（${why}）` : ''}`);
    }
  }
  return parts.join('；');
}

function summaryWithText(summary) {
  return {
    ...summary,
    rentalLengthText: durationText(summary.rentalLength),
    matchLengthText: durationText(summary.matchLength),
    unionLengthText: durationText(summary.unionLength),
    gapLengthText: durationText(summary.gapLength),
    doubleCoveredText: durationText(summary.doubleCoveredMs),
  };
}

/** 读取某个版本下某设备的结果；version=null 表示最新。 */
function readPublished(equipmentId, version = null) {
  if (version !== null) {
    return getResult(db, equipmentId, version);
  }
  const idx = getEquipmentIndex(db, equipmentId);
  return idx ? getResult(db, equipmentId, idx.version) : null;
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, now: isoOf(Date.now()), db: DB_PATH });
  }

  if (method === 'GET' && pathname === '/api/config') {
    const asOf = defaultAsOf();
    return json(res, 200, {
      asOf,
      asOfText: displayOf(asOf),
      latestVersion: latestVersion(db),
      timezone: 'UTC',
      note: '所有时刻按 UTC 解释与展示；带时区的输入会被换算。',
    });
  }

  if (method === 'GET' && pathname === '/api/equipment') {
    const idx = new Map(listEquipmentIndex(db).map((e) => [e.equipmentId, e]));
    return json(res, 200, {
      equipment: listEquipment(db).map((id) => {
        const { rentals, maintenance } = listRecords(db, id);
        return {
          equipmentId: id,
          rentalCount: rentals.length,
          maintenanceCount: maintenance.length,
          version: idx.get(id)?.version ?? null,
          asOf: idx.get(id)?.asOf ?? null,
          asOfText: displayOf(idx.get(id)?.asOf ?? null),
        };
      }),
    });
  }

  if (method === 'GET' && pathname === '/api/results') {
    const rows = listResults(db).map((r) => {
      const full = getResult(db, r.equipmentId, r.version);
      return { ...decorateDetail(full), summary: summaryWithText(r.summary) };
    });
    return json(res, 200, {
      latestVersion: latestVersion(db),
      results: rows,
    });
  }

  if (method === 'GET' && pathname === '/api/versions') {
    return json(res, 200, {
      versions: listVersions(db).map((v) => ({
        ...v,
        asOfText: displayOf(v.asOf),
        generatedAtText: displayOf(Date.parse(v.generatedAt)),
        incrementalText: describeIncremental(v.incremental),
      })),
    });
  }

  const versionMatch = pathname.match(/^\/api\/versions\/(\d+)$/);
  if (method === 'GET' && versionMatch) {
    const version = Number(versionMatch[1]);
    const meta = getVersion(db, version);
    if (!meta) throw new HttpError(404, '版本不存在');
    return json(res, 200, {
      version: meta.version,
      inputSeq: meta.input_seq,
      asOf: meta.as_of_ms,
      asOfText: displayOf(meta.as_of_ms),
      generatedAt: meta.generated_at,
      equipmentIds: JSON.parse(meta.equipment_ids),
    });
  }

  const versionExportMatch = pathname.match(/^\/api\/versions\/(\d+)\/export$/);
  if (method === 'GET' && versionExportMatch) {
    const version = Number(versionExportMatch[1]);
    const meta = getVersion(db, version);
    if (!meta) throw new HttpError(404, '版本不存在');
    const format = url.searchParams.get('format') ?? 'json';
    const pack = exportVersion(db, version);
    if (format === 'csv') {
      const lines = ['equipment_id,rental_id,maintenance_id,start,end,length_ms'];
      for (const m of pack.matches) {
        lines.push([m.equipmentId, m.rentalId, m.maintenanceId, m.startIso, m.endIso, m.lengthMs].join(','));
      }
      lines.push('');
      lines.push('equipment_id,rental_id,segment_no,start,end,length_ms');
      for (const g of pack.gaps) {
        lines.push([g.equipmentId, g.rentalId, g.segmentNo, g.startIso, g.endIso, g.lengthMs].join(','));
      }
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="overlap-v${version}.csv"`,
        'cache-control': 'no-store',
      });
      return res.end(`﻿${lines.join('\n')}\n`);
    }
    return json(res, 200, pack);
  }

  if (method === 'GET' && pathname === '/api/audit') {
    return json(res, 200, { entries: getAudit(db) });
  }

  /**
   * 朴素扫描核对：用逐分钟扫描重算某版本的明细，与引擎结果逐段比对。
   * 刻意不共享引擎的排序 / 合并逻辑，用于发现“聪明”实现才会犯的错。
   */
  if (method === 'GET' && pathname === '/api/verify') {
    const versionParam = url.searchParams.get('version');
    const version = versionParam ? Number(versionParam) : latestVersion(db);
    if (!Number.isInteger(version)) throw new HttpError(400, 'version 必须是非负整数');
    const meta = getVersion(db, version);
    if (!meta) throw new HttpError(404, '版本不存在');
    const equipmentIds = url.searchParams.get('equipmentId')
      ? [url.searchParams.get('equipmentId')]
      : JSON.parse(meta.equipment_ids);
    const diffs = [];
    let checkedRentals = 0;
    let skipped = [];
    for (const equipmentId of equipmentIds) {
      const result = getResult(db, equipmentId, version);
      if (!result) continue;
      for (const d of result.detail) {
        const rental = result.rentals.find((r) => r.id === d.rental.id);
        if (!rental) continue;
        try {
          const naive = naiveRental(rental, result.maintenance, result.asOf);
          checkedRentals += 1;
          const cmp = compareWithNaive(d, naive, d.rental.id);
          if (!cmp.ok) diffs.push(...cmp.diffs.map((x) => ({ equipmentId, ...x })));
        } catch (err) {
          skipped.push({ equipmentId, rentalId: rental.id, reason: err.message });
        }
      }
    }
    return json(res, 200, {
      ok: diffs.length === 0,
      version,
      asOf: meta.as_of_ms,
      asOfText: displayOf(meta.as_of_ms),
      checkedRentals,
      diffCount: diffs.length,
      diffs,
      skipped,
      method: '逐分钟扫描：每分钟独立判断是否被任一条保养覆盖，再合并相邻同状态分钟；不排序、不合并、不剪枝。',
    });
  }

  const equipmentRecords = pathname.match(/^\/api\/equipment\/([^/]+)\/records$/);
  if (method === 'GET' && equipmentRecords) {
    const equipmentId = decodeURIComponent(equipmentRecords[1]);
    const records = listRecords(db, equipmentId);
    const wrap = (r) => ({
      ...r,
      startText: displayOf(r.start),
      endText: r.end === null ? '未结束' : displayOf(r.end),
      startIso: isoOf(r.start),
      endIso: isoOf(r.end),
    });
    return json(res, 200, {
      equipmentId,
      version: getEquipmentIndex(db, equipmentId)?.version ?? null,
      rentals: records.rentals.map(wrap),
      maintenance: records.maintenance.map(wrap),
    });
  }

  const equipmentResult = pathname.match(/^\/api\/equipment\/([^/]+)\/result$/);
  if (method === 'GET' && equipmentResult) {
    const equipmentId = decodeURIComponent(equipmentResult[1]);
    const rawVersion = url.searchParams.get('version');
    const version = rawVersion ? Number(rawVersion) : null;
    if (version !== null && (!Number.isInteger(version) || version < 0)) {
      throw new HttpError(400, 'version 必须是非负整数');
    }
    const result = version === null ? readPublished(equipmentId) : getResult(db, equipmentId, version);
    return json(res, 200, {
      equipmentId,
      requestedVersion: version,
      latestVersion: latestVersion(db),
      result: result ? decorateDetail(result) : null,
    });
  }

  // 输入变更 ---------------------------------------------------------------

  if (method === 'POST' && pathname === '/api/rentals') {
    const body = await readJson(req);
    const record = parseRecordInput(body);
    const asOf = resolveAsOf(body.asOf);
    const published = mutate('rental', record, asOf);
    return json(res, 201, {
      id: record.id,
      version: published.version,
      asOf,
      asOfText: displayOf(asOf),
      result: decorateDetail(readPublished(record.equipmentId)),
    });
  }

  if (method === 'POST' && pathname === '/api/maintenance') {
    const body = await readJson(req);
    const record = parseRecordInput(body);
    const asOf = resolveAsOf(body.asOf);
    const published = mutate('maintenance', record, asOf);
    return json(res, 201, {
      id: record.id,
      version: published.version,
      asOf,
      asOfText: displayOf(asOf),
      result: decorateDetail(readPublished(record.equipmentId)),
    });
  }

  const recordMatch = pathname.match(/^\/api\/(rentals|maintenance)\/([^/]+)$/);
  if (recordMatch) {
    const side = recordMatch[1] === 'rentals' ? 'rental' : 'maintenance';
    const table = recordMatch[1];
    const id = decodeURIComponent(recordMatch[2]);
    if (method === 'GET') {
      const row = side === 'rental' ? getRental(db, id) : getMaintenance(db, id);
      if (!row) throw new HttpError(404, '记录不存在');
      return json(res, 200, {
        ...row,
        startText: displayOf(row.start_ms),
        endText: row.end_ms === null ? '未结束' : displayOf(row.end_ms),
        startIso: isoOf(row.start_ms),
        endIso: isoOf(row.end_ms),
      });
    }
    if (method === 'PUT' || method === 'PATCH') {
      // 撤回后的记录仍允许以同一 id 更正“恢复”，因此这里直接查物理行。
      const existing = db
        .prepare(`SELECT * FROM ${side === 'rental' ? 'rentals' : 'maintenance'} WHERE id = ?`)
        .get(id);
      if (!existing) throw new HttpError(404, '记录不存在');
      const body = await readJson(req);
      const record = parseRecordInput(
        {
          ...body,
          id,
          equipmentId: existing.equipment_id,
          recordNo: body.recordNo ?? existing.record_no,
          start: body.start ?? existing.start_ms,
          end: body.end !== undefined ? body.end : existing.end_ms,
        },
        { equipmentId: existing.equipment_id, id },
      );
      const asOf = resolveAsOf(body.asOf);
      const published = mutate(side, record, asOf);
      return json(res, 200, {
        id,
        version: published.version,
        asOf,
        asOfText: displayOf(asOf),
        result: decorateDetail(readPublished(existing.equipment_id)),
      });
    }
    if (method === 'DELETE') {
      const body = await readJson(req).catch(() => ({}));
      const asOf = resolveAsOf(body.asOf);
      const { published, removed } = mutateDelete(side, id, asOf);
      return json(res, 200, {
        deleted: true,
        id,
        side: table,
        version: published.version,
        asOf,
        asOfText: displayOf(asOf),
        result: decorateDetail(readPublished(removed.equipmentId)),
      });
    }
    throw new HttpError(405, '不支持的方法');
  }

  // 样本 -------------------------------------------------------------------

  if (method === 'GET' && pathname === '/api/samples') {
    // “已载入”按当前输入记录判断：撤回样本数据后应立刻消失，
    // 而不是看历史版本里是否还留着当时的加工结果。
    const loaded = new Set(
      db
        .prepare(
          `SELECT DISTINCT equipment_id FROM (
             SELECT equipment_id FROM rentals WHERE deleted = 0
             UNION ALL
             SELECT equipment_id FROM maintenance WHERE deleted = 0
           )`,
        )
        .all()
        .map((row) => row.equipment_id),
    );
    return json(res, 200, {
      scenarios: SCENARIOS.map((s) => ({
        key: s.key,
        title: s.title,
        description: s.description,
        equipmentId: s.equipmentId,
        asOf: parseInstant(s.asOf),
        asOfText: s.asOf,
        stepCount: s.steps.length,
        steps: s.steps.map((st, i) => ({ index: i + 1, label: st.label, asOf: st.asOf ?? s.asOf })),
        loaded: loaded.has(s.equipmentId),
      })),
    });
  }

  if (method === 'POST' && pathname === '/api/samples/reset') {
    const body = await readJson(req);
    const keys = body.keys ? body.keys.map(String) : SCENARIOS.map((s) => s.key);
    const scenarios = SCENARIOS.filter((s) => keys.includes(s.key));
    for (const s of scenarios) resetScenario(db, s);
    return json(res, 200, { ok: true, reset: scenarios.map((s) => s.key) });
  }

  const sampleMatch = pathname.match(/^\/api\/samples\/([^/]+)$/);
  if (method === 'POST' && sampleMatch) {
    const key = decodeURIComponent(sampleMatch[1]);
    const scenario = SCENARIOS.find((s) => s.key === key);
    if (!scenario) throw new HttpError(404, '样本不存在');
    const body = await readJson(req);
    if (body.reset !== false) resetScenario(db, scenario);
    const loaded = loadScenario(db, scenario);
    if (loaded.errors.length) {
      throw new HttpError(422, '样本载入失败', loaded.errors);
    }
    const last = loaded.steps[loaded.steps.length - 1];
    return json(res, 200, {
      ok: true,
      ...loaded,
      latestVersion: latestVersion(db),
      result: decorateDetail(getResult(db, scenario.equipmentId, last.version)),
    });
  }

  // 导入 -------------------------------------------------------------------

  if (method === 'POST' && pathname === '/api/import') {
    const body = await readJson(req);
    const text = String(body.text ?? '');
    if (!text.trim()) throw new HttpError(400, '导入内容为空');
    const defaultKind = body.kind === 'maintenance' || body.kind === 'rental' ? body.kind : null;
    const asOf = resolveAsOf(body.asOf);
    const parsed = parseImportText(text, { defaultKind, asOf });
    if (parsed.errors.length) {
      return json(res, 422, {
        ok: false,
        errors: parsed.errors,
        preview: parsed.records.slice(0, 30),
        asOf,
        asOfText: displayOf(asOf),
      });
    }
    if (body.dryRun) {
      return json(res, 200, {
        ok: true,
        dryRun: true,
        count: parsed.records.length,
        records: parsed.records.slice(0, 50),
        asOf,
        asOfText: displayOf(asOf),
      });
    }
    const equipmentIds = [...new Set(parsed.records.map((r) => r.equipmentId))];
    const changed = [];
    tx(db, () => {
      for (const rec of parsed.records) {
        const seq = bumpInputSeq(db);
        const out = upsertRecord(db, rec.side, rec, seq);
        changed.push({ side: rec.side, id: rec.id, equipmentId: rec.equipmentId, before: out.before, after: out.after });
      }
    });
    const published = publish(db, { asOf, equipmentIds, changed, reason: 'import' });
    const warnings = [];
    for (const eq of equipmentIds) {
      const { rentals, maintenance } = listRecords(db, eq);
      warnings.push(...validateRecordSet({ rentals, maintenance }, asOf));
    }
    return json(res, 200, {
      ok: true,
      imported: parsed.records.length,
      equipmentIds,
      version: published.version,
      asOf,
      asOfText: displayOf(asOf),
      warnings,
      summaries: published.computed.map((c) => ({ equipmentId: c.equipmentId, summary: summaryWithText(c.summary) })),
    });
  }

  // 重建与查询 --------------------------------------------------------------

  if (method === 'POST' && pathname === '/api/rebuild') {
    const body = await readJson(req);
    const asOf = resolveAsOf(body.asOf);
    const ids = body.equipmentIds
      ? body.equipmentIds.map(String)
      : body.equipmentId
        ? [String(body.equipmentId)]
        : listEquipment(db);
    const published = publish(db, { asOf, equipmentIds: ids, changed: null, reason: 'rebuild' });
    return json(res, 200, {
      ok: true,
      version: published.version,
      inputSeq: published.inputSeq,
      asOf,
      asOfText: displayOf(asOf),
      equipmentIds: published.equipmentIds,
      summaries: published.computed.map((c) => ({
        equipmentId: c.equipmentId,
        summary: summaryWithText(c.summary),
        incremental: c.incremental,
      })),
    });
  }

  /**
   * 查询重叠明细。必须给出截止时刻（或沿用最近发布值的 asOf）。
   * 若当前发布版本不是该截止时刻，先按该截止时刻发布新版本，再读该版本。
   */
  if (method === 'POST' && pathname === '/api/query') {
    const body = await readJson(req);
    const asOf = resolveAsOf(body.asOf);
    const onlyWithGaps = Boolean(body.onlyWithGaps);
    const onlyWithOverlap = Boolean(body.onlyWithOverlap);
    const versionParam = body.version === undefined || body.version === null || body.version === ''
      ? null
      : Number(body.version);
    if (versionParam !== null && (!Number.isInteger(versionParam) || versionParam < 0)) {
      throw new HttpError(400, 'version 必须是非负整数');
    }

    let version = versionParam;
    let published = null;
    if (version === null) {
      const latest = latestVersion(db);
      const latestMeta = latest === null ? null : getVersion(db, latest);
      if (latestMeta && latestMeta.as_of_ms === asOf) {
        version = latest;
      } else {
        const ids = body.equipmentId ? [String(body.equipmentId)] : listEquipment(db);
        published = publish(db, { asOf, equipmentIds: ids, changed: null, reason: 'query-asof' });
        version = published.version;
      }
    }
    const meta = getVersion(db, version);
    if (!meta) throw new HttpError(404, '版本不存在');
    if (versionParam !== null) {
      const explicit = readAsOf(body.asOf);
      if (explicit !== null && explicit !== meta.as_of_ms) {
        throw new HttpError(409, `版本 ${version} 发布于截止时刻 ${displayOf(meta.as_of_ms)}，与请求的截止时刻不一致`, {
          versionAsOf: meta.as_of_ms,
        });
      }
    }

    const rows = [];
    const rowsByEquipment = new Map();
    for (const equipmentId of JSON.parse(meta.equipment_ids)) {
      if (body.equipmentId && equipmentId !== String(body.equipmentId)) continue;
      const result = getResult(db, equipmentId, version);
      if (!result) continue;
      const decorated = decorateDetail(result);
      for (const d of decorated.detail) {
        if (onlyWithGaps && d.gaps.length === 0) continue;
        if (onlyWithOverlap && d.matches.length === 0) continue;
        rows.push({ equipmentId, version, ...d });
      }
      rowsByEquipment.set(equipmentId, decorated);
    }

    return json(res, 200, {
      ok: true,
      version,
      inputSeq: meta.input_seq,
      asOf: meta.as_of_ms,
      asOfText: displayOf(meta.as_of_ms),
      rows,
      equipment: [...rowsByEquipment.values()],
      publishedNow: published ? published.version : null,
      warnings: [],
    });
  }

  throw new HttpError(404, '接口不存在');
}

/* ------------------------------------------------------------------ 导入解析 */

/** 简单 CSV 行解析（支持双引号转义）。 */
function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/**
 * 导入格式（带表头或按固定列序）：
 *   设备编号,记录编号,开始时刻,结束时刻,类型(rental|maintenance)
 * end 留空表示未结束。类型缺省为租用；也可以用 body.kind 指定整批类型。
 */
export function parseImportText(text, { defaultKind = null, asOf = null } = {}) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const errors = [];
  const records = [];
  if (lines.length === 0) return { records, errors: [{ line: 0, message: '没有可导入的数据行' }] };

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const findIdx = (names, fallback) => {
    const i = header.findIndex((h) => names.includes(h));
    return i >= 0 ? i : fallback;
  };
  const eqIdx = findIdx(['equipment_id', 'equipmentid', 'equipment', '设备编号', '设备'], 0);
  const recIdx = findIdx(['record_no', 'recordno', 'record', '记录编号', '编号'], 1);
  const startIdx = findIdx(['start', 'start_at', '开始时刻', '开始', 'begin'], 2);
  const endIdx = findIdx(['end', 'end_at', '结束时刻', '结束', 'finish'], 3);
  const kindIdx = findIdx(['kind', 'side', 'type', '类型', '类别'], -1);
  // 只有首行确实是已知列名时才算表头；否则按固定列序解析，避免把数据行误当表头。
  const KNOWN = new Set([
    'equipment_id', 'equipmentid', 'equipment', '设备编号', '设备',
    'record_no', 'recordno', 'record', '记录编号', '编号',
    'start', 'start_at', '开始时刻', '开始', 'begin',
    'end', 'end_at', '结束时刻', '结束', 'finish',
    'kind', 'side', 'type', '类型', '类别',
  ]);
  const hasHeader = header.some((h) => KNOWN.has(h)) && header.every((h) => h === '' || KNOWN.has(h));
  // 不带表头时按固定列序：设备,记录,开始,结束,类型（第五列可省）。
  const kindCol = hasHeader ? kindIdx : 4;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  for (let i = 0; i < dataLines.length; i += 1) {
    const lineNo = i + (hasHeader ? 2 : 1);
    const cells = splitCsvLine(dataLines[i]);
    const get = (k) => (k >= 0 ? (cells[k] ?? '').trim() : '');
    const equipmentId = get(eqIdx);
    const recordNo = get(recIdx);
    const kindRaw = (get(kindCol) || defaultKind || '').toLowerCase();
    const side = kindRaw === 'maintenance' || kindRaw === '保养' ? 'maintenance' : 'rental';
    if (!equipmentId || !recordNo) {
      errors.push({ line: lineNo, message: '设备编号与记录编号不能为空' });
      continue;
    }
    let start;
    let end;
    try {
      start = parseInstant(get(startIdx));
      end = parseInstant(get(endIdx));
    } catch (err) {
      errors.push({ line: lineNo, message: err.message });
      continue;
    }
    if (start === null) {
      errors.push({ line: lineNo, message: '开始时刻不能为空' });
      continue;
    }
    if (end !== null && end <= start) {
      errors.push({ line: lineNo, message: '结束时刻必须晚于开始时刻（左闭右开）' });
      continue;
    }
    if (asOf !== null && start > asOf) {
      errors.push({ line: lineNo, message: '开始时刻晚于截止时刻，导入后不会产生任何区间' });
      continue;
    }
    records.push({
      id: `imp-${side}-${equipmentId}-${recordNo}`,
      side,
      equipmentId,
      recordNo,
      start,
      end,
    });
  }
  if (records.length === 0 && errors.length === 0) errors.push({ line: 0, message: '没有可导入的数据行' });
  return { records, errors };
}

/* ------------------------------------------------------------------ 静态文件 */

async function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = normalize(join(STATIC_DIR, rel));
  if (!target.startsWith(STATIC_DIR)) return json(res, 403, { error: '禁止访问' });
  if (!existsSync(target)) {
    const fallback = join(STATIC_DIR, 'index.html');
    if (!existsSync(fallback)) return json(res, 404, { error: '未找到页面' });
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
    return res.end(await readFile(fallback));
  }
  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(await readFile(target));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支持的方法' });
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err instanceof HttpError) {
      return json(res, err.status, { error: err.message, details: err.details });
    }
    console.error('[server error]', err);
    if (!res.headersSent) {
      return json(res, 500, { error: err instanceof Error ? err.message : '服务器内部错误' });
    }
    res.end();
  }
});

export { server, db, summaryWithText };

if (process.env.NODE_ENV !== 'test' && !process.env.NO_LISTEN) {
  server.listen(PORT, () => {
    console.log(`设备租用 / 保养重叠明细服务：http://localhost:${PORT}`);
    console.log(`数据库：${DB_PATH}`);
  });
}
