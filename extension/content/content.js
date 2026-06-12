// content/content.js — 核心流程控制

// ─── 初始化 ───

(async function main() {
  const role = classifyFrame();
  if (role === 'inactive') return;

  // 向 Background 报告
  chrome.runtime.sendMessage({
    type: MSG.FRAME_CLASSIFY,
    role: role,
    questionCount: role === 'primary' ? countQuestions() : 0
  }, (response) => {
    if (response) {
      window.__cxTabId = response.tabId;
      window.__cxFrameId = response.frameId;
    }
  });

  // 监听 Background 指令
  chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    if (msg.frameId && msg.frameId !== getFrameId()) return;

    switch (msg.type) {
      case MSG.START:
        await handleStart(msg.autoMode);
        break;
      case MSG.STOP:
        handleStop();
        break;
      case MSG.SOLVE_RESULT:
        await handleSolveResult(msg.results);
        break;
    }
  });

  // transit frame 等待 inner frames 自行上报
  if (role === 'transit') return;

  // 检查是否需要自动开始
  chrome.runtime.sendMessage(
    { type: MSG.GET_TAB_STATE, tabId: getTabId() },
    async (tabState) => {
      if (tabState && tabState.taskActive && tabState.autoMode) {
        await handleStart(true);
      }
    }
  );
})();

// ─── 任务状态 ───

let taskRunning = false;
let stopRequested = false;
let solveResolve = null;  // 等待 solve 结果的回调

// ─── 任务处理 ───

async function handleStart(autoMode) {
  if (taskRunning) return;
  taskRunning = true;
  stopRequested = false;

  try {
    while (taskRunning && !stopRequested) {
      const questions = extractQuestions();
      if (questions.length === 0) break;

      reportProgress('extracted', { total: questions.length });

      // 请求 AI 答案（通过 Background 转发）
      reportProgress('solving');
      const results = await new Promise((resolve) => {
        solveResolve = resolve;
        chrome.runtime.sendMessage({
          type: MSG.SOLVE_REQUEST,
          tabId: getTabId(),
          frameId: getFrameId(),
          questions: questions.map(q => ({
            index: q.index,
            type: q.type,
            stem: q.stem,
            options: q.options,
            stem_images: q.stemImages,
          })),
        });
      });

      if (!results || results.length === 0) {
        reportProgress('error', { message: 'AI 未返回答案' });
        break;
      }

      // 逐题填入
      for (let i = 0; i < results.length; i++) {
        if (stopRequested) break;

        const question = questions.find(q => q.index === results[i].index);
        if (!question) continue;

        const answer = results[i].answer || '';
        if (!answer) {
          reportProgress('question_done', {
            index: results[i].index,
            status: 'skipped',
          });
          continue;
        }

        const status = fillAnswer(question, answer);
        reportProgress('question_done', {
          index: results[i].index,
          status: status,
          answer: answer,
          progress: `${i + 1}/${results.length}`,
        });

        await humanDelay(true);
      }

      if (stopRequested) break;

      // 提交
      await submitPage();

      // 等待翻页
      const nextAction = await new Promise((resolve) => {
        watchPageChange(resolve);
      });

      if (nextAction === 'timeout') {
        reportProgress('task_complete');
        break;
      }
      // dom_change → 继续循环
    }
  } catch (e) {
    reportProgress('error', { message: e.message });
  } finally {
    taskRunning = false;
    if (!stopRequested) {
      chrome.runtime.sendMessage({
        type: MSG.TASK_COMPLETE,
        tabId: getTabId(),
        frameId: getFrameId(),
      });
    }
  }
}

function handleStop() {
  stopRequested = true;
}

async function handleSolveResult(results) {
  if (solveResolve) {
    solveResolve(results);
    solveResolve = null;
  }
}

// ─── 提交与翻页 ───

async function submitPage() {
  const btns = [...document.querySelectorAll('button')];
  const submit = btns.find(b => {
    const t = b.innerText.trim();
    return /^(提交|交卷)$/.test(t) && isVisible(b);
  });

  if (!submit) return false;

  submit.click();
  await sleep(1500);

  // 检查 confirm 是否被触发（由 MAIN world 覆盖后通过 DOM 属性通知）
  const hadConfirm = document.body.getAttribute('data-cx-confirm');
  if (hadConfirm !== null) {
    document.body.removeAttribute('data-cx-confirm');
  }

  return true;
}

function watchPageChange(callback) {
  const observer = new MutationObserver(() => {
    const questions = extractQuestions();
    if (questions.length > 0) {
      observer.disconnect();
      callback('dom_change');
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  setTimeout(() => {
    observer.disconnect();
    callback('timeout');
  }, 30000);
}

// ─── 进度上报 ───

function reportProgress(status, detail = {}) {
  chrome.runtime.sendMessage({
    type: MSG.PROGRESS,
    tabId: getTabId(),
    frameId: getFrameId(),
    status: status,
    detail: detail,
  });
}
