/* 设备租用 × 保养 重叠明细 —— 前端（零依赖，原生 ES 模块） */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  asOf: null,
  asOfText: null,
  version: null,
  equipment: [],
  results: [],
  samples: [],
  versions: [],
  onlyGaps: false,
  onlyOverlap: false,
};

/* ------------------------------------------------------------ 工具 */

const HOUR = 3_600_000;

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.className = 'toast';
  }, kind === 'err' ? 5200 : 2600);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms === 0) return '0 小时';
  const hours = ms / HOUR;
  if (Math.abs(hours) >= 48) {
    const days = hours / 24;
    return `${Number.isInteger(days) ? days : days.toFixed(1)} 天`;
  }
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
}

function fmtDurationShort(ms) {
  if (!Number.isFinite(ms) || ms === 0) return '—';
  const hours = ms / HOUR;
  if (hours >= 24) return `${+(hours / 24).toFixed(1)}d`;
  return `${+hours.toFixed(1)}h`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ------------------------------------------------------------ 主流程 */

async function boot() {
  try {
    const cfg = await api('GET', '/api/config');
    state.asOf = cfg.asOf;
    state.asOfText = cfg.asOfText;
    $('#asOf').value = cfg.asOfText;
    await Promise.all([loadSamples(), loadEverything()]);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function loadEverything() {
  await Promise.all([loadResults(), loadVersions()]);
}

async function loadResults() {
  const data = await api('GET', '/api/results');
  state.results = data.results;
  state.latestVersion = data.latestVersion;
  state.asOfText = data.results[0]?.asOfText ?? state.asOfText;
  if (state.asOfText) $('#asOf').value = state.asOfText;
  renderKpis();
  renderResults();
  $('#versionChip').textContent = data.latestVersion ? `版本 ${data.latestVersion}` : '版本 —';
}

async function loadVersions() {
  const data = await api('GET', '/api/versions');
  state.versions = data.versions;
  renderVersions();
}

async function loadSamples() {
  const data = await api('GET', '/api/samples');
  state.samples = data.scenarios;
  renderSamples();
}

/* ------------------------------------------------------------ 样本 */

function renderSamples() {
  const box = $('#sampleList');
  if (!state.samples.length) {
    box.innerHTML = '<p class="muted">没有可用样本。</p>';
    return;
  }
  box.innerHTML = state.samples
    .map(
      (s) => `
      <div class="sample">
        <h4>${esc(s.title)} ${s.loaded ? '<span class="tag">已载入</span>' : ''}</h4>
        <div class="actions">
          <button class="ghost small" data-sample="${esc(s.key)}">载入</button>
        </div>
        <p>${esc(s.description)}</p>
        <div class="meta">设备 ${esc(s.equipmentId)} · ${s.stepCount} 步 · 截止 ${esc(s.asOfText)}</div>
      </div>`,
    )
    .join('');
}

$('#sampleList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-sample]');
  if (!btn) return;
  const key = btn.dataset.sample;
  btn.disabled = true;
  try {
    const out = await api('POST', `/api/samples/${key}`, { reset: true });
    if (out.result) {
      state.asOf = out.result.asOf;
      state.asOfText = out.result.asOfText;
      $('#asOf').value = out.result.asOfText;
    }
    toast(`已载入「${out.title}」，发布版本 ${out.steps.at(-1).version}`);
    await Promise.all([loadEverything(), loadSamples()]);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------ 查询 / 重建 */

async function runQuery() {
  const asOf = $('#asOf').value.trim();
  if (!asOf) {
    toast('请先填写固定的截止时刻', 'err');
    return;
  }
  const btn = $('#btnQuery');
  btn.disabled = true;
  try {
    const out = await api('POST', '/api/query', {
      asOf,
      onlyWithGaps: state.onlyGaps,
      onlyWithOverlap: state.onlyOverlap,
    });
    state.asOf = out.asOf;
    state.asOfText = out.asOfText;
    state.version = out.version;
    $('#asOf').value = out.asOfText;
    if (out.publishedNow) toast(`已按截止时刻 ${out.asOfText} 发布版本 ${out.version}`);
    await Promise.all([loadResults(), loadVersions()]);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function rebuildAll() {
  const asOf = $('#asOf').value.trim();
  const btn = $('#btnRebuild');
  btn.disabled = true;
  try {
    const out = await api('POST', '/api/rebuild', { asOf });
    toast(`已整库重建并发布版本 ${out.version}（${out.equipmentIds.length} 台设备）`);
    state.asOf = out.asOf;
    state.asOfText = out.asOfText;
    $('#asOf').value = out.asOfText;
    await Promise.all([loadResults(), loadVersions()]);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

$('#btnQuery').addEventListener('click', runQuery);
$('#btnRebuild').addEventListener('click', rebuildAll);
$('#onlyGaps').addEventListener('change', (e) => {
  state.onlyGaps = e.target.checked;
  renderResults();
});
$('#onlyOverlap').addEventListener('change', (e) => {
  state.onlyOverlap = e.target.checked;
  renderResults();
});

/* ------------------------------------------------------------ KPI */

function renderKpis() {
  const box = $('#kpis');
  const rows = state.results.map((r) => ({
    ...r.summary,
    asOfText: r.asOfText,
    version: r.version,
  }));
  if (!rows.length) {
    box.innerHTML = '';
    return;
  }
  const sum = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const rentalLength = sum('rentalLength');
  const gapLength = sum('gapLength');
  const unionLength = sum('unionLength');
  const matchLength = sum('matchLength');
  const matchCount = sum('matchCount');
  const gapCount = sum('gapCount');
  const uncoveredRatio = rentalLength > 0 ? gapLength / rentalLength : 0;
  const doubleCovered = matchLength - unionLength;

  const kpis = [
    {
      label: '租用总时长',
      value: fmtDuration(rentalLength),
      foot: `${rows.length} 台设备 · ${rows.reduce((s, r) => s + r.rentalCount, 0)} 条租用记录`,
      accent: 'var(--series-1)',
    },
    {
      label: '未被保养覆盖',
      value: `${(uncoveredRatio * 100).toFixed(1)}%`,
      foot: `${fmtDuration(gapLength)} · ${gapCount} 个空档段`,
      accent: 'var(--critical)',
      meter: uncoveredRatio,
    },
    {
      label: '重叠明细条数',
      value: String(matchCount),
      foot: `配对总长 ${fmtDuration(matchLength)}（含重复覆盖）`,
      accent: 'var(--series-2)',
    },
    {
      label: '保养覆盖（并集）',
      value: fmtDuration(unionLength),
      foot: doubleCovered > 0 ? `重复覆盖 ${fmtDuration(doubleCovered)}，按并集只计一次` : '无重复覆盖',
      accent: 'var(--series-3)',
    },
    {
      label: '租用段覆盖状态',
      value: `${sum('cleanCount') + sum('partialCount') + sum('gapOnlyCount')} 段`,
      foot: `完整覆盖 ${sum('cleanCount')} · 部分覆盖 ${sum('partialCount')} · 全空档 ${sum('gapOnlyCount')}`,
      accent: 'var(--text-muted)',
    },
  ];

  box.innerHTML = kpis
    .map(
      (k) => `
      <div class="kpi">
        <span class="swatch" style="background:${k.accent}"></span>
        <div class="label">${esc(k.label)}</div>
        <div class="value">${esc(k.value)}</div>
        ${k.meter !== undefined ? `<div class="meter"><i style="width:${Math.min(100, k.meter * 100).toFixed(1)}%"></i></div>` : ''}
        <div class="foot">${esc(k.foot)}</div>
      </div>`,
    )
    .join('');
}

/* ------------------------------------------------------------ 结果 */

function visibleDetails(result) {
  return result.detail.filter((d) => {
    if (state.onlyGaps && d.gaps.length === 0) return false;
    if (state.onlyOverlap && d.matches.length === 0) return false;
    return true;
  });
}

function renderResults() {
  const body = $('#resultBody');
  if (!state.results.length) {
    body.innerHTML = '<p class="empty">尚无已发布结果。导入数据或载入一个样本。</p>';
    return;
  }
  const blocks = state.results
    .map((r) => {
      const details = visibleDetails(r);
      if (!details.length) return '';
      return renderEquipment(r, details);
    })
    .filter(Boolean);
  body.innerHTML = blocks.length
    ? blocks.join('')
    : '<p class="empty">当前筛选条件下没有租用段。</p>';
}

function renderEquipment(result, details) {
  const s = result.summary;
  const recordNo = new Map([...(result.rentals ?? []), ...(result.maintenance ?? [])].map((x) => [x.id, x.recordNo]));
  const allSegs = details.flatMap((d) => [d.rental.start, d.rental.effectiveEnd]);
  const min = Math.min(...allSegs);
  const max = Math.max(...allSegs);
  const span = Math.max(1, max - min);

  const pct = (t) => ((t - min) / span) * 100;

  const dayTicks = buildTicks(min, max);

  const axis = `
    <div class="tl-axis">
      ${dayTicks
        .map((t) => `<span style="left:${pct(t).toFixed(2)}%">${esc(shortTime(t, span))}</span>`)
        .join('')}
    </div>`;

  const rows = details
    .map((d) => {
      const rentalBar = bar(pct(d.rental.start), pct(d.rental.effectiveEnd), 'rental', d.rental.openEnded, {
        title: `租用 ${recordNo.get(d.rental.id) || d.rental.id}：${d.rentalView.startText} 至 ${d.rentalView.declaredEndText}`,
        kind: 'rental',
        id: d.rental.id,
        eq: result.equipmentId,
        rentalId: d.rental.id,
      });
      const maintList = (result.maintenance ?? [])
        .map((m) => {
          const effEnd = m.end === null ? d.rental.effectiveEnd : m.end;
          return { m, effEnd };
        })
        .filter(({ m, effEnd }) => m.start < d.rental.effectiveEnd && effEnd > d.rental.start)
        .sort((a, b) => a.m.start - b.m.start || String(a.m.recordNo).localeCompare(String(b.m.recordNo)));
      const maintRows = maintList
        .map(({ m, effEnd }, idx) => {
          const left = Math.max(m.start, d.rental.start);
          const right = Math.min(effEnd, d.rental.effectiveEnd);
          const clipStart = m.start < d.rental.start;
          const clipEnd = effEnd > d.rental.effectiveEnd && m.end !== null;
          const fullText = `${m.startText ?? ''} 至 ${m.end === null ? '未结束' : m.endText ?? ''}`;
          const clipNote = [clipStart ? '左端超出租用段，已截断' : '', clipEnd ? '右端超出租用段，已截断' : '']
            .filter(Boolean)
            .join('；');
          return `
        <div class="tl-row${idx === 0 ? ' group-start' : ''}">
          <span class="row-label maint" title="保养 ${esc(m.recordNo || m.id)}">${esc(m.recordNo || m.id)}</span>
          <div class="track">${bar(pct(left), pct(right), 'maintenance', m.end === null, {
            title: `保养 ${m.recordNo || m.id}：${fullText}${clipNote ? `（${clipNote}）` : ''}`,
            kind: 'maintenance',
            id: m.id,
            eq: result.equipmentId,
            clipStart,
            clipEnd,
          })}</div>
        </div>`;
        })
        .join('');
      const covBars = d.coverage
        .map((c) =>
          bar(pct(c.start), pct(c.end), 'coverage', false, {
            title: `覆盖 ${c.startText} 至 ${c.endText}，保养 ${c.maintenanceIds.length} 条`,
            kind: 'coverage',
            eq: result.equipmentId,
            rentalId: d.rental.id,
            start: c.start,
          }),
        )
        .join('');
      const gapBars = d.gaps
        .map((g) =>
          bar(pct(g.start), pct(g.end), 'gap', false, {
            title: `空档 ${g.startText} 至 ${g.endText}（${fmtDuration(g.lengthMs)}）`,
            kind: 'gap',
            eq: result.equipmentId,
            rentalId: d.rental.id,
            start: g.start,
          }),
        )
        .join('');
      const label = recordNo.get(d.rental.id) || d.rental.id;
      return `
        ${maintRows}
        <div class="tl-row">
          <span class="row-label mine" title="${esc(label)}">${esc(label)}</span>
          <div class="track">${rentalBar}</div>
        </div>
        <div class="tl-row">
          <span class="row-label" title="覆盖并集与空档">覆盖 / 空档</span>
          <div class="track">${covBars}${gapBars}</div>
        </div>`;
    })
    .join('');

  const matchRows = details
    .flatMap((d) =>
      d.matches.map((m) => {
        const isDup = overlapsAnother(d.matches, m);
        return `
        <tr class="clickable" data-match="1" data-eq="${esc(result.equipmentId)}" data-rental="${esc(d.rental.id)}" data-maint="${esc(m.maintenanceId)}" data-version="${result.version}">
          <td class="num"><span class="swatch-dot" style="background:var(--series-2)"></span>${esc(recordNo.get(m.maintenanceId) || m.maintenanceId)}</td>
          <td class="num">${esc(recordNo.get(d.rental.id) || d.rental.id)}</td>
          <td class="num">${esc(m.startText)}</td>
          <td class="num">${esc(m.endText)}</td>
          <td class="num">${esc(fmtDuration(m.lengthMs))}</td>
          <td>${isDup ? '<span class="tag" title="与另一条保养的匹配交叠；配对总长会重复计入，覆盖分析按并集">重复覆盖</span>' : ''}</td>
          <td><div class="reasons">${m.reasons.map((r) => `<span>${esc(r)}</span>`).join('')}</div></td>
        </tr>`;
      }),
    )
    .join('');

  const gapRows = details
    .flatMap((d) =>
      d.gaps.map(
        (g, i) => `
        <tr class="clickable" data-gap="1" data-eq="${esc(result.equipmentId)}" data-rental="${esc(d.rental.id)}" data-start="${g.start}" data-version="${result.version}">
          <td class="num"><span class="swatch-dot" style="background:var(--critical)"></span>${esc(recordNo.get(d.rental.id) || d.rental.id)}</td>
          <td class="num">#${i + 1}</td>
          <td class="num">${esc(g.startText)}</td>
          <td class="num">${esc(g.endText)}</td>
          <td class="num">${esc(fmtDuration(g.lengthMs))}</td>
          <td class="muted">并集切段</td>
        </tr>`,
      ),
    )
    .join('');

  const pills = [
    `<span class="pill"><span class="dot" style="background:var(--series-1)"></span>租用 ${s.rentalCount}</span>`,
    `<span class="pill"><span class="dot" style="background:var(--series-2)"></span>保养 ${s.maintenanceCount}</span>`,
    `<span class="pill"><span class="dot" style="background:var(--series-3)"></span>覆盖 ${fmtDuration(s.unionLength)}</span>`,
    s.gapLength > 0
      ? `<span class="pill danger"><span class="dot" style="background:var(--critical)"></span>空档 ${fmtDuration(s.gapLength)}（${s.gapCount} 段）</span>`
      : '<span class="pill"><span class="dot" style="background:var(--good)"></span>无空档</span>',
    s.openRentalCount + s.openMaintenanceCount > 0
      ? `<span class="pill warn">含 ${s.openRentalCount + s.openMaintenanceCount} 条未结束记录，按 ${esc(result.asOfText)} 封闭</span>`
      : '',
    s.doubleCoveredMs > 0 ? `<span class="pill">重复覆盖 ${fmtDuration(s.doubleCoveredMs)}</span>` : '',
  ]
    .filter(Boolean)
    .join('');

  return `
    <div class="equip-block" data-equip="${esc(result.equipmentId)}">
      <div class="equip-head">
        <h3>${esc(result.equipmentId)}</h3>
        ${pills}
        <div class="head-tools">
          <span class="pill">截止 ${esc(result.asOfText)} · v${result.version}</span>
          <button class="ghost small" data-add-rental="${esc(result.equipmentId)}">＋ 租用段</button>
          <button class="ghost small" data-add-maint="${esc(result.equipmentId)}">＋ 保养段</button>
        </div>
      </div>
      <div class="legend">
        <span class="legend-item"><i style="background:var(--series-1)"></i>租用</span>
        <span class="legend-item"><i style="background:var(--series-2)"></i>保养</span>
        <span class="legend-item"><i style="background:var(--series-3)"></i>覆盖（并集）</span>
        <span class="legend-item"><i style="background:repeating-linear-gradient(135deg, rgba(208,59,59,0.5) 0 2px, rgba(208,59,59,0.14) 2px 5px);border:1px solid rgba(208,59,59,0.35)"></i>空档</span>
        <span class="legend-item muted" style="font-size:11.5px">自上而下：各条保养记录 · 租用 · 覆盖/空档（白色缺口 = 超出租用段已截断）</span>
      </div>
      <div class="timeline">
        ${axis}
        <div class="tl-rows">
          <div class="tl-grid">${dayTicks.map((t) => `<i style="left:${pct(t).toFixed(2)}%"></i>`).join('')}</div>
          ${rows}
        </div>
      </div>
      ${renderRecordTables(result)}
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>保养记录</th><th>租用记录</th><th>交集开始</th><th>交集结束</th><th class="num">时长</th><th></th><th>切段依据</th></tr>
          </thead>
          <tbody>${matchRows || '<tr class="empty-row"><td colspan="7">没有匹配的重叠区间</td></tr>'}</tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>租用记录</th><th>空档段</th><th>开始</th><th>结束</th><th class="num">时长</th><th>来源</th></tr>
          </thead>
          <tbody>${gapRows || '<tr class="empty-row"><td colspan="6">租用段全部被保养覆盖，没有空档</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

/** 原始记录表：点击即可更正 / 撤回，修改后触发受影响区间重建。 */
function renderRecordTables(result) {
  const rentals = result.rentalsView ?? result.rentals ?? [];
  const maintenance = result.maintenanceView ?? result.maintenance ?? [];
  const rowsFor = (list, side) =>
    list
      .map(
        (r) => `
      <tr class="clickable" data-record="${esc(r.id)}" data-side="${side}" data-eq="${esc(result.equipmentId)}">
        <td class="num"><span class="swatch-dot" style="background:var(--series-${side === 'rental' ? 1 : 2})"></span>${esc(r.recordNo ?? r.id)}</td>
        <td class="num">${esc(r.startText ?? '')}</td>
        <td class="num">${r.end === null ? '<span class="tag">未结束</span>' : esc(r.endText ?? '')}</td>
        <td class="num muted">r${r.revision ?? 1}</td>
      </tr>`,
      )
      .join('');
  return `
    <div class="grid-2 record-tables">
      <div class="table-wrap">
        <table>
          <thead><tr><th>租用记录</th><th>开始</th><th>结束</th><th>修订</th></tr></thead>
          <tbody>${rowsFor(rentals, 'rental') || '<tr class="empty-row"><td colspan="4">没有租用记录</td></tr>'}</tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>保养记录</th><th>开始</th><th>结束</th><th>修订</th></tr></thead>
          <tbody>${rowsFor(maintenance, 'maintenance') || '<tr class="empty-row"><td colspan="4">没有保养记录</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function bar(left, right, kind, openEnd, data) {
  const width = Math.max(0, right - left);
  const title = esc(data.title);
  const clip = `${data.clipStart ? ' clip-start' : ''}${data.clipEnd ? ' clip-end' : ''}`;
  return `<div class="tl-bar ${kind}${openEnd ? ' open-end' : ''}${clip}" tabindex="0" role="button"
    aria-label="${title}" title="${title}"
    style="left:${left.toFixed(3)}%;width:${Math.max(width, 0.35).toFixed(3)}%"
    data-kind="${esc(data.kind)}" data-eq="${esc(data.eq ?? '')}" data-id="${esc(data.id ?? '')}"
    data-rental="${esc(data.rentalId ?? '')}" data-start="${data.start ?? ''}"
    data-tip="${title}"></div>`;
}

function overlapsAnother(matches, m) {
  return matches.some(
    (o) => o !== m && o.maintenanceId !== m.maintenanceId && o.start < m.end && o.end > m.start,
  );
}

function buildTicks(min, max) {
  const span = max - min;
  const day = 24 * HOUR;
  let step = day;
  const target = 6;
  const steps = [HOUR * 6, HOUR * 12, day, day * 2, day * 7, day * 14, day * 30, day * 90];
  for (const s of steps) {
    if (span / s <= target) {
      step = s;
      break;
    }
    step = s;
  }
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let t = start; t <= max; t += step) ticks.push(t);
  if (ticks.length === 0) ticks.push(min, max);
  if (ticks[0] !== min && ticks[0] - min > step * 0.5) ticks.unshift(min);
  return ticks;
}

function shortTime(ms, span) {
  const d = new Date(ms);
  const iso = d.toISOString();
  if (span >= 3 * 24 * HOUR) return iso.slice(5, 10);
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/* ------------------------------------------------------------ 版本 */

function renderVersions() {
  const box = $('#versionBody');
  if (!state.versions.length) {
    box.innerHTML = '<p class="empty">载入数据后显示每次发布的版本、截止时刻与重建范围。</p>';
    return;
  }
  const latest = state.versions[0].version;
  box.innerHTML = `<div class="versions">${state.versions
    .map((v) => {
      const reasons = v.incrementalText || reasonsFor(v);
      return `
      <div class="version-row ${v.version === latest ? 'current' : ''}">
        <div class="v">v${v.version}<small>${esc(v.generatedAtText)}</small></div>
        <div class="desc">
          <b>截止 ${esc(v.asOfText)}</b> · ${v.equipmentIds.length} 台设备 · 输入快照 #${v.inputSeq}
          ${reasons ? `<div class="incremental">${esc(reasons)}</div>` : ''}
        </div>
        <div class="actions">
          <button class="ghost small" data-view-version="${v.version}">查看</button>
          <a class="ghost small" style="text-decoration:none;padding:4px 10px;border:1px solid var(--axis);border-radius:8px;color:var(--text-secondary)" href="/api/versions/${v.version}/export">导出</a>
        </div>
      </div>`;
    })
    .join('')}</div>`;
}

/**
 * 版本行的“重建范围”说明：用该设备结果里的 incremental 报告生成。
 * 版本列表接口不带明细，这里用最近一次结果的整体摘要；载入样本 / 变更后
 * 该信息由 /api/results 提供，因此只对当前版本完整。
 */
function reasonsFor(v) {
  if (v.version !== state.latestVersion) return '';
  const parts = [];
  for (const r of state.results) {
    const inc = r.incremental;
    if (!inc) continue;
    if (inc.reusedAll) continue;
    if (inc.cutoffChanged) parts.push(`${r.equipmentId} 截止时刻变化，全量`);
    const affected = inc.affectedRentalIds?.length ?? 0;
    const reused = inc.reusedRentalIds?.length ?? 0;
    if (affected) parts.push(`${r.equipmentId} 重算 ${affected} 段${reused ? `、复用 ${reused} 段` : ''}`);
  }
  return parts.join('；');
}

$('#versionBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-view-version]');
  if (!btn) return;
  const version = Number(btn.dataset.viewVersion);
  try {
    const out = await api('POST', '/api/query', { version });
    state.version = version;
    state.asOf = out.asOf;
    state.asOfText = out.asOfText;
    $('#asOf').value = out.asOfText;
    state.results = out.equipment.map((r) => ({ ...r, summary: r.summary }));
    renderKpis();
    renderResults();
    $('#versionChip').textContent = `版本 ${version}（历史）`;
    $('#resultBody').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(`正在查看历史版本 ${version}（截止 ${out.asOfText}）`);
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btnRefreshVersions').addEventListener('click', loadVersions);

/* ------------------------------------------------------------ 导入 */

function report(html, kind = 'ok') {
  const el = $('#importReport');
  el.hidden = false;
  el.className = `report ${kind}`;
  el.innerHTML = html;
}

async function doImport(dryRun) {
  const text = $('#importText').value;
  const btn = dryRun ? $('#btnDryRun') : $('#btnImport');
  btn.disabled = true;
  try {
    const out = await api('POST', '/api/import', { text, asOf: $('#asOf').value.trim(), dryRun });
    if (dryRun) {
      report(
        `预检通过：${out.count} 条记录可导入（截止 ${esc(out.asOfText)}）。<br>` +
          out.records
            .slice(0, 8)
            .map((r) => `${esc(r.equipmentId)} · ${esc(r.recordNo)} · ${r.side === 'rental' ? '租用' : '保养'}`)
            .join('；'),
      );
    } else {
      report(
        `已导入 ${out.imported} 条记录，涉及 ${out.equipmentIds.length} 台设备，发布版本 ${out.version}（截止 ${esc(out.asOfText)}）。` +
          (out.warnings?.length
            ? `<ul>${out.warnings.map((w) => `<li>${esc(w.equipmentId ? `${w.equipmentId} · ` : '')}${esc(w.message)}</li>`).join('')}</ul>`
            : ''),
      );
      toast(`导入完成，版本 ${out.version}`);
      await Promise.all([loadEverything(), loadSamples()]);
    }
  } catch (err) {
    const details = err.data?.errors;
    if (details?.length) {
      report(
        `预检未通过（${details.length} 处问题），未写入任何数据：<ul>${details
          .map((d) => `<li>第 ${d.line ?? '?'} 行：${esc(d.message)}</li>`)
          .join('')}</ul>`,
        'err',
      );
    } else {
      report(esc(err.message), 'err');
    }
  } finally {
    btn.disabled = false;
  }
}

$('#btnImport').addEventListener('click', () => doImport(false));
$('#btnDryRun').addEventListener('click', () => doImport(true));
$('#btnImportToggle').addEventListener('click', (e) => {
  const body = $('#importBody');
  const hidden = body.hidden;
  body.hidden = !hidden;
  e.target.textContent = hidden ? '收起' : '展开';
  e.target.setAttribute('aria-expanded', String(hidden));
});

/* ------------------------------------------------------------ 核对 */

$('#btnVerify').addEventListener('click', async () => {
  const btn = $('#btnVerify');
  btn.disabled = true;
  try {
    const out = await api('GET', '/api/verify');
    if (out.ok) {
      toast(`朴素扫描核对通过：版本 ${out.version} 的 ${out.checkedRentals} 段租用与引擎完全一致`);
    } else {
      toast(`核对发现 ${out.diffCount} 处不一致（版本 ${out.version}），请查看控制台`, 'err');
      console.table(out.diffs);
    }
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------ 抽屉 / 追溯 */

const drawer = $('#drawer');
function openDrawer(kindLabel, title, html) {
  $('#drawerKind').textContent = kindLabel;
  $('#drawerTitle').textContent = title;
  $('#drawerBody').innerHTML = html;
  drawer.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  drawer.hidden = true;
  document.body.style.overflow = '';
}
drawer.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeDrawer();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !drawer.hidden) closeDrawer();
});

async function currentResultFor(eq, version) {
  if (!eq) {
    toast('无法定位设备，请刷新页面后重试', 'err');
    return null;
  }
  const qs = Number.isInteger(version) ? `?version=${version}` : '';
  const out = await api('GET', `/api/equipment/${encodeURIComponent(eq)}/result${qs}`);
  return out.result;
}

$('#resultBody').addEventListener('click', async (e) => {
  const addRental = e.target.closest('[data-add-rental]');
  if (addRental) return openRecordEditor(null, { equipmentId: addRental.dataset.addRental, side: 'rental' });
  const addMaint = e.target.closest('[data-add-maint]');
  if (addMaint) return openRecordEditor(null, { equipmentId: addMaint.dataset.addMaint, side: 'maintenance' });

  const recRow = e.target.closest('tr[data-record]');
  if (recRow) {
    return openRecordEditor(recRow.dataset.record, { side: recRow.dataset.side, equipmentId: recRow.dataset.eq });
  }

  const barEl = e.target.closest('.tl-bar');
  if (barEl) {
    if (barEl.dataset.kind === 'maintenance') return openRecordEditor(barEl.dataset.id, { side: 'maintenance', equipmentId: barEl.dataset.eq });
    if (barEl.dataset.kind === 'rental') return openRecordEditor(barEl.dataset.id, { side: 'rental', equipmentId: barEl.dataset.eq });
    if (barEl.dataset.kind === 'coverage') return openCoverageDetail(barEl.dataset.eq, barEl.dataset.rental, Number(barEl.dataset.start));
    if (barEl.dataset.kind === 'gap') return openGapDetail(barEl.dataset.eq, barEl.dataset.rental, Number(barEl.dataset.start));
    return;
  }

  const matchRow = e.target.closest('tr[data-match]');
  if (matchRow) {
    return openMatchDetail(
      matchRow.dataset.eq,
      matchRow.dataset.rental,
      matchRow.dataset.maint,
      Number(matchRow.dataset.version),
    );
  }
  const gapRow = e.target.closest('tr[data-gap]');
  if (gapRow) {
    return openGapDetail(gapRow.dataset.eq, gapRow.dataset.rental, Number(gapRow.dataset.start));
  }
});

function recordOf(result, id) {
  return [...(result.rentals ?? []), ...(result.maintenance ?? [])].find((r) => r.id === id);
}

async function openMatchDetail(eq, rentalId, maintId, version) {
  const result = await currentResultFor(eq, version);
  if (!result) return;
  const d = result.detail.find((x) => x.rental.id === rentalId);
  const m = d?.matches.find((x) => x.maintenanceId === maintId);
  if (!d || !m) return toast('该匹配不在当前版本中', 'err');
  const rental = recordOf(result, rentalId);
  const maint = recordOf(result, maintId);
  const others = d.matches.filter((x) => x.maintenanceId !== maintId);
  openDrawer(
    '重叠明细追溯',
    `${maint?.recordNo ?? maintId} × ${rental?.recordNo ?? rentalId}`,
    `
    <div class="kv">
      <dt>设备</dt><dd>${esc(eq)}</dd>
      <dt>交集</dt><dd>${esc(m.startText)} 至 ${esc(m.endText)}（${esc(fmtDuration(m.lengthMs))}）</dd>
      <dt>租用段</dt><dd>${esc(rental?.recordNo ?? rentalId)}：${esc(d.rentalView.startText)} 至 ${esc(d.rentalView.declaredEndText)}${d.rental.openEnded ? '（未结束，按截止时刻封闭）' : ''}</dd>
      <dt>保养段</dt><dd>${esc(maint?.recordNo ?? maintId)}：${esc(m.maintenanceStartText)} 至 ${esc(m.maintenanceEndText)}</dd>
      <dt>版本</dt><dd>v${result.version} · 截止 ${esc(result.asOfText)} · 输入快照 #${result.inputSeq}</dd>
    </div>
    <div>
      <h4>切段依据</h4>
      <div class="reasons">${m.reasons.map((r) => `<span>${esc(r)}</span>`).join('')}</div>
    </div>
    <div>
      <h4>同一租用段的其它匹配</h4>
      ${
        others.length
          ? `<div class="table-wrap"><table><thead><tr><th>保养</th><th>开始</th><th>结束</th><th>时长</th></tr></thead><tbody>${others
              .map(
                (o) =>
                  `<tr><td class="num">${esc(recordOf(result, o.maintenanceId)?.recordNo ?? o.maintenanceId)}</td><td class="num">${esc(o.startText)}</td><td class="num">${esc(o.endText)}</td><td class="num">${esc(fmtDuration(o.lengthMs))}</td></tr>`,
              )
              .join('')}</tbody></table></div>`
          : '<p class="muted" style="font-size:12px">没有其它匹配。</p>'
      }
    </div>
    <div>
      <h4>该租用段的覆盖与空档</h4>
      <div class="kv">
        <dt>覆盖并集</dt><dd>${d.coverage.map((c) => `${esc(c.startText)} 至 ${esc(c.endText)}`).join('；') || '无'}</dd>
        <dt>空档</dt><dd>${d.gaps.map((g) => `${esc(g.startText)} 至 ${esc(g.endText)}`).join('；') || '无'}</dd>
        <dt>重复覆盖</dt><dd>${esc(fmtDuration(d.doubleCoveredMs))}</dd>
      </div>
    </div>
    <div class="actions">
      <button class="ghost small" data-edit="${esc(maintId)}" data-side="maintenance" data-eq="${esc(eq)}">更正保养段</button>
      <button class="ghost small" data-edit="${esc(rentalId)}" data-side="rental" data-eq="${esc(eq)}">更正租用段</button>
    </div>`,
  );
}

async function openGapDetail(eq, rentalId, start) {
  const result = await currentResultFor(eq, null);
  if (!result) return;
  const d = result.detail.find((x) => x.rental.id === rentalId);
  const gap = d?.gaps.find((g) => g.start === start);
  if (!d || !gap) return toast('该空档不在当前版本中', 'err');
  const rental = recordOf(result, rentalId);
  const near = (result.maintenance ?? []).filter(
    (m) => m.start < gap.end && (m.end ?? Infinity) > gap.start,
  );
  const adjacent = (result.maintenance ?? []).filter(
    (m) => m.end === gap.start || m.start === gap.end,
  );
  openDrawer(
    '空档追溯',
    `${rental?.recordNo ?? rentalId} · 空档 ${gap.startText} 至 ${gap.endText}`,
    `
    <div class="kv">
      <dt>设备</dt><dd>${esc(eq)}</dd>
      <dt>空档</dt><dd>${esc(gap.startText)} 至 ${esc(gap.endText)}（${esc(fmtDuration(gap.lengthMs))}）</dd>
      <dt>租用段</dt><dd>${esc(d.rentalView.startText)} 至 ${esc(d.rentalView.declaredEndText)}</dd>
      <dt>版本</dt><dd>v${result.version} · 截止 ${esc(result.asOfText)}</dd>
    </div>
    <div class="callout">
      空档由「租用段减去全部有效保养段的并集」切出，时长取切段累加，不采用总时长相减。
      因此同一租用段可以有多个空档段。
    </div>
    <div>
      <h4>与该段交叠的保养记录</h4>
      <p class="muted" style="font-size:12px">无 —— 没有任何保养段与它交叠，这正是它成为空档的原因（共 ${near.length} 条）。</p>
    </div>
    <div>
      <h4>两端相接的保养记录（相接不算重叠）</h4>
      ${
        adjacent.length
          ? `<div class="table-wrap"><table><thead><tr><th>保养</th><th>开始</th><th>结束</th></tr></thead><tbody>${adjacent
              .map(
                (m) =>
                  `<tr><td class="num">${esc(m.recordNo ?? m.id)}</td><td class="num">${esc(m.end === gap.start ? '恰在此结束' : '')}</td><td class="num">${esc(m.start === gap.end ? '恰在此开始' : '')}</td></tr>`,
              )
              .join('')}</tbody></table></div>`
          : '<p class="muted" style="font-size:12px">两端没有相接的保养记录。</p>'
      }
    </div>
    <div class="actions">
      <button class="ghost small" data-add-maint-near="${esc(eq)}" data-start="${esc(gap.startText)}" data-end="${esc(gap.endText)}">补一条保养覆盖这里</button>
      <button class="ghost small" data-edit="${esc(rentalId)}" data-side="rental" data-eq="${esc(eq)}">更正租用段</button>
    </div>`,
  );
}

async function openCoverageDetail(eq, rentalId, start) {
  const result = await currentResultFor(eq, null);
  if (!result) return;
  const d = result.detail.find((x) => x.rental.id === rentalId);
  const c = d?.coverage.find((x) => x.start === start);
  if (!d || !c) return toast('该覆盖段不在当前版本中', 'err');
  const overlapping = d.matches.filter((m) => m.start < c.end && m.end > c.start);
  openDrawer(
    '覆盖段追溯',
    `${recordOf(result, rentalId)?.recordNo ?? rentalId} · 覆盖 ${c.startText} 至 ${c.endText}`,
    `
    <div class="kv">
      <dt>设备</dt><dd>${esc(eq)}</dd>
      <dt>覆盖</dt><dd>${esc(c.startText)} 至 ${esc(c.endText)}（${esc(fmtDuration(c.lengthMs))}）</dd>
      <dt>合并自</dt><dd>${c.maintenanceIds.map((id) => esc(recordOf(result, id)?.recordNo ?? id)).join('、')}</dd>
      <dt>接缝</dt><dd>${c.seams.length ? c.seams.map((s) => esc(new Date(s).toISOString().slice(0, 16).replace('T', ' '))).join('、') : '无'}</dd>
    </div>
    <div class="callout">覆盖段是若干保养区间的并集。段内可能跨多条保养记录；接缝表示两条保养段恰好在此时刻相接，接缝两侧仍是连续覆盖。</div>
    <div>
      <h4>落在本段内的匹配明细</h4>
      <div class="table-wrap"><table><thead><tr><th>保养</th><th>交集开始</th><th>交集结束</th><th>时长</th></tr></thead><tbody>${overlapping
        .map(
          (m) =>
            `<tr><td class="num">${esc(recordOf(result, m.maintenanceId)?.recordNo ?? m.maintenanceId)}</td><td class="num">${esc(m.startText)}</td><td class="num">${esc(m.endText)}</td><td class="num">${esc(fmtDuration(m.lengthMs))}</td></tr>`,
        )
        .join('')}</tbody></table></div>
    </div>`,
  );
}

/* 抽屉内的编辑入口 */
drawer.addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) return openRecordEditor(edit.dataset.edit, { side: edit.dataset.side, equipmentId: edit.dataset.eq });
  const addNear = e.target.closest('[data-add-maint-near]');
  if (addNear) {
    return openRecordEditor(null, {
      equipmentId: addNear.dataset.addMaintNear,
      side: 'maintenance',
      start: addNear.dataset.start,
      end: addNear.dataset.end,
    });
  }
});

/* ------------------------------------------------------------ 记录编辑器 */

async function openRecordEditor(id, opts) {
  const { side, equipmentId } = opts;
  let record = null;
  if (id) {
    try {
      const row = await api('GET', `/api/${side === 'rental' ? 'rentals' : 'maintenance'}/${encodeURIComponent(id)}`);
      record = {
        id: row.id,
        recordNo: row.record_no,
        start: row.startIso,
        end: row.end_ms === null ? null : row.endIso,
        startText: row.startText,
        endText: row.endText,
      };
    } catch (err) {
      return toast(err.message, 'err');
    }
  }
  const startVal = record?.startText ?? opts.start ?? state.asOfText ?? '';
  const endVal = record ? (record.endIso ? record.endText : '') : opts.end ?? '';
  openDrawer(
    id ? '更正记录' : '新增记录',
    `${equipmentId} · ${side === 'rental' ? '租用段' : '保养段'}${record ? ` · ${record.recordNo}` : ''}`,
    `
    <form id="recordForm" class="form-grid" autocomplete="off">
      <label class="field">
        <span>设备编号</span>
        <input type="text" name="equipmentId" value="${esc(equipmentId)}" readonly>
      </label>
      <label class="field">
        <span>记录编号</span>
        <input type="text" name="recordNo" value="${esc(record?.recordNo ?? '')}" required maxlength="120" placeholder="例如 M-6001">
      </label>
      <label class="field">
        <span>开始时刻 <em>UTC，YYYY-MM-DD HH:mm</em></span>
        <input type="text" name="start" value="${esc(startVal)}" class="mono" required>
      </label>
      <label class="field">
        <span>结束时刻 <em>留空 = 未结束</em></span>
        <input type="text" name="end" value="${esc(endVal)}" class="mono" placeholder="未结束">
      </label>
      <p class="hint full">区间为左闭右开：结束时刻不包含在内；结束时刻等于开始时刻会被拒绝。</p>
      <div class="actions full">
        <button type="submit" class="primary">${id ? '保存并重建' : '新增并重建'}</button>
        ${id ? `<button type="button" class="ghost" data-delete-record="${esc(id)}" data-side="${side}">撤回此记录</button>` : ''}
        <span class="hint">保存后只重建该设备的相关租用段，并发布新版本。</span>
      </div>
      <div id="editorError" class="full"></div>
    </form>`,
  );

  $('#recordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      equipmentId,
      recordNo: String(f.get('recordNo') ?? '').trim(),
      start: String(f.get('start') ?? '').trim(),
      end: String(f.get('end') ?? '').trim() || null,
      asOf: state.asOfText,
    };
    try {
      if (id) await api('PUT', `/api/${side === 'rental' ? 'rentals' : 'maintenance'}/${encodeURIComponent(id)}`, body);
      else await api('POST', side === 'rental' ? '/api/rentals' : '/api/maintenance', body);
      closeDrawer();
      toast(id ? '已更正并发布新版本' : '已新增并发布新版本');
      await Promise.all([loadEverything(), loadSamples()]);
    } catch (err) {
      $('#editorError').innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
    }
  });

  const del = $('#recordForm [data-delete-record]');
  if (del) {
    del.addEventListener('click', async () => {
      if (!confirm('撤回后将从查询结果中消失；同一设备只重建必要区间并发布新版本。继续？')) return;
      try {
        await api('DELETE', `/api/${side === 'rental' ? 'rentals' : 'maintenance'}/${encodeURIComponent(id)}`, {
          asOf: state.asOfText,
        });
        closeDrawer();
        toast('已撤回并发布新版本');
        await Promise.all([loadEverything(), loadSamples()]);
      } catch (err) {
        $('#editorError').innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
      }
    });
  }
}

boot();
