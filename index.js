/**
 * Scholar Shelf — 本地文献架（DeepSeek Harness Host 插件）
 *
 * 与 @local/scholar-kit 的分工：kit 是无状态的联网核验核（search/verify/citations/access），
 * shelf 是有状态的记忆层——把核验结论存下来、离线查回来、导出成可贴进笔记的引用表。
 *
 * 工具：scholar_shelf   操作 add / search / stats / export
 *
 * 约定：
 *   - 纯 ESM、零第三方依赖（仅 node:fs / node:path），完全离线，不做任何网络调用。
 *   - 存储为 JSONL（每行一条 JSON 记录），默认路径 vault 内 `文献架/shelf.jsonl`，
 *     可用环境变量 SCHOLAR_SHELF_PATH 覆盖（测试隔离用）。
 *   - 按 DOI（归一化后）或标题键 upsert：同键再次 add = 更新（added:false）。
 *   - 损坏行跳过并计入 warnings；写入采用 临时文件+rename 原子替换。
 *   - 注册层不校验原始入参 → execute 内防御性校验，
 *     非法入参抛含“什么错了/期望什么/怎么改”的 Error。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/* ---------------- 可调配置 ---------------- */
/** 书架文件默认位置（可用环境变量 SCHOLAR_SHELF_PATH 覆盖；测试必须用覆盖） */
const DEFAULT_SHELF_PATH = 'C:/Users/15437/Desktop/工作/文献架/shelf.jsonl';
const SHELF_PATH = process.env.SCHOLAR_SHELF_PATH || DEFAULT_SHELF_PATH;
const MAX_SEARCH = 50;
const EXPORT_DEFAULT = 100;
const EXPORT_MAX = 500;
const SHELF_MAX_RECORDS = 50000;
const STATUSES = ['verified', 'retracted', 'not_found', 'probable_match', 'possible_match', 'invalid', 'unverified'];

/* ---------------- 错误与小工具 ---------------- */

function bad(message, expected, fix) {
  throw new Error(`什么错了: ${message}。期望什么: ${expected}。怎么改: ${fix}`);
}

function normDoi(v) {
  return String(v).trim().toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '');
}

function strList(v, field) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    bad(`${field} 不是字符串数组`, `字符串数组，如 ${field}: ["Alice", "Bob"]`, `修正 ${field} 或省略该字段`);
  }
  return v.map((s) => s.trim()).filter(Boolean);
}

function intOrNull(v, field) {
  if (v == null) return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) bad(`${field} 不是整数`, `整数，如 ${field}: 2017`, `修正 ${field} 或省略该字段`);
  return n;
}

/* ---------------- 存储 ---------------- */

function loadShelf() {
  if (!existsSync(SHELF_PATH)) return { records: [], corrupt: 0 };
  const text = readFileSync(SHELF_PATH, 'utf8');
  const records = [];
  let corrupt = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && typeof o.title === 'string' && o.title) records.push(o);
      else corrupt++;
    } catch {
      corrupt++;
    }
  }
  return { records, corrupt };
}

