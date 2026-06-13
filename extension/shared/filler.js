// shared/filler.js — 答案填入策略 (移植 OCS 匹配算法)

// ─── 字符串相似度 (Dice Coefficient) ───

function diceSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.substring(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.substring(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      bigrams.set(bg, count - 1);
      intersection++;
    }
  }
  return (2 * intersection) / (a.length + b.length - 2);
}

function findBestMatch(target, candidates) {
  let best = { rating: 0, target: '' };
  for (const c of candidates) {
    const r = diceSimilarity(target, c);
    if (r > best.rating) {
      best = { rating: r, target: c };
    }
  }
  return best;
}

// ─── 文本清理 ───

function clearText(str) {
  return String(str || '').trim()
    .toLowerCase()
    .replace(/[^⺀-鿿a-za-z0-9]/g, '');
}

function removeOptionPrefix(str) {
  return String(str || '').trim()
    .replace(/^[A-Za-z]{1}[.\s、:：]+/, '')
    .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
    .trim();
}

// ─── 答案分割 ───

const DEFAULT_SEPARATORS = ['===', '#', '---', '###', '|', ';', '；'];

function splitAnswer(answer, separators) {
  const s = String(answer || '').trim();
  if (s.length === 0) return [];

  // JSON 数组格式
  try {
    const json = JSON.parse(s);
    if (Array.isArray(json)) return json.map(String).filter(el => el.trim().length > 0);
  } catch (_) {}

  const seps = separators || DEFAULT_SEPARATORS;
  for (const sep of seps) {
    if (s.split(sep).length > 1) {
      return s.split(sep).filter(el => el.trim().length > 0);
    }
  }
  return [s];
}

// ─── 选项元素工具 ───

function getOptionTexts(container) {
  // 单选/多选: 找 label 或 clickable 元素
  const labels = container.querySelectorAll('label, .answerBg .answer_p, .textDIV, ul li .after, ul li label:not(.before)');
  if (labels.length >= 2) {
    return [...labels].map(l => l.innerText.trim()).filter(Boolean);
  }
  // 备选: 直接在 container 内找文本节点
  const lis = container.querySelectorAll('li');
  if (lis.length >= 2) {
    return [...lis].map(l => l.innerText.trim()).filter(Boolean);
  }
  return [];
}

function getOptionElements(container) {
  const labels = container.querySelectorAll('label');
  if (labels.length >= 2) return [...labels];
  const lis = container.querySelectorAll('li');
  if (lis.length >= 2) return [...lis];
  // 查找 .answerBg .answer_p 等 OCS 选择器
  const answerPs = container.querySelectorAll('.answerBg .answer_p, .textDIV, ul li .after, ul li label:not(.before)');
  if (answerPs.length >= 2) return [...answerPs];
  return [];
}

// ─── 填入策略 ───

