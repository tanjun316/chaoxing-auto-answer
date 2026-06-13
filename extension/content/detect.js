// content/detect.js — 运行在 MAIN world
// 1. 覆盖 confirm/alert，通过 DOM 属性与 ISOLATED world 通信
// 2. 拦截所有 fetch/XHR JSON 响应，自动发现题目数据

// ─── 1. confirm / alert 覆盖 ───

window._originalConfirm = window.confirm;
window._originalAlert = window.alert;

window.confirm = function(msg) {
  document.body.setAttribute('data-cx-confirm', String(msg || ''));
  return true;
};

window.alert = function(msg) {
  document.body.setAttribute('data-cx-alert', String(msg || ''));
};

// ─── 2. 内容嗅探（唯一过滤条件） ───

const QUESTION_KEYS = [
  'type', 'Type', 'qType', 'q_type', 'questionType', 'question_type',
  'stem', 'title', 'Title', 'content', 'Content',
  'options', 'Options', 'choices', 'answerList', 'optionList',
  'index', 'Index', 'num', 'questionNo', 'id',
  'name', 'description',
];

const MAX_RESPONSE_SIZE = 512 * 1024; // 跳过超过 512KB 的响应

function looksLikeQuestions(data) {
  const list = findAnyArray(data);
  if (!list || list.length === 0) return false;

  const item = list[0];
  if (typeof item !== 'object' || item === null) return false;

  const found = QUESTION_KEYS.filter(k => k in item);
  return found.length >= 2;
}

function findAnyArray(obj) {
  if (Array.isArray(obj)) return obj;

  const candidateKeys = [
    'data', 'questions', 'list', 'rows', 'result', 'records',
    'items', 'questionList', 'question_list', 'testQuestions',
    'paperQuestions', 'results',
  ];

  for (const key of candidateKeys) {
    if (obj[key] && Array.isArray(obj[key])) return obj[key];
  }

  // 深层: obj.data.questions
  if (obj.data && typeof obj.data === 'object') {
    for (const key of candidateKeys) {
      if (obj.data[key] && Array.isArray(obj.data[key])) return obj.data[key];
    }
  }

  // 兜底: 遍历所有根键找对象数组
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
      return val;
    }
  }

  return null;
}

// ─── 3. DOM 桥写入 ───

let _apiDataSeq = 0;

function writeApiDataToDom(data, url) {
  if (!data || typeof data !== 'object') return;

  if (!document.body) {
    if (!window.__cx_pending_data) window.__cx_pending_data = [];
    window.__cx_pending_data.push({ data, url });
    if (!window.__cx_dom_hooked) {
      window.__cx_dom_hooked = true;
      document.addEventListener('DOMContentLoaded', () => {
        (window.__cx_pending_data || []).forEach(d => writeApiDataToDom(d.data, d.url));
        window.__cx_pending_data = [];
      });
    }
    return;
  }

  let el = document.getElementById('__cx_api_data');
  if (!el) {
    el = document.createElement('script');
    el.id = '__cx_api_data';
    el.type = 'text/cx-data';
    el.style.display = 'none';
    document.body.appendChild(el);
  }

  _apiDataSeq++;
  const store = {
    seq: _apiDataSeq,
    data: data,
    ts: Date.now(),
    url: url || '',
  };
  el.textContent = JSON.stringify(store);
}

// 记录最近捕获的 URL（调试用，可在 Console 查看）
window.__cx_captured_urls = [];

function tryIntercept(text, url) {
  // 快速检查: 必须以 { 或 [ 开头 (JSON)
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
  if (text.length > MAX_RESPONSE_SIZE) return;

  try {
    const data = JSON.parse(text);
    if (looksLikeQuestions(data)) {
      writeApiDataToDom(data, url);
      window.__cx_captured_urls.push({ url, ts: Date.now(), count: findAnyArray(data)?.length || 0 });
    }
  } catch (_) { /* 非 JSON, 忽略 */ }
}

// ─── 4. fetch 拦截（全部响应） ───

const _fetch = window.fetch;

window.fetch = function(url, init) {
  const urlStr = typeof url === 'string' ? url : (url ? (url.url || url.toString()) : '');

  return _fetch.call(this, url, init).then(async (response) => {
    if (!response || !response.clone) return response;
    try {
      const clone = response.clone();
      const text = await clone.text();
      tryIntercept(text, urlStr);
    } catch (_) { /* clone 失败, 忽略 */ }
    return response;
  }).catch(err => {
    throw err;
  });
};

// ─── 5. XMLHttpRequest 拦截（全部响应） ───

const XHR = XMLHttpRequest;
const _open = XHR.prototype.open;
const _send = XHR.prototype.send;

XHR.prototype.open = function(method, url) {
  this.__cx_url = (typeof url === 'string') ? url : '';
  return _open.apply(this, arguments);
};

XHR.prototype.send = function() {
  const url = this.__cx_url || '';

  this.addEventListener('readystatechange', function() {
    if (this.readyState === 4 && this.status === 200) {
      tryIntercept(this.responseText, url);
    }
  });

  return _send.apply(this, arguments);
};

// ─── 6. 调试：定期输出捕获统计 ───

console.log('[学习通助手] MAIN world 已注入 — 自动拦截所有 fetch/XHR JSON 响应');
