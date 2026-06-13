// shared/protocol.js — 消息类型定义 + 工具函数

// ─── 消息类型常量 ───
const MSG = {
  // Content → Background
  FRAME_CLASSIFY: 'frame_classify',
  SOLVE_REQUEST: 'solve_request',
  PROGRESS: 'progress',
  TASK_COMPLETE: 'task_complete',
  ERROR: 'error',
  GET_TAB_STATE: 'get_tab_state',

  // Background → Content
  START: 'start',
  STOP: 'stop',
  SOLVE_RESULT: 'solve_result',

  // Popup → Background
  GET_ALL_TAB_STATES: 'get_all_tab_states',
  START_TASK: 'start_task',
  STOP_TASK: 'stop_task',

  // Background → Popup
  TAB_UPDATE: 'tab_update',
  BACKEND_STATUS: 'backend_status',
};

// ─── 工具函数 ───
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getTabId() {
  return window.__cxTabId || null;
}

function getFrameId() {
  return window.__cxFrameId || null;
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.opacity !== '0'
    && el.offsetWidth > 0
    && el.offsetHeight > 0;
}

function countQuestions() {
  const text = document.body.innerText;
  const matches = text.match(/【[单多判填简]选题】/g);
  return matches ? matches.length : 0;
}

// ─── API 数据检测 ───
function hasApiData() {
  const el = document.getElementById('__cx_api_data');
  return !!(el && el.textContent);
}

function readApiDataTimestamp() {
  const el = document.getElementById('__cx_api_data');
  if (!el || !el.textContent) return 0;
  try {
    return JSON.parse(el.textContent).ts || 0;
  } catch (_) {
    return 0;
  }
}
