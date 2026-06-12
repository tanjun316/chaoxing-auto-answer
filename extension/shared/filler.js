// shared/filler.js — 答案填入策略

const fillStrategies = {
  single: (container, answer) => {
    const letter = answer.trim().toUpperCase().replace(/[^A-Z]/g, '')[0];
    if (!letter) return 'skip';

    const idx = letter.charCodeAt(0) - 65;
    const radios = [...container.querySelectorAll('input[type="radio"]')]
      .filter(r => isVisible(r));

    if (idx < radios.length) {
      radios[idx].click();
      return 'ok';
    }

    const labels = container.querySelectorAll('label');
    for (const l of labels) {
      if (l.innerText.trim().toUpperCase().startsWith(letter)) {
        l.click();
        return 'ok';
      }
    }
    return 'fail';
  },

  multi: (container, answer) => {
    const letters = answer.toUpperCase().replace(/[^A-Z,，、]/g, '')
      .split(/[,，、]/).filter(Boolean);

    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')]
      .filter(cb => isVisible(cb));

    for (const letter of letters) {
      const idx = letter.charCodeAt(0) - 65;
      if (idx < checkboxes.length) checkboxes[idx].click();
    }
    return 'ok';
  },

  judge: (container, answer) => {
    const isCorrect = /正确|对|√|true|yes|是/i.test(answer.trim());
    const radios = [...container.querySelectorAll('input[type="radio"]')]
      .filter(r => isVisible(r));

    if (radios.length >= 2) {
      radios[isCorrect ? 0 : 1].click();
      return 'ok';
    }
    return 'fail';
  },

  fill: (container, answer) => {
    const inputs = [...container.querySelectorAll(
      'input[type="text"], input:not([type])'
    )].filter(inp => isVisible(inp));

    if (inputs.length === 0) return 'fail';

    const parts = answer.split(/[;；]/);
    for (let i = 0; i < Math.min(parts.length, inputs.length); i++) {
      humanType(inputs[i], parts[i].trim());
    }
    return 'ok';
  },

  short: (container, answer) => {
    const textarea = container.querySelector('textarea');
    if (textarea && isVisible(textarea)) {
      humanType(textarea, answer.trim());
      return 'ok';
    }

    const iframe = container.querySelector('iframe');
    if (iframe) {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc && doc.body) {
        doc.body.innerHTML = `<p>${answer.trim()}</p>`;
        return 'ok';
      }
    }
    return 'fail';
  },
};

function fillAnswer(question, answer) {
  const container = question.container;
  if (!container) return 'skip';
  if (!document.contains(container)) return 'skip';

  const strategy = fillStrategies[question.type];
  if (!strategy) return 'skip';

  return strategy(container, answer);
}
