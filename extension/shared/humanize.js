// shared/humanize.js — 拟人化延迟和输入

function logNormalRandom(mean, std) {
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.exp(Math.log(mean) + std * z);
}

async function humanDelay(betweenQuestions = true) {
  const ms = betweenQuestions
    ? Math.min(12000, Math.max(3000, logNormalRandom(4.5, 0.4) * 1000))
    : Math.random() * 1500 + 500;
  await sleep(ms);
}

async function humanType(element, text) {
  element.focus();
  element.value = '';
  for (const char of text) {
    element.value += char;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80 + Math.random() * 120);
  }
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
