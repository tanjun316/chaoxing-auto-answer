// shared/extractor.js — 学习通页面题目提取
// 优先从 API JSON 提取，DOM 解析作为后备

// ─── 帧分类（基于 DOM） ───

function classifyFrame() {
  const text = document.body.innerText;
  if (/【单选题】|【多选题】|【判断题】|【填空题】|【简答题】/.test(text)) {
    return 'primary';
  }
  const mainid = document.getElementById('mainid');
  if (mainid && mainid.querySelector('iframe')) {
    return 'transit';
  }
  return 'inactive';
}

// ─── 题型映射 (OCS) ───
// 0=单选 1=多选 2=简答 3=判断 4=填空 5=名词解释 6=论述 7=计算 8=其他 9=分录 10=资料 11=连线 14=完形 15=阅读

function mapCXType(val) {
  const v = parseInt(val);
  if (v === 0) return 'single';
  if (v === 1) return 'multi';
  if (v === 3) return 'judge';
  if ([2, 4, 5, 6, 7, 8, 9, 10].includes(v)) return 'fill';
  return 'single';
}

// ─── 题型检测（从 HTML 结构） ───

function detectTypeFromStructure(container) {
  const radios = container.querySelectorAll('input[type="radio"]');
  const checkboxes = container.querySelectorAll('input[type="checkbox"]');
  const textareas = container.querySelectorAll('textarea');
  const textInputs = container.querySelectorAll('input[type="text"], input:not([type])');

  if (radios.length === 2) return 'judge';
  if (radios.length > 2) return 'single';
  if (checkboxes.length >= 2) return 'multi';
  if (textareas.length >= 1 || textInputs.length >= 1) return 'fill';
  return undefined;
}

// ─── DOM 提取（OCS 选择器 + 原逻辑合并） ───

function extractQuestionsFromDom() {
  // 优先 OCS 选择器 — 作业/考试页面
  let roots = document.querySelectorAll('.questionLi');
  if (roots.length === 0) {
    // 章节测试页面
    roots = document.querySelectorAll('.TiMu');
  }
  if (roots.length === 0) {
    // 回退到原 [role="option"] 方式
    return extractQuestionsLegacy();
  }

  const questions = [];

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];

    // 题型检测
    let type;
    const typeInput = root.querySelector('input[name^="type"], input[id^="answertype"]');
    if (typeInput) {
      type = mapCXType(typeInput.value);
    } else {
      type = detectTypeFromStructure(root) || 'single';
    }

    // 题干提取
    const titleEls = root.querySelectorAll('h3, .Zy_TItle .clearfix, div:not(.stem_answer), p');
    let stem = '';
    for (const el of titleEls) {
      const t = el.textContent?.trim();
      if (t && t.length > 2) {
        stem = t;
        break;
      }
    }
    if (!stem) {
      // 尝试从 innerText 中匹配
      const text = root.innerText.trim();
      const qMatch = text.match(/^【(.+?)题】\s*(.+)/m);
      if (qMatch) {
        stem = qMatch[2];
        if (!typeInput) {
          type = qMatch[1].includes('单选') ? 'single'
            : qMatch[1].includes('多选') ? 'multi'
            : qMatch[1].includes('判断') ? 'judge'
            : qMatch[1].includes('填空') ? 'fill'
            : 'short';
        }
      } else {
        stem = text.split('\n')[0] || text.substring(0, 100);
      }
    }

    // 选项提取
    const optionEls = root.querySelectorAll(
      '.answerBg .answer_p, .textDIV, .eidtDiv, ul li .after, ul li textarea, ul textarea, ul li label:not(.before)'
    );
    let options = [...optionEls].map(el => el.innerText.trim()).filter(Boolean);

    if (options.length < 2) {
      options = [...root.querySelectorAll('label')].map(l => l.innerText.trim()).filter(Boolean);
    }
    if (options.length < 2) {
      options = [...root.querySelectorAll('li')].map(l => l.innerText.trim()).filter(Boolean);
    }

    // 图片提取
    const stemImages = [...root.querySelectorAll('img')].map(img => img.src).filter(Boolean);

    questions.push({
      index: i + 1,
      type: type,
      stem: stem,
      container: root,
      options: options,
      stemImages: stemImages,
    });
  }

  return questions;
}

