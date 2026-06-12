// background.js — Service Worker
// 消息路由 + 标签页状态管理 + AI API 代理

// ─── Tab Registry ───

class TabState {
  constructor(tabId) {
    this.tabId = tabId;
    this.taskActive = false;
    this.autoMode = true;
    this.questionFrameId = null;
    this.totalQuestions = 0;
    this.completedQuestions = 0;
    this.currentPage = 1;
    this.startTime = null;
  }
}

const registry = new Map();
const popupPorts = new Set();

// ─── 标签页生命周期 ───

chrome.tabs.onRemoved.addListener((tabId) => {
  registry.delete(tabId);
  chrome.storage.local.remove(`tab_${tabId}`);
});

// 超时清理（30分钟）
setInterval(() => {
  const now = Date.now();
  for (const [tabId, state] of registry) {
    if (state.startTime && now - state.startTime > 1800000 && state.taskActive) {
      state.taskActive = false;
      broadcastToPopups({ type: 'tab_update', tabId, state: { taskActive: false } });
    }
  }
}, 60000);

// ─── Popup 连接 ───

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));
    port.onMessage.addListener((msg) => {
      handlePopupMessage(msg, port);
    });
  }
});

function broadcastToPopups(msg) {
  for (const port of popupPorts) {
    try { port.postMessage(msg); } catch (e) { popupPorts.delete(port); }
  }
}

async function handlePopupMessage(msg, port) {
  switch (msg.type) {
    case 'get_all_tab_states': {
      const states = [];
      for (const [tabId, state] of registry) {
        states.push({
          tabId,
          taskActive: state.taskActive,
          totalQuestions: state.totalQuestions,
          completedQuestions: state.completedQuestions,
          currentPage: state.currentPage,
        });
      }
      port.postMessage({ type: 'all_tab_states', states });
      break;
    }
    case 'start_task': {
      const state = registry.get(msg.tabId);
      if (state && state.questionFrameId) {
        state.taskActive = true;
        state.startTime = Date.now();
        chrome.tabs.sendMessage(msg.tabId, {
          type: 'start',
          autoMode: state.autoMode,
        }, { frameId: state.questionFrameId });
      }
      break;
    }
    case 'stop_task': {
      const state = registry.get(msg.tabId);
      if (state && state.questionFrameId) {
        state.taskActive = false;
        chrome.tabs.sendMessage(msg.tabId, {
          type: 'stop',
        }, { frameId: state.questionFrameId });
      }
      break;
    }
  }
}

// ─── Content Script 消息 ───

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  switch (msg.type) {
    case 'frame_classify': {
      // 告知 Content Script 其 tabId 和 frameId
      sendResponse({ tabId, frameId: sender.frameId });

      let state = registry.get(tabId);
      if (!state) {
        state = new TabState(tabId);
        registry.set(tabId, state);
      }

      if (msg.role === 'primary') {
        // 选 questionCount 最大的为 primary frame
        if (!state.questionFrameId || msg.questionCount > (state._maxCount || 0)) {
          state.questionFrameId = sender.frameId;
          state._maxCount = msg.questionCount;
          state.totalQuestions = msg.questionCount;
        }
      }
      break;
    }

    case 'get_tab_state': {
      const state = registry.get(tabId);
      if (state) {
        sendResponse({
          taskActive: state.taskActive,
          autoMode: state.autoMode,
        });
      } else {
        sendResponse({ taskActive: false, autoMode: true });
      }
      break;
    }

    case 'solve_request': {
      handleSolveRequest(tabId, sender.frameId, msg.questions).then(sendResponse);
      return true; // 保持通道开放等待异步响应
    }

    case 'progress': {
      const state = registry.get(tabId);
      if (state && msg.status === 'question_done') {
        state.completedQuestions = parseInt(msg.detail.progress?.split('/')[0]) || 0;
      }
      broadcastToPopups({
        type: 'tab_update',
        tabId,
        state: {
          taskActive: state?.taskActive || false,
          totalQuestions: state?.totalQuestions || 0,
          completedQuestions: state?.completedQuestions || 0,
          status: msg.status,
          detail: msg.detail,
        },
      });
      break;
    }

    case 'task_complete': {
      const state = registry.get(tabId);
      if (state) {
        state.taskActive = false;
        state._maxCount = 0;
      }
      broadcastToPopups({ type: 'tab_update', tabId, state: { taskActive: false } });
      break;
    }

    case 'error': {
      broadcastToPopups({
        type: 'tab_update',
        tabId,
        state: { taskActive: false, error: msg.message },
      });
      break;
    }
  }
});

// ─── AI API 代理 ───

async function handleSolveRequest(tabId, frameId, questions) {
  try {
    // 获取存储的 API 配置（由 Options Page 写入）
    const config = await chrome.storage.local.get(['apiConfig']);
    const apiConfig = config.apiConfig || {};

    const resp = await fetch('http://127.0.0.1:8765/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: questions,
        config: {
          api_key: apiConfig.apiKey || '',
          model: apiConfig.model || 'deepseek-chat',
          api_base: apiConfig.apiBase || 'https://api.deepseek.com',
          provider: apiConfig.provider || 'openai',
        },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    return data.results || [];
  } catch (e) {
    // 后端不可达时通知 Content Script
    chrome.tabs.sendMessage(tabId, {
      type: 'error',
      message: `后端请求失败: ${e.message}`,
    }, { frameId });
    return [];
  }
}
