/**
 * HougTime 日志查看/下载（EdgeOne Pages Functions 版）
 * ------------------------------------------------------------------
 * 路由：functions/log/[token].js
 *   GET /log/<token>      在线查看页（手机直接看，带一键复制/下载按钮）
 *   GET /log/<token>.txt  纯文本下载（Content-Disposition: attachment）
 *
 * KV 访问方式与限流口径同 functions/api/log.js（全局绑定变量 LOGS，
 * key 前缀 log_，无 TTL 永久保留）。params.token 形如 "ab12cd34ef" 或 "ab12cd34ef.txt"。
 */

const LOG_PREFIX = 'log_';
const TOKEN_RE = /^[a-z0-9]{10}$/;

/** 取 KV 绑定：EdgeOne 注入为全局变量名；兼容 env.LOGS 写法。 */
function kv(env) {
  try {
    if (typeof LOGS !== 'undefined' && LOGS) return LOGS;
  } catch (e) { /* 全局不存在时忽略 */ }
  if (env && env.LOGS) return env.LOGS;
  return null;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function byteLen(s) {
  return new TextEncoder().encode(s).length;
}

/** 读取 KV 记录；不存在返回 null。 */
async function readRecord(store, token) {
  const raw = await store.get(LOG_PREFIX + token);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { content: raw, device: '', time: '', title: '', size: byteLen(raw) };
  }
}

/** 纯文本下载：attachment 触发「保存文件」，文件名带设备与时间便于区分。 */
async function handleDownload(store, token) {
  const rec = await readRecord(store, token);
  if (!rec) {
    return new Response('日志不存在或已被清理', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const dev = (rec.device || 'device').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 40);
  const stamp = (rec.time || rec.uploadedAt || '').replace(/[^\d]/g, '').slice(0, 14);
  const filename = `hougtime-log-${dev}-${stamp || 'now'}.txt`;
  return new Response(rec.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition':
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    },
  });
}

/** 在线查看页：手机上直接看，一键复制 / 一键下载。 */
async function handleView(store, token) {
  const rec = await readRecord(store, token);
  if (!rec) {
    return new Response(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
       <meta name="viewport" content="width=device-width,initial-scale=1">
       <title>日志不存在</title>
       <body style="font-family:system-ui,-apple-system,'PingFang SC',sans-serif;
                    padding:40px 20px;text-align:center;color:#111;background:#f6f7f9">
       <h2 style="margin:0 0 12px">日志不存在或已被清理</h2>
       <p style="color:#666;font-size:14px;line-height:1.7">
         请让电视端重新点一次「上传日志」。</p>
       </body></html>`,
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const sizeKb = (rec.size / 1024).toFixed(1);
  const metaLine = [
    rec.device ? `设备 ${esc(rec.device)}` : '',
    rec.time ? `时间 ${esc(rec.time)}` : '',
    `${sizeKb} KB`,
  ].filter(Boolean).join(' · ');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>HougTime 日志 · 在线查看</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#f6f7f9;color:#111;
       font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
       -webkit-text-size-adjust:100%}
  header{position:sticky;top:0;z-index:2;background:#fff;border-bottom:1px solid #e6e8eb;
         padding:14px 16px}
  h1{margin:0 0 4px;font-size:17px;font-weight:600}
  .meta{color:#6b7280;font-size:12.5px;line-height:1.5}
  .actions{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
  .btn{flex:1 1 0;min-width:130px;display:flex;align-items:center;justify-content:center;
       height:40px;border-radius:9px;border:1px solid #d7dbe0;background:#fff;color:#111;
       font-size:14px;font-weight:500;text-decoration:none;cursor:pointer;
       -webkit-tap-highlight-color:transparent}
  .btn.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
  .btn:active{opacity:.82}
  main{padding:12px 16px 40px}
  pre{margin:0;background:#fff;border:1px solid #e6e8eb;border-radius:10px;padding:14px;
      font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;
      line-height:1.6;white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;
      max-height:none;color:#1f2328}
  .hint{color:#6b7280;font-size:12.5px;line-height:1.7;margin:0 0 10px}
  #toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:rgba(17,17,17,.9);
         color:#fff;font-size:13px;padding:9px 16px;border-radius:20px;opacity:0;
         transition:opacity .2s;pointer-events:none;z-index:9;white-space:nowrap}
  #toast.on{opacity:1}
</style>
</head>
<body>
<header>
  <h1>HougTime 日志</h1>
  <div class="meta">${metaLine}</div>
  <div class="actions">
    <button class="btn primary" id="copy">一键复制全文</button>
    <a class="btn" id="dl" href="/log/${esc(token)}.txt" download>下载 .txt 文件</a>
  </div>
</header>
<main>
  <p class="hint">在电脑上打开本页可「下载」为文件；手机上点「一键复制全文」即可整段粘贴给开发者，无需手动滚动选择。</p>
  <pre id="body">加载中…</pre>
</main>
<div id="toast"></div>
<script>
(function(){
  var token = ${JSON.stringify(token)};
  var bodyEl = document.getElementById('body');
  var toastEl = document.getElementById('toast');
  var t = null;
  function toast(msg){
    toastEl.textContent = msg; toastEl.classList.add('on');
    clearTimeout(t); t = setTimeout(function(){ toastEl.classList.remove('on'); }, 1800);
  }
  fetch('/log/' + token + '.txt', { cache: 'no-store' })
    .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(function(text){ bodyEl.textContent = text; })
    .catch(function(e){ bodyEl.textContent = '日志加载失败：' + e.message + '\\n可直接点上方「下载 .txt 文件」。'; });

  document.getElementById('copy').addEventListener('click', function(){
    var text = bodyEl.textContent || '';
    function fallback(){
      try{
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position='fixed'; ta.style.top='-1000px';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        toast(ok ? '已复制全文' : '复制失败，请点「下载 .txt 文件」');
      }catch(err){ toast('复制失败，请点「下载 .txt 文件」'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){ toast('已复制全文'); }, fallback);
    } else { fallback(); }
  });
})();
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ params, env }) {
  const raw = String(params.token || '');
  const dot = raw.lastIndexOf('.');
  const token = (dot > 0 ? raw.slice(0, dot) : raw).toLowerCase();
  if (!TOKEN_RE.test(token)) {
    return new Response('链接格式不正确', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const store = kv(env);
  if (!store) {
    return new Response('KV 未绑定（控制台绑定命名空间，变量名 LOGS）', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const wantTxt = dot > 0 && raw.slice(dot).toLowerCase() === '.txt';
  return wantTxt ? handleDownload(store, token) : handleView(store, token);
}
