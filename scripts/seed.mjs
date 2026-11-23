#!/usr/bin/env node
/**
 * 从空仓库一键灌入四个样本场景（每步一个版本）。
 *   node scripts/seed.mjs [--db data/app.db]
 * 页面上的“载入样本”走同一套 samples.js 代码，结果与手工操作一致。
 */
import { openDb } from '../server/store.js';
import { SCENARIOS } from '../server/fixtures.js';
import { loadScenario, resetScenario } from '../server/samples.js';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const dbArg = args.find((a) => a.startsWith('--db='));
const dbPath = dbArg ? dbArg.slice('--db='.length) : args[args.indexOf('--db') + 1] || 'data/app.db';
if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
const db = openDb(dbPath);

for (const scenario of SCENARIOS) {
  resetScenario(db, scenario);
  const loaded = loadScenario(db, scenario);
  const last = loaded.steps.at(-1);
  const mine = last.computed.find((c) => c.equipmentId === scenario.equipmentId) ?? last.computed[0];
  console.log(
    `${scenario.key.padEnd(18)} ${scenario.equipmentId}  版本 ${last.version}  截止 ${last.asOf ? new Date(last.asOf).toISOString().slice(0, 16).replace('T', ' ') : '-'}  匹配 ${mine.summary.matchCount}  空档 ${mine.summary.gapCount}`,
  );
}
console.log(`\n已写入 ${dbPath}`);