// 原逻辑作为兜底
function extractQuestionsLegacy() {
  const text = document.body.innerText;
  if (!/【单选题】|【多选题】|【判断题】|【填空题】|【简答题】/.test(text)) return [];

  const optionEls = document.querySelectorAll('[role="option"]');
  const questions = [];
  let currentIndex = 0;

  for (const el of optionEls) {
    const t = el.innerText.trim();
    const numMatch = t.match(/^(\d+)$/);
    if (numMatch) { currentIndex = parseInt(numMatch[1]); continue; }

    const qMatch = t.match(/^【(.+?)题】\s*(.+)/);
    if (qMatch) {
      const typeLabel = qMatch[1];
      const type = typeLabel.includes('单选') ? 'single'
        : typeLabel.includes('多选') ? 'multi'
        : typeLabel.includes('判断') ? 'judge'
        : typeLabel.includes('填空') ? 'fill' : 'short';

      questions.push({
        index: currentIndex || questions.length + 1,
        type: type,
        stem: qMatch[2],
        container: el.parentElement,
        options: [...el.parentElement.querySelectorAll('label')].map(l => l.innerText.trim()).filter(Boolean),
        stemImages: [...el.parentElement.querySelectorAll('img')].map(img => img.src).filter(Boolean),
      });
    }
  }
  return questions;
}

// ─── API JSON 提取 ───

function extractQuestionsFromApi() {
  const el = document.getElementById('__cx_api_data');
  if (!el || !el.textContent) return [];

  try {
    const store = JSON.parse(el.textContent);
    const raw = store.data;
    if (!raw) return [];

    const list = findQuestionList(raw);
    if (!list || list.length === 0) return [];

    return list.map((item, i) => parseQuestionItem(item, i));
  } catch (_) {
    return [];
  }
}

function findQuestionList(raw) {
  if (Array.isArray(raw)) return raw;

  // 按优先级搜索已知键名
  const candidateKeys = [
    'data', 'questions', 'list', 'rows', 'result', 'records',
    'items', 'questionList', 'question_list', 'testQuestions',
    'paperQuestions', 'results',
  ];

  for (const key of candidateKeys) {
    if (raw[key] && Array.isArray(raw[key])) return raw[key];
  }

  // 深层嵌套: raw.data.questions 等
  if (raw.data && typeof raw.data === 'object') {
    for (const key of candidateKeys) {
      if (raw.data[key] && Array.isArray(raw.data[key])) return raw.data[key];
    }
  }

  // 兜底: 遍历所有根键找含题目特征键的对象数组
  for (const key of Object.keys(raw)) {
    const val = raw[key];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
      const firstKeys = Object.keys(val[0]);
      const questionish = firstKeys.some(k =>
        /type|title|stem|option|question|content/i.test(k)
      );
      if (questionish) return val;
    }
  }

  return null;
}

function parseQuestionItem(item, index) {
  return {
    index: item.index || item.Index || item.num || item.questionNo || (index + 1),
    type: normalizeType(
      item.type || item.Type || item.qType || item.questionType ||
      item.question_type || item.qTypeCode || ''
    ),
    stem: cleanStem(item),
    options: normalizeOptions(
      item.options || item.Options || item.choices || item.answerList ||
      item.optionList || item.answers || []
    ),
    stemImages: extractApiImages(item),
    container: null, // 由合并逻辑填充
  };
}

function normalizeType(rawType) {
  if (rawType === undefined || rawType === null || rawType === '') return 'single';
  const t = String(rawType).trim();

  // 数字码
  if (t === '0' || t === '1' || /^1[^\d]/.test(t) || t.includes('单选')) return 'single';
  if (t === '2' || /^2[^\d]/.test(t) || t.includes('多选')) return 'multi';
  if (t === '3' || /^3[^\d]/.test(t) || t.includes('判断')) return 'judge';
  if (t === '4' || /^4[^\d]/.test(t) || t.includes('填空')) return 'fill';
  if (t === '5' || /^5[^\d]/.test(t) || t.includes('简答')) return 'short';

  // 英文
  const lower = t.toLowerCase();
  if (lower === 'single' || lower === 'radio') return 'single';
  if (lower === 'multi' || lower === 'multiple' || lower === 'checkbox') return 'multi';
  if (lower === 'judge' || lower === 'truefalse' || lower === 'bool') return 'judge';
  if (lower === 'fill' || lower === 'blank' || lower === 'completion') return 'fill';
  if (lower === 'short' || lower === 'essay' || lower === 'open') return 'short';

  // 中文全称
  if (t.includes('单选题')) return 'single';
  if (t.includes('多选题')) return 'multi';
  if (t.includes('判断题')) return 'judge';
  if (t.includes('填空题')) return 'fill';
  if (t.includes('简答题')) return 'short';

  return 'single'; // 默认
}

