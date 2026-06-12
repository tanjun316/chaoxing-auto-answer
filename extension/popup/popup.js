// popup/popup.js — 控制面板逻辑

let port = null;

document.addEventListener('DOMContentLoaded', async () => {
  // 连接 Background
  port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener(handlePortMessage);

  // 检查后端状态
  checkBackendHealth();

  // 请求所有标签页状态
  port.postMessage({ type: 'get_all_tab_states' });

  // 设置按钮
  document.getElementById('optionsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});

async function checkBackendHealth() {
  const dot = document.getElementById('backendDot');
  try {
    const resp = await fetch('http://127.0.0.1:8765/api/health', {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      dot.className = 'dot online';
      dot.title = '后端已连接';
    } else {
      dot.className = 'dot offline';
      dot.title = '后端异常';
    }
  } catch {
    dot.className = 'dot offline';
    dot.title = '后端未连接 — 请运行 python main.py';
  }
}

function handlePortMessage(msg) {
  switch (msg.type) {
    case 'all_tab_states':
      renderTabList(msg.states);
      break;
    case 'tab_update':
      // 更新单个标签页卡片
      updateTabCard(msg.tabId, msg.state);
      break;
  }
}

function renderTabList(states) {
  const list = document.getElementById('tabList');
  if (states.length === 0) {
    list.innerHTML = '<p class="empty">暂无活跃的标签页</p>';
    return;
  }

  list.innerHTML = states.map(s => {
    const pct = s.totalQuestions > 0
      ? Math.round(s.completedQuestions / s.totalQuestions * 100)
      : 0;
    const bar = s.taskActive
      ? `<div class="progress-bar"><div class="fill" style="width:${pct}%"></div></div>
         <span class="progress-text">${s.completedQuestions}/${s.totalQuestions}</span>`
      : '<span class="status-text">等待开始</span>';

    return `
      <div class="tab-card" data-tabid="${s.tabId}">
        <div class="tab-header">
          <span class="tab-name">Tab ${s.tabId}</span>
          ${s.taskActive
            ? '<button class="btn-stop" data-action="stop">停止</button>'
            : '<button class="btn-start" data-action="start">开始</button>'}
        </div>
        ${bar}
      </div>
    `;
  }).join('');

  // 绑定按钮事件
  list.querySelectorAll('[data-action="start"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tabId = parseInt(e.target.closest('.tab-card').dataset.tabid);
      port.postMessage({ type: 'start_task', tabId });
    });
  });
  list.querySelectorAll('[data-action="stop"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tabId = parseInt(e.target.closest('.tab-card').dataset.tabid);
      port.postMessage({ type: 'stop_task', tabId });
    });
  });
}

function updateTabCard(tabId, state) {
  // 简单实现：重新渲染整个列表
  port.postMessage({ type: 'get_all_tab_states' });
}
