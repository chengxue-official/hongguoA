/**
 * HougTime 日志过期清理（EdgeOne Pages Functions 定时任务）
 * ------------------------------------------------------------------
 * 路由：edge-functions/api/cron/cleanup.js -> POST /api/cron/cleanup
 * 触发：edgeone.json 的 schedules 配置，每天 04:30（Asia/Shanghai）自动调一次。
 *
 * 为什么需要：Blob 没有 TTL，日志会无限堆积（免费额度 1 GB），
 * 必须自己按时间回收。保留 30 天足够排查线上问题。
 *
 * 怎么判断「过期」：Blob 的 list 只返回 key/etag，**没有写入时间**，
 * 所以上传时额外写了 `idx_<yyyymmdd>_<token>` 日期索引——清理只看 key 名即可，
 * 不用把日志正文读出来（读 900 KB 的日志来判断要不要删，太浪费）。
 *
 * 兜底：早期（无索引时代）留下的 `log_<token>` 孤儿记录，按记录里的 uploadedAt
 * 判断，单次最多处理 MAX_ORPHANS 条，避免极端情况下函数超时。
 *
 * 幂等 + 防刷：入口是公开路径，任何人都能 POST。用 cleanup_last 时间戳限频
 * （6 小时内重复调用直接跳过），且操作本身只会删「已过期的数据」，被误调无副作用。
 */

import { getStore } from '@edgeone/pages-blob';

const BLOB_STORE = 'hougtime';

const LOG_PREFIX = 'log_';
const RATE_PREFIX = 'rate_';
const IDX_PREFIX = 'idx_';
const LAST_KEY = 'cleanup_last';

/** 日志保留天数 */
const RETAIN_DAYS = 30;
/** 限频窗口：6 小时内只允许真正跑一次 */
const MIN_INTERVAL_SECONDS = 6 * 3600;
/** 单次最多处理的「无索引孤儿」条数（正常应为 0，只为兼容历史数据） */
const MAX_ORPHANS = 200;

function blobStore() {
  try {
    return getStore(BLOB_STORE);
  } catch (e) {
    return null;
  }
}

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

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** 东八区的 yyyymmdd（与 api/log.js 写索引的口径必须一致）。 */
function dayKey(seconds) {
  const d = new Date(seconds * 1000 + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** 限频：读上次运行时间，太近就跳过；否则立刻占位。 */
async function shouldRun(store) {
  let last = 0;
  try {
    last = parseInt(await store.get(LAST_KEY, { consistency: 'strong' }), 10) || 0;
  } catch (e) {
    last = 0;
  }
  if (last && nowSeconds() - last < MIN_INTERVAL_SECONDS) {
    return false;
  }
  try {
    await store.set(LAST_KEY, String(nowSeconds()));
  } catch (e) {
    // 占位失败也继续跑（宁可多清一次，不要漏清）
  }
  return true;
}

/**
 * 主清理：删除 RETAIN_DAYS 天前的 idx_ 及其对应 log_，顺带清长期不活跃设备的 rate_。
 */
async function purge(store) {
  const cutoff = nowSeconds() - RETAIN_DAYS * 86400;
  const cutoffDay = dayKey(cutoff); // yyyymmdd，字符串按字典序即时间序

  const stats = { scannedIdx: 0, deletedLog: 0, deletedIdx: 0, deletedRate: 0, orphansChecked: 0, errors: 0 };
  const indexedTokens = new Set();

  let list;
  try {
    list = await store.list({ prefix: IDX_PREFIX });
  } catch (e) {
    return { ...stats, error: 'list 失败：' + (e && e.message ? e.message : e) };
  }

  for (const blob of list.blobs || []) {
    // 形如 idx_20261022_abcd1234ef
    const rest = blob.key.slice(IDX_PREFIX.length);
    const day = rest.slice(0, 8);
    const token = rest.slice(9);
    if (!token || !/^\d{8}$/.test(day)) {
      continue; // key 形态异常，保守跳过
    }
    stats.scannedIdx++;
    if (day >= cutoffDay) {
      indexedTokens.add(token); // 还在保留期内
      continue;
    }
    try {
      await store.delete(LOG_PREFIX + token);
      stats.deletedLog++;
    } catch (e) {
      stats.errors++;
    }
    try {
      await store.delete(blob.key);
      stats.deletedIdx++;
    } catch (e) {
      stats.errors++;
    }
  }

  // 无索引的孤儿日志（早期数据）：按记录内 uploadedAt 判断
  try {
    const logList = await store.list({ prefix: LOG_PREFIX });
    for (const blob of logList.blobs || []) {
      const token = blob.key.slice(LOG_PREFIX.length);
      if (!token || indexedTokens.has(token)) continue;
      if (stats.orphansChecked >= MAX_ORPHANS) break;
      stats.orphansChecked++;
      try {
        const raw = await store.get(blob.key);
        if (!raw) continue;
        let rec = null;
        try {
          rec = JSON.parse(raw);
        } catch (e) {
          rec = null;
        }
        const uploadedAt = rec && rec.uploadedAt ? Date.parse(rec.uploadedAt) / 1000 : 0;
        // 解析不出时间的不删（宁可留着人工看，也不要误删用户的日志）
        if (uploadedAt && uploadedAt < cutoff) {
          await store.delete(blob.key);
          stats.deletedLog++;
        }
      } catch (e) {
        stats.errors++;
      }
    }
  } catch (e) {
    stats.errors++;
  }

  // 限流记录：超过保留期没再上传过的设备，key 可以直接回收（数量与设备数同阶）
  try {
    const rateList = await store.list({ prefix: RATE_PREFIX });
    for (const blob of rateList.blobs || []) {
      try {
        const ts = parseInt(await store.get(blob.key), 10) || 0;
        if (ts && ts < cutoff) {
          await store.delete(blob.key);
          stats.deletedRate++;
        }
      } catch (e) {
        stats.errors++;
      }
    }
  } catch (e) {
    stats.errors++;
  }

  return { ...stats, cutoffDay, retainDays: RETAIN_DAYS };
}

export async function onRequestPost() {
  const store = blobStore();
  if (!store) {
    return json({ code: 500, msg: 'Blob getStore 初始化失败' }, 500);
  }
  if (!(await shouldRun(store))) {
    return json({ code: 0, skipped: true, msg: '距上次清理不足 6 小时，已跳过' });
  }
  const result = await purge(store);
  return json({ code: 0, ranAt: new Date().toISOString(), result });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
