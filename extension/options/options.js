// options/options.js — 设置页面逻辑

const defaults = {
  provider: 'openai',
  model: 'deepseek-chat',
  apiBase: 'https://api.deepseek.com',
  apiKey: '',
  autoMode: true,
};

// 加载已保存的设置
async function loadConfig() {
  const stored = await chrome.storage.local.get(['apiConfig']);
  const config = stored.apiConfig || {};

  document.getElementById('provider').value = config.provider || defaults.provider;
  document.getElementById('apiKey').value = config.apiKey || '';
  document.getElementById('apiBase').value = config.apiBase || defaults.apiBase;
  document.getElementById('model').value = config.model || defaults.model;
  document.getElementById('autoMode').checked = config.autoMode !== false;
}

// 保存设置
async function saveConfig() {
  const config = {
    provider: document.getElementById('provider').value,
    apiKey: document.getElementById('apiKey').value.trim(),
    apiBase: document.getElementById('apiBase').value.trim(),
    model: document.getElementById('model').value.trim(),
    autoMode: document.getElementById('autoMode').checked,
  };

  await chrome.storage.local.set({ apiConfig: config });

  const status = document.getElementById('status');
  status.textContent = '✓ 已保存';
  status.className = 'status success';
  setTimeout(() => { status.textContent = ''; }, 2000);
}

document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  document.getElementById('saveBtn').addEventListener('click', saveConfig);
});