function cleanStem(item) {
  let stem = (
    item.stem || item.title || item.Title || item.content ||
    item.Content || item.description || item.name || item.questionStem || ''
  );
  stem = String(stem).trim();

  // 去除 HTML 标签
  if (/<[^>]+>/.test(stem)) {
    try {
      const doc = new DOMParser().parseFromString(stem, 'text/html');
      stem = (doc.body.textContent || '').trim();
    } catch (_) { /* 保持原样 */ }
  }

  return stem;
}

function normalizeOptions(rawOptions) {
  if (!rawOptions) return [];
  if (!Array.isArray(rawOptions)) {
    // 对象格式: {A: "文本", B: "文本"}
    if (typeof rawOptions === 'object') {
      return Object.entries(rawOptions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => {
          const text = typeof v === 'string' ? v : (v && v.content) || String(v || '');
          return `${k}. ${text}`;
        });
    }
    return [];
  }

  if (rawOptions.length === 0) return [];

  const first = rawOptions[0];

  if (typeof first === 'string') {
    return rawOptions;
  }

  if (typeof first === 'object' && first !== null) {
    return rawOptions.map(opt => {
      const label = opt.name || opt.label || opt.key || opt.optionId ||
                    opt.Name || opt.Label || '';
      const text = opt.content || opt.text || opt.value || opt.description ||
                   opt.Content || opt.Text || '';
      return label ? `${label}. ${text}`.trim() : text;
    }).filter(Boolean);
  }

  return [];
}

function extractApiImages(item) {
  const images = [];

  // 题干 HTML 中的 img 标签
  const stemRaw = item.stem || item.title || item.Title || item.content || '';
  if (typeof stemRaw === 'string' && stemRaw.includes('<img')) {
    const matches = stemRaw.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
    images.push(...matches.map(m => {
      const srcMatch = m.match(/src=["']([^"']+)["']/i);
      return srcMatch ? srcMatch[1] : '';
    }).filter(Boolean));
  }

  // 专用图片字段
  const imgFields = ['images', 'attachment', 'stemImages', 'stem_images', 'attachments'];
  for (const field of imgFields) {
    const val = item[field];
    if (val) {
      if (Array.isArray(val)) {
        images.push(...val.map(img =>
          typeof img === 'string' ? img : (img.url || img.src || '')
        ).filter(Boolean));
      } else if (typeof val === 'string') {
        images.push(val);
      }
    }
  }

  return images;
}

// ─── 主提取函数（API 优先 + DOM 合并 / 回退） ───

function extractQuestions() {
  const apiQuestions = extractQuestionsFromApi();
  const domQuestions = extractQuestionsFromDom();

  if (apiQuestions.length > 0) {
    // API 有数据：用 API 提供文本，DOM 提供 container
    return apiQuestions.map((apiQ, i) => {
      // 按 index 匹配 DOM 题目
      const domQ = domQuestions.find(d => d.index === apiQ.index) || domQuestions[i] || null;

      return {
        index: apiQ.index,
        type: apiQ.type || (domQ ? domQ.type : 'single'),
        stem: apiQ.stem || (domQ ? domQ.stem : ''),
        options: apiQ.options.length > 0 ? apiQ.options : (domQ ? domQ.options : []),
        stemImages: apiQ.stemImages.length > 0 ? apiQ.stemImages : (domQ ? domQ.stemImages : []),
        container: domQ ? domQ.container : null,
      };
    });
  }

  // API 无数据，回退到纯 DOM
  return domQuestions;
}
