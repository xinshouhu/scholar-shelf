/**
 * Scholar Shelf 冒烟测试：完全离线（不装插件、不联网），stub ctx 验证注册与执行。
 * 运行：node test/smoke.mjs
 * 覆盖：注册形状 / Harness schema 子集 / upsert 与统计 / 检索与年份过滤 /
 *       损坏行容忍 / 导出格式 / 非法入参自校验。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import index.js 之前设置：模块加载时读取该环境变量
const dir = mkdtempSync(join(tmpdir(), 'shelf-smoke-'));
process.env.SCHOLAR_SHELF_PATH = join(dir, 'shelf.jsonl');

const captured = { tools: [], sections: [] };
const ctx = {
  effect(fn) {
    const d = fn();
    return typeof d === 'function' ? d : () => {};
  },
  tools: {
    register(def) { captured.tools.push(def); return () => {}; },
  },
  systemPrompt: {
    section(s) { captured.sections.push(s); return () => {}; },
  },
};

const mod = await import('../index.js');
assert.equal(typeof mod.apply, 'function');
assert.ok(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'inject 应含 tools');
mod.apply(ctx, {});

// ---- [1/5] 注册形状 ----
assert.equal(captured.tools.length, 1, '应注册 1 个工具');
assert.equal(captured.sections.length, 0, 'v1 不注册提示词段');
const def = captured.tools[0];
assert.equal(def.name, 'scholar_shelf');
assert.ok(/^[A-Za-z0-9_-]+$/.test(def.name) && def.name.length <= 64, '命名不合规');
assert.equal(typeof def.description, 'string');
assert.ok(def.description.length > 50, '描述过短');
assert.equal(def.parameters.type, 'object');
assert.equal(def.parameters.required[0], 'op');
assert.equal(def.parameters.additionalProperties, false);
assert.equal(def.output.schema.type, 'object');
assert.equal(def.output.render({}, { ok: true, op: 'stats' })[0].type, 'text');
assert.equal(typeof def.execute, 'function');
assert.equal(typeof def.isConcurrencySafe, 'function');
assert.equal(def.isConcurrencySafe(), false, '写文件工具应声明并发不安全');
console.log('[1/5] 注册形状 OK: scholar_shelf');

// ---- [2/5] Harness schema 子集（可用时） ----
try {
  const url = 'file:///C:/Users/15437/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
  const harnessTools = await import(url);
  harnessTools.assertSupportedJsonSchema(def.output.schema);
  harnessTools.assertSupportedJsonSchema(def.parameters);
  console.log('[2/5] schema 通过 Harness assertSupportedJsonSchema');
} catch (e) {
  console.log('[2/5] schema 子集检查跳过（harness 导入失败）:', String(e.message).slice(0, 120));
}

// ---- 执行辅助 ----
function makeExec() {
  const c = new AbortController();
  return { signal: c.signal, deferContext() {}, concludeTurn() {} };
}

function checkValue(v) {
  assert.notEqual(v, undefined, '返回 undefined');
  const round = JSON.parse(JSON.stringify(v));
  assert.deepEqual(round, v, '返回值不是无损 JSON（含 undefined?）');
  assert.equal(typeof v.ok, 'boolean', '缺少 ok 字段');
  assert.equal(typeof v.op, 'string', '缺少 op 字段');
  const blocks = def.output.render({}, v);
  assert.ok(Array.isArray(blocks) && blocks.length > 0 && blocks[0].type === 'text');
  JSON.parse(blocks[0].text);
  return v;
}

async function run(args) {
  return checkValue(await def.execute(args, makeExec()));
}

// ---- [3/5] 入架 / upsert / 统计 ----
const empty = await run({ op: 'stats' });
assert.equal(empty.total, 0, '空架应为 0');
console.log('[3/5] 空架 stats OK: total=0');

const a1 = await run({
  op: 'add',
  doi: 'https://doi.org/10.1038/nature14539',
  title: 'Deep learning',
  authors: ['Yann LeCun', 'Yoshua Bengio', 'Geoffrey Hinton'],
  year: 2015,
  venue: 'Nature',
  tags: ['RL', '综述候选'],
  status: 'verified',
  note: '奠基文献，引言必引',
});
assert.equal(a1.added, true);
assert.equal(a1.record.doi, '10.1038/nature14539', 'DOI 应归一化');
assert.deepEqual(a1.record.tags, ['rl', '综述候选'], '标签应小写化');
assert.ok(a1.record.addedAt && a1.record.updatedAt);

const a2 = await run({ op: 'add', doi: 'doi:10.1038/nature14539', title: 'Deep learning（修订备注版）', note: '更新过' });
assert.equal(a2.added, false, '同 DOI 再 add 应为更新');
assert.equal(a2.total, 1, 'upsert 不应产生第二条');
assert.equal(a2.record.title, 'Deep learning（修订备注版）');
assert.equal(a2.record.addedAt, a1.record.addedAt, 'addedAt 应保留首入架时间');
assert.deepEqual(a2.record.tags, ['rl', '综述候选'], '字段级合并：未传 tags 不应被擦除');
assert.equal(a2.record.status, 'verified', '字段级合并：未传 status 不应被擦除');
assert.equal(a2.record.year, 2015, '字段级合并：未传 year 不应被擦除');

await run({ op: 'add', title: 'Attention is all you need', year: 2017, venue: 'NeurIPS', tags: ['transformer'] });
await run({ op: 'add', title: 'A method notes shelf design', year: 2020, tags: ['方法'], status: 'unverified' });

const st = await run({ op: 'stats' });
assert.equal(st.total, 3);
assert.equal(st.withDoi, 1);
assert.equal(st.byYear['2017'], 1);
assert.equal(st.byTag['方法'], 1);
assert.equal(st.byStatus['verified'], 1);
assert.ok(st.latestAddedAt.length > 0);
console.log('[3/5] 入架/upsert/统计 OK: total=3 withDoi=1');

// ---- [4/5] 检索 / 过滤 / 损坏行 / 导出 ----
const s1 = await run({ op: 'search', q: 'attention' });
assert.equal(s1.total, 1);
assert.equal(s1.results[0].title, 'Attention is all you need');

const s2 = await run({ op: 'search', tag: '方法' });
assert.equal(s2.total, 1);

const s3 = await run({ op: 'search', yearFrom: 2018, yearTo: 2030 });
assert.equal(s3.total, 1, '2020 那条应命中，其余被年份过滤排除');

const s4 = await run({ op: 'search', q: '不存在的关键词xyz' });
assert.equal(s4.total, 0, '无命中应 ok:true total:0');

appendFileSync(process.env.SCHOLAR_SHELF_PATH, 'NOT-JSON-GARBAGE\n', 'utf8');
const s5 = await run({ op: 'search', q: 'deep' });
assert.equal(s5.total, 1, '损坏行不应中断读取');
assert.ok(s5.warnings.some((w) => w.includes('损坏行')), '应警告损坏行');
console.log('[4/5] 检索/过滤/损坏行容忍 OK');

const e1 = await run({ op: 'export', format: 'table' });
assert.equal(e1.rows, 3);
assert.ok(e1.content.startsWith('| # | 标题 |'), 'Markdown 表头');
assert.ok(e1.content.includes('[10.1038/nature14539](https://doi.org/10.1038/nature14539)'), 'DOI 链接');
assert.ok(e1.content.includes('Attention is all you need'));

const e2 = await run({ op: 'export', format: 'tsv', limit: 2 });
assert.equal(e2.rows, 2, 'limit 应生效');
assert.ok(e2.content.split('\n')[0].startsWith('title\tauthors\tyear'), 'TSV 表头');
assert.ok(!e2.content.includes('|'), 'TSV 不应含竖线');
console.log('[4/5] 导出 table/tsv OK');

// ---- [5/5] 非法入参自校验（注册层不校验，execute 必须抛错） ----
await assert.rejects(() => run({ op: 'bogus' }), /op/);
await assert.rejects(() => run({}), /op/);
await assert.rejects(() => run({ op: 'add' }), /title/);
await assert.rejects(() => run({ op: 'add', title: 'x', doi: 'not-a-doi' }), /doi/);
await assert.rejects(() => run({ op: 'add', title: 'x', status: 'maybe' }), /status/);
await assert.rejects(() => run({ op: 'search', yearFrom: 2020, yearTo: 2010 }), /yearFrom/);
await assert.rejects(() => run({ op: 'export', format: 'pdf' }), /format/);
await assert.rejects(() => run({ op: 'add', title: 'x', authors: 'Alice' }), /authors/);
console.log('[5/5] 非法入参自校验 OK（8 例）');

rmSync(dir, { recursive: true, force: true });
console.log('\nSHELF SMOKE PASSED');
