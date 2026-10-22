/**
 * HougTime 日志上传 API（EdgeOne Pages Functions 版，替代被封的 CF Worker）
 * ------------------------------------------------------------------
 * 路由：edge-functions/api/log.js -> POST /api/log
 *
 * 协议与旧 CF Worker 完全一致（客户端无感）：
 *   POST /api/log   上传日志文本 -> 存 Blob，返回一次性 token 与「在线查看/下载 .txt」链接
 *
 * EdgeOne 存储选型（本文件用 Blob，不用 KV）：
 * - KV 需要「控制台申请开通 → 人工审核 → 创建命名空间 → 绑定项目」，审核周期长
 *   （社区有人申请 20+ 天仍在审批中），且免费版只有 Edge Functions 可用；
 * - Blob 是 `getStore(name)` 即用即得：首次调用平台自动创建命名空间，**无需开通、
 *   无需审核、无需绑定**，因此本服务改用 Blob 存日志。
 * - 单值上限 25 MB（远大于这里 900 KB 的上传上限）；账户免费额度 1 GB。
 * - 默认「最终一致」（写入后短暂时间才在所有节点读到），限流与查看页这类
 *   「刚写完就要读」的场景显式传 `{ consistency: 'strong' }` 走强一致读。
 * - key 无字符集限制（KV 只允许字母/数字/下划线），这里仍沿用 log_ / rate_ 前缀。
 * - 请求 body 上限 1 MB（平台硬限制）-> 单次上传上限设 900 KB，客户端同步截断。
 */

import { getStore } from '@edgeone/pages-blob';

const LOG_PREFIX = 'log_';
const RATE_PREFIX = 'rate_';

/** Blob 命名空间名；首次调用 getStore 时平台自动创建。 */
const BLOB_STORE = 'hougtime';

/** 同一设备的上传间隔：15 分钟 */
const RATE_WINDOW_SECONDS = 15 * 60;

const MAX_BYTES = 900 * 1024; // 单次上传上限 900 KB（EdgeOne 请求 body 上限 1 MB）
const TOKEN_RE = /^[a-z0-9]{10}$/;

/** 取 Blob 命名空间实例；getStore 不需要预先开通，失败仅可能是平台异常。 */
function blobStore() {
  try {
    return getStore(BLOB_STORE);
  } catch (e) {
    return null;
  }
}

/** 生成短 token（10 位 base36，约 51.7 bit 熵，不可枚举）。 */
function newToken() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += ALPHABET[bytes[i % bytes.length] % ALPHABET.length];
  }
  return out;
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

function byteLen(s) {
  return new TextEncoder().encode(s).length;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** 剩余限流秒数；0 表示可以上传。（Blob 无 TTL：存上次上传时间戳，自己算剩余） */
async function rateRemain(store, deviceKey) {
  // 强一致读：避免「刚写完立刻又请求」读到旧时间戳导致限流被绕过。
  const raw = await store.get(RATE_PREFIX + deviceKey, { consistency: 'strong' });
  if (!raw) return 0;
  const last = parseInt(raw, 10) || 0;
  if (!last) return 0;
  const remain = RATE_WINDOW_SECONDS - (nowSeconds() - last);
  return remain > 0 ? remain : 0;
}

/** 记一次上传（写当前时间戳；无 TTL，靠下次上传覆盖，key 数量极小不清理）。 */
async function rateTouch(store, deviceKey) {
  try {
    await store.set(RATE_PREFIX + deviceKey, String(nowSeconds()));
  } catch (e) {
    // 限流写入失败不应让上传失败（软限制）
  }
}

/** 上传：接收 JSON {device, deviceKey?, time, content, title?}，落 Blob，返回链接。 */
async function handleUpload(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ code: 400, msg: '请求体不是合法 JSON' }, 400);
  }

  const store = blobStore();
  if (!store) {
    return json({ code: 500, msg: 'Blob 存储不可用：' + 'getStore 初始化失败' }, 500);
  }

  const content = typeof body.content === 'string' ? body.content : '';
  if (!content) {
    return json({ code: 400, msg: 'content 不能为空' }, 400);
  }
  const size = byteLen(content);
  if (size > MAX_BYTES) {
    return json({ code: 413, msg: `日志过大（${size} 字节，上限 ${MAX_BYTES}）` }, 413);
  }

  // 限流维度：优先 deviceKey（设备唯一安装 ID），老版本回退机型名。
  // Blob 的 key 本身无字符集限制，这里仍清洗成 [a-zA-Z0-9_] 是为了与旧 CF Worker
  // 及 KV 时代的 key 形态一致，便于按前缀 list / 排查。
  const rawKey = String(body.deviceKey || body.device || '').trim().slice(0, 64);
  const deviceKey = rawKey.replace(/[^a-zA-Z0-9_]/g, '_');
  if (deviceKey) {
    const remain = await rateRemain(store, deviceKey);
    if (remain > 0) {
      const mins = Math.ceil(remain / 60);
      return json({
        code: 429,
        msg: `上传过于频繁，请约 ${mins} 分钟后再试`,
        retryAfter: remain,
      }, 429);
    }
  }

  const token = newToken();
  const record = {
    content,
    device: String(body.device || '').slice(0, 120),
    deviceKey,
    time: String(body.time || '').slice(0, 60),
    title: String(body.title || '').slice(0, 200),
    size,
    uploadedAt: new Date().toISOString(),
  };

  try {
    await store.set(LOG_PREFIX + token, JSON.stringify(record));
  } catch (e) {
    return json({ code: 500, msg: '存储失败：' + (e && e.message ? e.message : e) }, 500);
  }

  if (deviceKey) await rateTouch(store, deviceKey);

  const origin = new URL(request.url).origin;
  return json({
    code: 0,
    token,
    size,
    view: `${origin}/log/${token}`,
    download: `${origin}/log/${token}.txt`,
  });
}

export async function onRequestPost({ request }) {
  return handleUpload(request);
}

// 预检（原生 App 不触发，留给可能的网页端调用）
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