function saveShelf(records) {
  const dir = dirname(SHELF_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = SHELF_PATH + '.tmp';
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(tmp, body ? body + '\n' : '', 'utf8');
  renameSync(tmp, SHELF_PATH); // 原子替换（Windows 下 MoveFileEx 覆盖）
}

/* ---------------- 各操作 ---------------- */

function opAdd(a, records) {
  const title = typeof a.title === 'string' ? a.title.trim() : '';
  if (!title) bad('add 缺 title', 'title 为非空字符串（文献标题，必填）', '传 title: "..."（DOI/作者/年份可选）');
  const keyDoi = typeof a.doi === 'string' && a.doi.trim() ? normDoi(a.doi) : null;
  if (keyDoi && !/^10\.\d{4,9}\/\S+$/.test(keyDoi)) {
    bad(`doi=${a.doi} 格式不像 DOI`, '形如 10.1038/nature14539（允许带 https://doi.org/ 或 doi: 前缀）', '修正 doi，或省略该字段只按标题入架');
  }
  const yearIn = a.year != null ? intOrNull(a.year, 'year') : null;
  const statusProvided = a.status != null && a.status !== '';
  if (statusProvided && !STATUSES.includes(String(a.status))) {
    bad(`status=${a.status} 非法`, `status ∈ ${STATUSES.join(' | ')}（或省略）`, '使用 scholar_verify 返回的 status 值');
  }
  const strOr = (v, field) => {
    if (v == null) return undefined;
    if (typeof v !== 'string') bad(`${field} 不是字符串`, `字符串，如 ${field}: "..."`, `修正 ${field} 或省略该字段`);
    return v.trim();
  };
  const normTitle = (s) => String(s).trim().toLowerCase();
  // upsert 键：传 DOI 按 DOI 匹配，并兼容"同名且尚无 DOI"的记录（补 DOI 视为合并）；否则按标题
  const idx = records.findIndex((r) => (keyDoi
    ? Boolean(r.doi) && normDoi(r.doi) === keyDoi || !r.doi && normTitle(r.title) === normTitle(title)
    : normTitle(r.title) === normTitle(title)));
  const prev = idx >= 0 ? records[idx] : null;
  const now = new Date().toISOString();
  // 字段级合并：只覆盖本次传入的字段，未传字段保留（避免部分更新静默擦除元数据）
  const rec = {
    title,
    doi: keyDoi ?? (prev && prev.doi) ?? '',
    year: yearIn ?? (prev ? prev.year : null),
    authors: a.authors != null ? strList(a.authors, 'authors') : (prev && prev.authors) || [],
    venue: strOr(a.venue, 'venue') ?? (prev && prev.venue) ?? '',
    note: strOr(a.note, 'note') ?? (prev && prev.note) ?? '',
    tags: a.tags != null ? strList(a.tags, 'tags').map((t) => t.toLowerCase()) : (prev && prev.tags) || [],
    status: statusProvided ? String(a.status) : (prev && prev.status) || '',
    addedAt: (prev && prev.addedAt) || now,
    updatedAt: now,
  };
  let added = false;
  if (prev) {
    records[idx] = rec;
  } else {
    if (records.length >= SHELF_MAX_RECORDS) {
      bad(`架容量 ${records.length} 已达上限`, `≤${SHELF_MAX_RECORDS} 条`, '先归档并清理 shelf.jsonl');
    }
    records.push(rec);
    added = true;
  }
  saveShelf(records);
  return { ok: true, op: 'add', added, total: records.length, record: rec, warnings: [] };
}

function opSearch(a, records) {
  const q = typeof a.q === 'string' ? a.q.trim().toLowerCase() : '';
  const tag = typeof a.tag === 'string' ? a.tag.trim().toLowerCase() : '';
  const yearFrom = intOrNull(a.yearFrom, 'yearFrom');
  const yearTo = intOrNull(a.yearTo, 'yearTo');
  if (yearFrom != null && yearTo != null && yearFrom > yearTo) {
    bad(`yearFrom(${yearFrom}) > yearTo(${yearTo})`, '起止年份顺序', '交换 yearFrom / yearTo');
  }
  let limit = 10;
  if (a.limit != null) {
    limit = Number.parseInt(a.limit, 10);
    if (!Number.isFinite(limit)) bad('limit 不是整数', `1-${MAX_SEARCH} 的整数`, '传 limit: 10');
  }
  const lim = Math.min(MAX_SEARCH, Math.max(1, limit));
  const hits = records.filter((r) => {
    if (tag && !(r.tags || []).includes(tag)) return false;
    // 设年份过滤时缺年份的记录排除（检索是按年份限定的）
    if (yearFrom != null && (r.year == null || r.year < yearFrom)) return false;
    if (yearTo != null && (r.year == null || r.year > yearTo)) return false;
    if (q) {
      const hay = [r.title, r.doi || '', r.venue || '', r.note || '',
        (r.authors || []).join(' '), (r.tags || []).join(' ')].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  hits.sort((x, y) => ((y.year == null ? -1 : y.year) - (x.year == null ? -1 : x.year))
    || String(y.addedAt || '').localeCompare(String(x.addedAt || '')));
  return { ok: true, op: 'search', total: hits.length, returned: Math.min(lim, hits.length), results: hits.slice(0, lim), warnings: [] };
}

function opStats(records) {
  const byYear = {};
  const byTag = {};
  const byStatus = {};
  let withDoi = 0;
  let latest = '';
  for (const r of records) {
    const y = r.year == null ? 'unknown' : String(r.year);
    byYear[y] = (byYear[y] || 0) + 1;
    if (r.doi) withDoi++;
    for (const t of r.tags || []) byTag[t] = (byTag[t] || 0) + 1;
    const st = r.status || 'unset';
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (String(r.addedAt || '') > latest) latest = r.addedAt;
  }
  return { ok: true, op: 'stats', total: records.length, withDoi, latestAddedAt: latest, byYear, byTag, byStatus, warnings: [] };
}

function opExport(a, records) {
  const format = a.format == null ? 'table' : String(a.format);
  if (!['table', 'tsv'].includes(format)) {
    bad(`format=${a.format} 非法`, "format ∈ 'table' | 'tsv'（或省略默认 table）", '传 format: "table"');
  }
  let limit = EXPORT_DEFAULT;
  if (a.limit != null) {
    limit = Number.parseInt(a.limit, 10);
    if (!Number.isFinite(limit)) bad('limit 不是整数', `1-${EXPORT_MAX} 的整数`, '传 limit: 100');
  }
  const lim = Math.min(EXPORT_MAX, Math.max(1, limit));
  const rows = [...records].sort((x, y) => ((y.year == null ? -1 : y.year) - (x.year == null ? -1 : x.year))).slice(0, lim);
  const escMd = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const escTsv = (s) => String(s ?? '').replace(/[\t\r\n]/g, ' ');
  let content;
  if (format === 'table') {
    const head = '| # | 标题 | 作者 | 年 | 期刊 | DOI | 标签 | 状态 |';
    const sep = '|---|---|---|---|---|---|---|---|';
    const body = rows.map((r, i) => {
      const authors = r.authors || [];
      const a3 = escMd(authors.slice(0, 3).join('; ')) + (authors.length > 3 ? '; 等' : '');
      const doiCell = r.doi ? `[${escMd(r.doi)}](https://doi.org/${encodeURI(r.doi)})` : '';
      return `| ${i + 1} | ${escMd(r.title)} | ${a3} | ${r.year ?? ''} | ${escMd(r.venue)} | ${doiCell} | ${escMd((r.tags || []).join(', '))} | ${r.status || ''} |`;
    });
    content = [head, sep, ...body].join('\n');
  } else {
    const head = ['title', 'authors', 'year', 'venue', 'doi', 'tags', 'status'].join('\t');
    const body = rows.map((r) => [
      escTsv(r.title), escTsv((r.authors || []).join('; ')), r.year ?? '',
      escTsv(r.venue), escTsv(r.doi), escTsv((r.tags || []).join(',')), escTsv(r.status),
    ].join('\t'));
    content = [head, ...body].join('\n');
  }
  return { ok: true, op: 'export', format, rows: rows.length, total: records.length, content, warnings: [] };
}

/* ---------------- 入参 / 出参 schema ---------------- */

const SHELF_PARAMS = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['add', 'search', 'stats', 'export'], description: '操作：add=入架(upsert)、search=离线检索、stats=统计、export=导出引用表' },
    doi: { type: 'string', description: 'DOI（可带 https://doi.org/ 前缀）；add 可选，作 upsert 键' },
    title: { type: 'string', description: '文献标题；add 必填，search 时不传则用 q' },
    authors: { type: 'array', items: { type: 'string' }, description: '作者列表（姓全名均可）' },
    year: { type: 'integer', description: '出版年份' },
    venue: { type: 'string', description: '期刊/会议/书名' },
    note: { type: 'string', description: '个人备注（与本课题的关系、使用位置等）' },
    tags: { type: 'array', items: { type: 'string' }, description: '标签（存为小写）' },
    status: { type: 'string', description: `核验状态（来自 scholar_verify）：${STATUSES.join(' / ')}` },
    q: { type: 'string', description: 'search：关键词（匹配标题/作者/期刊/备注/标签/DOI，不区分大小写）' },
    tag: { type: 'string', description: 'search：按标签精确过滤' },
    yearFrom: { type: 'integer', description: 'search：起始年（含）' },
    yearTo: { type: 'integer', description: 'search：结束年（含）' },
    limit: { type: 'integer', description: `search 返回上限 1-${MAX_SEARCH}（默认 10）；export 上限 1-${EXPORT_MAX}` },
    format: { type: 'string', enum: ['table', 'tsv'], description: 'export：table=Markdown 引用表（默认）、tsv=制表符分隔' },
  },
  required: ['op'],
  additionalProperties: false,
};

const SHELF_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    op: { type: 'string' },
    added: { type: 'boolean' },
    total: { type: 'integer' },
    returned: { type: 'integer' },
    withDoi: { type: 'integer' },
    latestAddedAt: { type: 'string' },
    byYear: { type: 'object' },
    byTag: { type: 'object' },
    byStatus: { type: 'object' },
    record: { type: 'object' },
    results: { type: 'array' },
    format: { type: 'string' },
    rows: { type: 'integer' },
    content: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'op'],
};

const textRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

/* ---------------- 工具定义 ---------------- */

function toolDefinitions() {
  return [
    {
      name: 'scholar_shelf',
      description: '本地文献架（断网也可用）：把已核验的文献——标题/DOI/作者/年份/期刊/备注/标签/核验状态——持久化到本地 JSONL，随时离线检索、统计分布、导出为 Markdown 引用表或 TSV 贴进笔记。与 scholar_search/verify 配合成“先联网核验、再入架沉淀”的工作流；同 DOI 或同标题重复 add 为更新而非重复。数据只写本地文件，绝不上传。',
      parameters: SHELF_PARAMS,
      output: { schema: SHELF_OUTPUT, render: textRender },
      execute: shelfExecute,
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
    },
  ];
}

async function shelfExecute(args, exec) {
  if (exec && exec.signal && exec.signal.aborted) throw new Error('aborted');
  const a = args && typeof args === 'object' ? args : {};
  const op = typeof a.op === 'string' ? a.op : '';
  if (!['add', 'search', 'stats', 'export'].includes(op)) {
    bad(`op=${JSON.stringify(a.op)} 不是合法操作`, "op ∈ 'add' | 'search' | 'stats' | 'export'", '传 op: "stats" 先看架里有什么');
  }
  const { records, corrupt } = loadShelf();
  const warnings = [];
  if (corrupt > 0) warnings.push(`已跳过损坏行 ${corrupt} 条（JSON 解析失败或缺 title）`);
  let out;
  if (op === 'add') out = opAdd(a, records);
  else if (op === 'search') out = opSearch(a, records);
  else if (op === 'stats') out = opStats(records);
  else out = opExport(a, records);
  if (warnings.length) out.warnings = warnings;
  return out;
}

/* ---------------- 插件入口 ---------------- */

export const inject = ['tools'];

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [];
    for (const def of toolDefinitions()) disposers.push(ctx.tools.register(def));
    return () => {
      for (let i = disposers.length - 1; i >= 0; i--) {
        try { disposers[i](); } catch { /* 清理阶段忽略重复释放 */ }
      }
    };
  });
}
