// content/detect.js — 运行在 MAIN world
// 1. 覆盖 confirm/alert，通过 DOM 属性与 ISOLATED world 通信
// 2. 拦截 fetch/XHR 响应，捕获学习通题目 API 数据

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

// ─── 2. URL 过滤 ───

const QUESTION_URL_PATTERNS = [
  'test/student/questions',
  'test/reVersionStudyStatus',
  'test/readPaper',
  'test/checkSecurity',
  'mooc2-ans',
  'knowledge/cards',
  'exam/',
  'paper/',
  'question/',
  'quiz/',
  'answer/',
  'ans/',
  'getQuestion',
  'getTest',
  'loadQuestion',
  'getPaper',
  'taskPoint',
  'studyLog',
  'course/api',
  'api/test',
  'api/exam',
];

function matchesQuestionUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return QUESTION_URL_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

// ─── 3. 内容嗅探 ───

const QUESTION_KEYS = [
  'type', 'Type', 'qType', 'q_type', 'questionType', 'question_type',
  'stem', 'title', 'Title', 'content', 'Content',
  'options', 'Options', 'choices', 'answerList', 'optionList',
  'index', 'Index', 'num', 'questionNo', 'id',
  'name', 'description',
];

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

  // 兜底: 遍历所有键找对象数组
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
      return val;
    }
  }

  return null;
}

// ─── 4. DOM 桥写入 ───

let _apiDataSeq = 0;

function writeApiDataToDom(data) {
  if (!data || typeof data !== 'object') return;

  if (!document.body) {
    // body 尚未就绪，排队等待
    if (!window.__cx_pending_data) window.__cx_pending_data = [];
    window.__cx_pending_data.push(data);
    if (!window.__cx_dom_hooked) {
      window.__cx_dom_hooked = true;
      document.addEventListener('DOMContentLoaded', () => {
        (window.__cx_pending_data || []).forEach(writeApiDataToDom);
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
  };
  el.textContent = JSON.stringify(store);
}

// ─── 5. fetch 拦截 ───

const _fetch = window.fetch;

window.fetch = function(url, init) {
  const urlStr = typeof url === 'string' ? url : (url ? (url.url || url.toString()) : '');

  if (!matchesQuestionUrl(urlStr)) {
    return _fetch.call(this, url, init);
  }

  return _fetch.call(this, url, init).then(async (response) => {
    if (!response || !response.clone) return response;
    try {
      const clone = response.clone();
      const text = await clone.text();
      const data = JSON.parse(text);
      if (looksLikeQuestions(data)) {
        writeApiDataToDom(data);
      }
    } catch (_) { /* 非 JSON 或非题目数据, 忽略 */ }
    return response;
  }).catch(err => {
    // 网络错误等, 不拦截
    throw err;
  });
};

// ─── 6. XMLHttpRequest 拦截 ───

const XHR = XMLHttpRequest;
const _open = XHR.prototype.open;
const _send = XHR.prototype.send;

XHR.prototype.open = function(method, url) {
  this.__cx_url = (typeof url === 'string') ? url : '';
  // 调用原始 open (支持可变参数)
  return _open.apply(this, arguments);
};

XHR.prototype.send = function() {
  const url = this.__cx_url || '';

  if (matchesQuestionUrl(url)) {
    this.addEventListener('readystatechange', function() {
      if (this.readyState === 4 && this.status === 200) {
        try {
          const data = JSON.parse(this.responseText);
          if (looksLikeQuestions(data)) {
            writeApiDataToDom(data);
          }
        } catch (_) { /* 忽略 */ }
      }
    });
  }

  return _send.apply(this, arguments);
};
