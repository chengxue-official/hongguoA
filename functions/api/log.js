/**
 * HougTime 日志上传 API（EdgeOne Pages Functions 版，替代被封的 CF Worker）
 * ------------------------------------------------------------------
 * 路由：functions/api/log.js -> POST /api/log
 *
 * 协议与旧 CF Worker 完全一致（客户端无感）：
 *   POST /api/log   上传日志文本 -> 存 KV，返回一次性 token 与「在线查看/下载 .txt」链接
 *
 * EdgeOne KV 与 CF KV 的差异（本文件已按差异改写）：
 * - KV 通过「绑定变量名」全局访问（控制台绑定命名空间时变量名填 LOGS），非 env.LOGS；
 *   代码里做了兼容：优先全局 LOGS，回退 env.LOGS。
 * - key 只允许字母/数字/下划线 -> 前缀用 log_ / rate_（不能用冒号）。
 * - put 无 TTL 参数 -> 「未读 24h 清理」策略取消，记录永久保留（KV 账户 1GB 上限，
 *   单条日志上限 3MB，量级足够）；限流改为「存时间戳 + 计算剩余」实现。
 * - KV 最终一致性（60s 全球同步）-> 限流是软限制，客户端本地还有 15 分钟节流兜底。
 */

const LOG_PREFIX = 'log_';
const RATE_PREFIX = 'rate_';

/** 同一设备的上传间隔：15 分钟 */
const RATE_WINDOW_SECONDS = 15 * 60;

const MAX_BYTES = 3 * 1024 * 1024; // 单次上传上限 3 MB
const TOKEN_RE = /^[a-z0-9]{10}$/;

/** 取 KV 绑定：EdgeOne 注入为全局变量名；兼容 env.LOGS 写法。 */
function kv(env) {
  try {
    if (typeof LOGS !== 'undefined' && LOGS) return LOGS;
  } catch (e) { /* 全局不存在时忽略 */ }
  if (env && env.LOGS) return env.LOGS;
  return null;
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

/** 剩余限流秒数；0 表示可以上传。（KV 无 TTL：存上次上传时间戳，自己算剩余） */
async function rateRemain(store, deviceKey) {
  const raw = await store.get(RATE_PREFIX + deviceKey);
  if (!raw) return 0;
  const last = parseInt(raw, 10) || 0;
  if (!last) return 0;
  const remain = RATE_WINDOW_SECONDS - (nowSeconds() - last);
  return remain > 0 ? remain : 0;
}

/** 记一次上传（写当前时间戳；无 TTL，靠下次上传覆盖，key 数量极小不清理）。 */
async function rateTouch(store, deviceKey) {
  try {
    await store.put(RATE_PREFIX + deviceKey, String(nowSeconds()));
  } catch (e) {
    // 限流写入失败不应让上传失败（软限制）
  }
}

/** 上传：接收 JSON {device, deviceKey?, time, content, title?}，落 KV，返回链接。 */
async function handleUpload(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ code: 400, msg: '请求体不是合法 JSON' }, 400);
  }

  const store = kv(env);
  if (!store) {
    return json({ code: 500, msg: 'KV 未绑定（控制台绑定命名空间，变量名 LOGS）' }, 500);
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
  // 注意：EdgeOne KV key 只允许字母/数字/下划线，deviceKey 本身是 UUID 去 -
  // （符合约束）；老版本回退的机型名先清洗成合法字符。
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
    await store.put(LOG_PREFIX + token, JSON.stringify(record));
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

export async function onRequestPost({ request, env }) {
  return handleUpload(request, env);
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
