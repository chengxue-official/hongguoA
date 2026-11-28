/**
 * 临时诊断接口（只读）：列出最近上传的日志元数据，供团队排查。
 * 路由：GET /api/diag/recent?key=<DIAG_KEY>&days=3&limit=60
 *
 * 多 key：环境变量 DIAG_KEYS（逗号分隔）优先；未配置时用下面的内置表。
 * 每人一把 key，谁泄露单独删掉那一项即可，不影响其他人。
 */

import { getStore } from '@edgeone/pages-blob';

const BLOB_STORE = 'hougtime';
const LOG_PREFIX = 'log_';
const IDX_PREFIX = 'idx_';

/** 内置 team key（环境变量 DIAG_KEYS 存在时以环境变量为准） */
const BUILTIN_KEYS = [
  // 老的公共 key（兼容旧链接，可随时删除）
  'hgdiag_k7Qm2Xv9Rt4Z',
  // —— 团队个人 key：谁泄露就删哪一行，不影响其他人 ——
  'hgdiag_8d74a8a8671a', // chengxue
  'hgdiag_0f83118946b3', // member1
  'hgdiag_a97a500826bb', // member2
  'hgdiag_7f3f14865a28', // member3
];

const MAX_DAYS = 7;
const MAX_LIMIT = 200;
const HEAD_CHARS = 400;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function validKeys(env) {
  const fromEnv = env && env.DIAG_KEYS ? String(env.DIAG_KEYS) : '';
  const list = fromEnv
    ? fromEnv.split(',').map((s) => s.trim()).filter(Boolean)
    : BUILTIN_KEYS;
  return list;
}

/** 东八区 yyyymmdd，offsetDays 为往前推的天数。 */
function dayKey(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 - offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  if (!validKeys(env).includes(key)) {
    return json({ code: 403, msg: 'forbidden' }, 403);
  }
  const days = Math.min(MAX_DAYS, Math.max(1, parseInt(url.searchParams.get('days') || '3', 10) || 3));
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit') || '60', 10) || 60));
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();

  let store;
  try {
    store = getStore(BLOB_STORE);
  } catch (e) {
    return json({ code: 500, msg: 'getStore 失败' }, 500);
  }

  const tokens = [];
  for (let i = 0; i < days; i++) {
    const day = dayKey(i);
    try {
      const list = await store.list({ prefix: IDX_PREFIX + day + '_' });
      for (const blob of list.blobs || []) {
        const token = blob.key.slice((IDX_PREFIX + day + '_').length);
        if (token) tokens.push({ day, token });
      }
    } catch (e) {
      // 单日 list 失败不影响其它天
    }
  }
  tokens.sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? 1 : -1));

  const out = [];
  for (const { day, token } of tokens.slice(0, limit)) {
    try {
      const raw = await store.get(LOG_PREFIX + token, { consistency: 'strong' });
      if (!raw) continue;
      let rec = null;
      try {
        rec = JSON.parse(raw);
      } catch (e) {
        rec = null;
      }
      const content = rec && typeof rec.content === 'string' ? rec.content : '';
      const head = content.slice(0, HEAD_CHARS);
      const item = {
        day,
        token,
        device: rec ? rec.device || '' : '',
        time: rec ? rec.time || '' : '',
        size: rec ? rec.size || content.length : content.length,
        title: rec ? rec.title || '' : '',
      };
      if (q && !(item.device + ' ' + item.time + ' ' + head).toLowerCase().includes(q)) continue;
      item.head = head;
      out.push(item);
    } catch (e) {
      // 单条失败跳过
    }
  }

  return json({ code: 0, days, total: tokens.length, returned: out.length, logs: out });
}
