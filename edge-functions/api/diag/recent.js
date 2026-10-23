/**
 * 临时诊断接口（只读）：列出最近上传的日志元数据，便于排查线上问题。
 * 路由：GET /api/diag/recent?key=<DIAG_KEY>&days=3&limit=60
 *
 * 只返回元数据 + 正文前 400 字符，不返回全文（全文走已有的 /log/<token>.txt）。
 * 用 key 参数做保护，排查完可直接删掉本文件。
 */

import { getStore } from '@edgeone/pages-blob';

const BLOB_STORE = 'hougtime';
const LOG_PREFIX = 'log_';
const IDX_PREFIX = 'idx_';

/** 诊断密钥（仅用于本次排查，删除本文件即失效） */
const DIAG_KEY = 'hgdiag_k7Qm2Xv9Rt4Z';

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

/** 东八区 yyyymmdd，offsetDays 为往前推的天数。 */
function dayKey(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 - offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  if (url.searchParams.get('key') !== DIAG_KEY) {
    return json({ code: 403, msg: 'forbidden' }, 403);
  }
  const days = Math.min(MAX_DAYS, Math.max(1, parseInt(url.searchParams.get('days') || '3', 10) || 3));
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit') || '60', 10) || 60));

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
      const raw = await store.get(LOG_PREFIX + token);
      if (!raw) continue;
      let rec = null;
      try {
        rec = JSON.parse(raw);
      } catch (e) {
        rec = null;
      }
      const content = rec && typeof rec.content === 'string' ? rec.content : '';
      out.push({
        day,
        token,
        device: rec ? rec.device : '',
        deviceKey: rec ? rec.deviceKey : '',
        time: rec ? rec.time : '',
        title: rec ? rec.title : '',
        size: rec ? rec.size : 0,
        uploadedAt: rec ? rec.uploadedAt : '',
        head: content.slice(0, HEAD_CHARS),
      });
    } catch (e) {
      // 单条读取失败跳过
    }
  }

  return json({ code: 0, days, total: tokens.length, returned: out.length, logs: out });
}