const fillStrategies = {

  // 单选题 — 相似度匹配 + ABCD 回退
  single: (container, answer) => {
    const optionTexts = getOptionTexts(container);
    const optionEls = getOptionElements(container);

    if (optionTexts.length < 2 || optionEls.length < 2) return 'fail';

    // 1. 纯 ABCD 字母答案
    const letterMatch = answer.trim().match(/^[A-Za-z]$/);
    if (letterMatch) {
      const idx = letterMatch[0].toUpperCase().charCodeAt(0) - 65;
      if (idx < optionEls.length) {
        optionEls[idx].click();
        return 'ok';
      }
    }

    // 2. 相似度匹配
    const cleanAnswer = removeOptionPrefix(answer);
    const cleanTexts = optionTexts.map(removeOptionPrefix).map(clearText);

    // 精确匹配
    for (let i = 0; i < optionTexts.length; i++) {
      if (clearText(removeOptionPrefix(optionTexts[i])) === clearText(cleanAnswer)) {
        optionEls[i].click();
        return 'ok';
      }
    }

    // 模糊匹配 (阈值 60%)
    const best = findBestMatch(clearText(cleanAnswer), cleanTexts);
    if (best.rating > 0.6) {
      const idx = cleanTexts.indexOf(best.target);
      if (idx >= 0) {
        optionEls[idx].click();
        return 'ok';
      }
    }

    // 3. 包含匹配 (答案包含在选项中)
    for (let i = 0; i < optionTexts.length; i++) {
      if (clearText(optionTexts[i]).includes(clearText(cleanAnswer)) ||
          clearText(cleanAnswer).includes(clearText(optionTexts[i]))) {
        optionEls[i].click();
        return 'ok';
      }
    }

    return 'fail';
  },

  // 多选题 — 多答案分割 + 每个答案做相似度匹配
  multi: (container, answer) => {
    const optionTexts = getOptionTexts(container);
    const optionEls = getOptionElements(container);

    if (optionTexts.length < 2 || optionEls.length < 2) return 'fail';

    // 分割答案
    const answers = splitAnswer(answer);

    // 纯 ABCD 字母答案
    const plainAnswer = answer.trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (plainAnswer.length > 0 && /^[A-Z]+$/.test(plainAnswer)) {
      for (const ch of plainAnswer) {
        const idx = ch.charCodeAt(0) - 65;
        if (idx < optionEls.length) optionEls[idx].click();
      }
      return 'ok';
    }

    // 对每个答案部分做匹配
    const clicked = new Set();
    for (const ans of answers) {
      const cleanAns = clearText(removeOptionPrefix(ans));
      if (!cleanAns) continue;

      // 精确匹配
      let found = false;
      for (let i = 0; i < optionTexts.length; i++) {
        if (clicked.has(i)) continue;
        if (clearText(removeOptionPrefix(optionTexts[i])) === cleanAns) {
          optionEls[i].click();
          clicked.add(i);
          found = true;
          break;
        }
      }

      // 模糊匹配
      if (!found) {
        const cleanTexts = optionTexts.map((t, i) => clicked.has(i) ? '' : clearText(removeOptionPrefix(t)));
        const best = findBestMatch(cleanAns, cleanTexts);
        if (best.rating > 0.6 && best.target) {
          const idx = cleanTexts.indexOf(best.target);
          if (idx >= 0) {
            optionEls[idx].click();
            clicked.add(idx);
          }
        }
      }
    }

    return clicked.size > 0 ? 'ok' : 'fail';
  },

  // 判断题 — 词义匹配
  judge: (container, answer) => {
    const correctWords = ['是', '对', '正确', '确定', '√', '对的', '是的', '正确的', 'true', 'yes', '1'];
    const incorrectWords = ['非', '否', '错', '错误', '×', 'x', '错的', '不对', '不正确', '不是', 'false', 'no', '0'];

    const ans = answer.trim().toLowerCase();
    const isCorrect = correctWords.some(w => clearText(ans) === clearText(w));
    const isIncorrect = incorrectWords.some(w => clearText(ans) === clearText(w));

    if (!isCorrect && !isIncorrect) {
      // 尝试模糊匹配
      const text = clearText(ans);
      if (text.includes('正确') || text.includes('对') || text.includes('true')) {
        // correct
      } else if (text.includes('错误') || text.includes('错') || text.includes('false')) {
        // incorrect
      } else {
        return 'fail';
      }
    }

    const radios = [...container.querySelectorAll('input[type="radio"]')].filter(r => isVisible(r));
    if (radios.length >= 2) {
      radios[isCorrect ? 0 : 1].click();
      return 'ok';
    }

    // 找 clickable label
    const optionEls = getOptionElements(container);
    if (optionEls.length >= 2) {
      const texts = optionEls.map(el => el.innerText.trim().toLowerCase());
      for (let i = 0; i < texts.length; i++) {
        if (isCorrect && correctWords.some(w => texts[i].includes(w.toLowerCase()))) {
          optionEls[i].click();
          return 'ok';
        }
        if (isIncorrect && incorrectWords.some(w => texts[i].includes(w.toLowerCase()))) {
          optionEls[i].click();
          return 'ok';
        }
      }
    }

    return 'fail';
  },

  // 填空题 — 分割答案逐空填入
  fill: (container, answer) => {
    const inputs = [...container.querySelectorAll(
      'input[type="text"], input:not([type]), textarea'
    )].filter(inp => isVisible(inp));

    if (inputs.length === 0) return 'fail';

    const parts = splitAnswer(answer);
    if (parts.length === 1 && inputs.length > 1) {
      // 只有一个答案但有多个输入框 — 全部填相同答案
      humanType(inputs[0], parts[0].trim());
    } else {
      for (let i = 0; i < Math.min(parts.length, inputs.length); i++) {
        humanType(inputs[i], parts[i].trim());
      }
    }
    return 'ok';
  },

  // 简答题 — textarea 优先，iframe 备选
  short: (container, answer) => {
    const textarea = container.querySelector('textarea');
    if (textarea && isVisible(textarea)) {
      humanType(textarea, answer.trim());
      return 'ok';
    }

    // CKEditor / UEditor iframe
    const iframe = container.querySelector('iframe');
    if (iframe) {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc && doc.body) {
        doc.body.innerHTML = `<p>${answer.trim()}</p>`;
        return 'ok';
      }
    }

    // div[contenteditable]
    const editable = container.querySelector('[contenteditable="true"]');
    if (editable) {
      editable.innerHTML = `<p>${answer.trim()}</p>`;
      return 'ok';
    }

    return 'fail';
  },
};

// ─── 主入口 ───

function fillAnswer(question, answer) {
  const container = question.container;
  if (!container) return 'skip';
  if (!document.contains(container)) return 'skip';

  const strategy = fillStrategies[question.type];
  if (!strategy) return 'skip';

  return strategy(container, answer);
}
