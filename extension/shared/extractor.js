// shared/extractor.js — 学习通页面题目提取

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

function extractQuestions() {
  const text = document.body.innerText;

  // 统计题型确认页面有题目
  const patterns = {
    single: /【单选题】/g,
    multi: /【多选题】/g,
    judge: /【判断题】/g,
    fill: /【填空题】/g,
    short: /【简答题】/g,
  };

  let totalQuestions = 0;
  for (const pattern of Object.values(patterns)) {
    totalQuestions += (text.match(pattern) || []).length;
  }
  if (totalQuestions === 0) return [];

  // 通过 option 元素提取每题
  const optionEls = document.querySelectorAll('[role="option"]');
  const questions = [];
  let currentIndex = 0;

  for (const el of optionEls) {
    const t = el.innerText.trim();

    // 匹配题号（纯数字）
    const numMatch = t.match(/^(\d+)$/);
    if (numMatch) {
      currentIndex = parseInt(numMatch[1]);
      continue;
    }

    // 匹配题目行
    const qMatch = t.match(/^【(.+?)题】\s*(.+)/);
    if (qMatch) {
      const typeLabel = qMatch[1];
      const type = typeLabel.includes('单选') ? 'single'
        : typeLabel.includes('多选') ? 'multi'
        : typeLabel.includes('判断') ? 'judge'
        : typeLabel.includes('填空') ? 'fill'
        : 'short';

      questions.push({
        index: currentIndex || questions.length + 1,
        type: type,
        stem: qMatch[2],
        container: el.parentElement,
        options: extractOptionsNear(el),
        stemImages: extractImagesNear(el),
      });
    }
  }

  return questions;
}

function extractOptionsNear(optionEl) {
  const parent = optionEl.parentElement;
  if (!parent) return [];

  // 策略1: label 元素
  const labels = parent.querySelectorAll('label');
  if (labels.length >= 2) {
    return [...labels].map(l => l.innerText.trim()).filter(Boolean);
  }

  // 策略2: li 元素
  const lis = parent.querySelectorAll('li');
  if (lis.length >= 2) {
    return [...lis].map(l => l.innerText.trim()).filter(Boolean);
  }

  return [];
}

function extractImagesNear(optionEl) {
  const parent = optionEl.parentElement;
  if (!parent) return [];
  const imgs = parent.querySelectorAll('img');
  return [...imgs].map(img => img.src).filter(Boolean);
}
