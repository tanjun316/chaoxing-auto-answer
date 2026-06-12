# 学习通自动答题 Edge 扩展 — 设计文档

**日期**: 2026-06-12  
**版本**: 1.0  
**状态**: 设计完成，待实现

---

## 1. 概述

### 1.1 目标

在 Microsoft Edge 浏览器中构建一个扩展（Extension），配合本地 Python 后端，实现学习通网页版作业/测验的自动答题。

### 1.2 核心功能

- 自动检测学习通页面中的题目
- 通过 AI API 获取答案
- 自动填入答案并提交
- 自动翻页完成所有题目
- 支持多标签页同时操作

### 1.3 架构选型

选择**方案 A：轻量 Edge 扩展 + Python AI 后端**。

- **扩展 (JavaScript)**: 页面交互 — DOM 提取、答案填入、提交翻页、拟人化
- **Python 后端 (FastAPI)**: AI 调用 — 接收题目 JSON，返回答案 JSON
- **通信**: HTTP localhost (127.0.0.1:8765)，经过 Background Service Worker 中转

---

## 2. 实测发现

在真实学习通作业页面上使用 agent-browser 实测后发现：

### 2.1 iframe 嵌套深度

作业页面使用 5-6 层递归嵌套的 iframe：

```
主页面 (studentstudy)
  └ #iframe → knowledge/cards (课程导航)
    └ #iframe → knowledge/cards (页签: 正文/任务点)
      └ #iframe → knowledge/cards (bare)
        └ #mainid > #iframe → knowledge/cards (页签)
          └ #iframe → knowledge/cards (bare)
            └ #mainid > #iframe → 题目内容
```

### 2.2 现有选择器全部失效

项目现有 `dom_parser.py` 中的所有 CSS 选择器在真实页面上返回 **0 个结果**:

- `.questionLi` → 0
- `.tiItem` → 0
- `.mark_item` → 0
- `[class*="question"]` → 0

### 2.3 题目实际特征

- 题目文本以 `【单选题】`、`【多选题】`、`【判断题】`、`【填空题】`、`【简答题】` 开头
- 在无障碍树中以 `option` 角色出现
- radio/checkbox 可能由 JavaScript 动态生成
- 页面包含"提交"和"暂时保存"两个按钮

### 2.4 文本乱码

快照中部分汉字显示为乱码（如"化道路"→"抌決路"），不影响关键词匹配，但需注意 AI 收到的题干质量。

---

## 3. 架构

### 3.1 系统架构图

```
┌── Microsoft Edge ──────────────────────────────────────────┐
│                                                             │
│  Tab N (学习通作业页面)                                      │
│  ┌── iframe 1..N ───────────────────────────────────────┐  │
│  │  content/detect.js   (MAIN world, document_start)    │  │
│  │  content/content.js  (ISOLATED world, document_idle) │  │
│  │  ├─ classifyFrame() → 'primary' | 'transit' | 'inactive' │
│  │  ├─ extractQuestions() → JSON                        │  │
│  │  ├─ fillAnswer() → 拟人化填入                         │  │
│  │  └─ submitPage() → 提交 + 翻页                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌── Popup ────────────────────────────────────────────┐   │
│  │  多标签页卡片视图 + 启停控制 + 实时进度               │   │
│  └──────────────────────┬──────────────────────────────┘   │
│                         │ port 长连接                       │
│  ┌── Background (Service Worker) ──────────────────────┐   │
│  │  tabRegistry: Map<tabId, TabState>                   │   │
│  │  消息路由: Content ↔ Popup ↔ Python                   │   │
│  └──────────────────────┬──────────────────────────────┘   │
│                         │ HTTP (localhost:8765)             │
│  ┌── Options Page ─────────────────────────────────────┐   │
│  │  API Key | 模型选择 | API Base URL | 自动/手动开关    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                         │
                  ┌──────┴──────┐
                  │ Python 后端  │
                  │ FastAPI      │
                  │ /api/solve   │
                  │ /api/ocr     │
                  │ /api/health  │
                  └─────────────┘
```

### 3.2 模块清单

| 模块 | 文件 | 职责 |
|------|------|------|
| **detect.js** | `content/detect.js` | MAIN world — 覆盖 confirm/alert |
| **content.js** | `content/content.js` | ISOLATED world — 提取/填入/提交 |
| **extractor.js** | `shared/extractor.js` | 题目提取（文本特征匹配） |
| **filler.js** | `shared/filler.js` | 答案填入（按题型策略） |
| **humanize.js** | `shared/humanize.js` | 拟人化延迟和输入 |
| **protocol.js** | `shared/protocol.js` | 消息类型和格式定义 |
| **background.js** | `background.js` | 消息路由 + tabRegistry |
| **popup** | `popup/` | 多标签页控制面板 |
| **options** | `options/` | API 配置页 |
| **Python 后端** | `main.py`, `solver/`, `extractor/ocr.py` | AI 调用 + OCR |

### 3.3 现有代码复用

| 现有文件 | 去向 | 说明 |
|---------|------|------|
| `solver/ai.py` | **保留** | AI 调用核心，基本不变 |
| `solver/prompt.py` | **保留** | Prompt 模板，基本不变 |
| `extractor/ocr.py` | **保留** | PaddleOCR 图片识别 |
| `config.yaml` | **保留** | Python 端默认配置 |
| `main.py` | **保留精简** | 启动 Python 后端 |
| `extractor/dom_parser.py` | **废弃** | 选择器全部失效 |
| `submitter/filler.py` | **JS 重写** | 逻辑迁移到 shared/filler.js |
| `submitter/humanize.py` | **JS 重写** | 逻辑迁移到 shared/humanize.js |
| `browser/manager.py` | **废弃** | 无需 Playwright |
| `auth/login.py` | **废弃** | 用户手动登录 |
| `frontend/` | **重写** | 改为扩展内 popup + options |

---

## 4. 详细设计

### 4.1 manifest.json

```json
{
  "manifest_version": 3,
  "name": "学习通助手",
  "version": "1.0",
  "description": "自动答题工具",
  "permissions": ["storage", "tabs", "activeTab"],
  "host_permissions": [
    "*://*.chaoxing.com/*",
    "*://*.edu.cn/*",
    "http://127.0.0.1:8765/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "world": "MAIN",
      "matches": ["*://*.chaoxing.com/*", "*://*.edu.cn/*"],
      "js": ["content/detect.js"],
      "all_frames": true,
      "run_at": "document_start"
    },
    {
      "world": "ISOLATED",
      "matches": ["*://*.chaoxing.com/*", "*://*.edu.cn/*"],
      "js": ["shared/protocol.js", "shared/extractor.js", "shared/filler.js", "shared/humanize.js", "content/content.js"],
      "all_frames": true,
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "学习通助手"
  },
  "options_page": "options/options.html"
}
```

### 4.2 消息协议

```
Content → Background:
  {type: "frame_classify", tabId, frameId, role, questionCount}
  {type: "solve_request", tabId, frameId, questions: [{index, type, stem, options}]}
  {type: "progress", tabId, frameId, status, detail}
  {type: "task_complete", tabId, frameId}
  {type: "error", tabId, frameId, message}

Background → Content (指定 frameId):
  {type: "start", tabId, autoMode}
  {type: "stop", tabId}
  {type: "solve_result", tabId, results: [{index, answer, reason}]}

Popup → Background:
  {type: "get_all_tab_states"}
  {type: "start_task", tabId}
  {type: "stop_task", tabId}

Background → Popup (port):
  {type: "tab_update", tabId, state: {taskActive, progress, questionCount}}
  {type: "backend_status", online: boolean}

Background → Python (HTTP):
  POST /api/solve
  Body: {questions: [{index, type, stem, options}], config: {api_key, model, api_base, provider}}
  Response: {ok: true, results: [{index, answer, reason}]}
```

### 4.3 Frame 分类与仲裁

```javascript
// content.js — 每个 frame 启动时执行
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

const role = classifyFrame();
if (role === 'inactive') return; // 静默退出

// 向 Background 报告
chrome.runtime.sendMessage({
  type: 'frame_classify',
  role: role,
  questionCount: role === 'primary' ? countQuestions() : 0
});
```

Background 收到多个 frame 报告后，选择 `questionCount` 最大的 `primary` frame 作为主战场。如果页面变化（翻页），新的 frame 报告到达时重新仲裁。

### 4.3a 工具函数

```javascript
// shared/protocol.js — 工具函数

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getTabId() {
  // Content Script 中无法直接获取 tabId，需从 Background 消息中获取
  // 或通过 chrome.runtime.sendMessage 时 sender.tab.id 传回
  return window.__cxTabId || null;
}

function getFrameId() {
  // 同理，由 Background 在首次通信时告知
  return window.__cxFrameId || null;
}

function countQuestions() {
  const text = document.body.innerText;
  const matches = text.match(/【[单多判填简]选题】/g);
  return matches ? matches.length : 0;
}
```

### 4.4 题目提取

```javascript
// shared/extractor.js — 文本特征匹配策略

function extractQuestions() {
  const text = document.body.innerText;
  
  // 统计题型
  const patterns = {
    single: /【单选题】/g,
    multi: /【多选题】/g,
    judge: /【判断题】/g,
    fill: /【填空题】/g,
    short: /【简答题】/g,
  };
  
  const counts = {};
  for (const [type, pattern] of Object.entries(patterns)) {
    counts[type] = (text.match(pattern) || []).length;
  }
  
  const totalQuestions = Object.values(counts).reduce((a, b) => a + b, 0);
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
        container: el.parentElement, // DOM 容器引用，供 filler 使用
        options: extractOptionsNear(el),
        stemImages: extractImagesNear(el),
      });
    }
  }
  
  return questions;
}

// 在 option 元素附近查找选项文本
function extractOptionsNear(optionEl) {
  const parent = optionEl.parentElement;
  if (!parent) return [];
  
  const labels = parent.querySelectorAll('label');
  if (labels.length >= 2) {
    return [...labels].map(l => l.innerText.trim()).filter(Boolean);
  }
  
  // 降级：查找兄弟 li 元素
  const lis = parent.querySelectorAll('li');
  if (lis.length >= 2) {
    return [...lis].map(l => l.innerText.trim()).filter(Boolean);
  }
  
  return [];
}

// 在 option 元素附近查找图片
function extractImagesNear(optionEl) {
  const parent = optionEl.parentElement;
  if (!parent) return [];
  
  const imgs = parent.querySelectorAll('img');
  return [...imgs].map(img => img.src).filter(Boolean);
}
```

### 4.5 降级提取策略

当文本特征匹配也失败时：

1. **无障碍树扫描**: 遍历所有元素，查找包含题型关键词的文本节点
2. **表单推断**: 找 radio/checkbox/textarea 聚集区域，推断题目边界
3. **用户反馈**: 提示用户截图报告，便于后续适配

### 4.6 答案填入

```javascript
// shared/filler.js — 按题型策略
// 注意：container 是 question.container（即 option 元素的 parentElement）

const fillStrategies = {

  single: (container, answer) => {
    // 清理答案为字母 A-Z
    const letter = answer.trim().toUpperCase().replace(/[^A-Z]/g, '')[0];
    if (!letter) return 'skip';
    
    const idx = letter.charCodeAt(0) - 65;
    const radios = [...container.querySelectorAll('input[type="radio"]')]
      .filter(r => isVisible(r));
    
    if (idx < radios.length) {
      radios[idx].click();
      return 'ok';
    }
    
    // 降级：文本匹配 label
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
    
    // iframe 富文本编辑器
    const iframe = container.querySelector('iframe');
    if (iframe) {
      const doc = iframe.contentDocument;
      if (doc) {
        const body = doc.body;
        body.innerHTML = `<p>${answer.trim()}</p>`;
        return 'ok';
      }
    }
    return 'fail';
  },
};
```

### 4.7 元素可见性判断

```javascript
function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.opacity !== '0'
    && el.offsetWidth > 0
    && el.offsetHeight > 0;
}
```

### 4.8 拟人化

```javascript
// shared/humanize.js

function logNormalRandom(mean, std) {
  // Box-Muller transform，产生正偏态分布延迟
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.exp(Math.log(mean) + std * z);
}

async function humanDelay(betweenQuestions = true) {
  // 题间: 3-12秒对数正态分布；题内: 0.5-2秒均匀
  const ms = betweenQuestions
    ? Math.min(12000, Math.max(3000, logNormalRandom(4.5, 0.4) * 1000))
    : Math.random() * 1500 + 500;
  await new Promise(r => setTimeout(r, ms));
}

async function humanType(element, text) {
  element.focus();
  element.value = '';
  for (const char of text) {
    element.value += char;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
  }
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
```

### 4.9 MAIN world 弹窗覆盖

```javascript
// content/detect.js — 运行在 MAIN world，通过 DOM 与 ISOLATED world 通信

window._originalConfirm = window.confirm;
window._originalAlert = window.alert;

window.confirm = function(msg) {
  document.body.setAttribute('data-cx-confirm', String(msg || ''));
  return true; // 自动确认
};

window.alert = function(msg) {
  document.body.setAttribute('data-cx-alert', String(msg || ''));
  // 不阻塞，自动关闭
};
```

ISOLATED world 中检查：

```javascript
function consumeConfirm() {
  const val = document.body.getAttribute('data-cx-confirm');
  if (val !== null) {
    document.body.removeAttribute('data-cx-confirm');
    return val;
  }
  return null;
}
```

### 4.10 提交与翻页

```javascript
async function submitPage() {
  // 严格匹配提交按钮（排除暂存）
  const btns = [...document.querySelectorAll('button')];
  const submit = btns.find(b => {
    const t = b.innerText.trim();
    return /^(提交|交卷)$/.test(t) && isVisible(b);
  });
  
  if (!submit) return false;
  
  submit.click();
  await sleep(1500);
  
  // 确认弹窗已被 MAIN world 自动接受
  const confirmed = consumeConfirm();
  
  return true;
}

// 翻页检测：MutationObserver + URL 监听
function watchPageChange(callback) {
  // SPA 变化
  const observer = new MutationObserver(() => {
    if (extractQuestions().length > 0) {
      observer.disconnect();
      callback('dom_change');
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  
  // 超时：30 秒无变化视为完成
  setTimeout(() => {
    observer.disconnect();
    callback('timeout');
  }, 30000);
}
```

### 4.11 多标签页管理

```javascript
// background.js — tabRegistry

class TabState {
  constructor(tabId) {
    this.tabId = tabId;
    this.taskActive = false;
    this.autoMode = true;        // 从 storage 读取，默认 true
    this.questionFrameId = null; // 题目所在 frame
    this.totalQuestions = 0;
    this.completedQuestions = 0;
    this.currentPage = 1;
    this.startTime = null;
    this.apiConfig = null;       // 从 options 读取
  }
}

const registry = new Map();

// 标签页关闭清理
chrome.tabs.onRemoved.addListener((tabId) => {
  registry.delete(tabId);
  chrome.storage.local.remove(`tab_${tabId}`);
});

// 超时清理（30 分钟无活跃则清除残留）
setInterval(() => {
  const now = Date.now();
  for (const [tabId, state] of registry) {
    if (state.startTime && now - state.startTime > 1800000 && state.taskActive) {
      state.taskActive = false;
      // 通过 port 通知 Popup（如果连接着）
      for (const port of popupPorts) {
        port.postMessage({ type: 'tab_update', tabId, state: { taskActive: false, reason: 'timeout' } });
      }
    }
  }
}, 60000);

// Popup port 连接管理
const popupPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));
  }
});
```

### 4.12 图片处理

```javascript
// 图片转 base64（用于 OCR）
async function imgToBase64(imgElement) {
  try {
    // 方法1: canvas（同域）
    const canvas = document.createElement('canvas');
    canvas.width = imgElement.naturalWidth;
    canvas.height = imgElement.naturalHeight;
    canvas.getContext('2d').drawImage(imgElement, 0, 0);
    return canvas.toDataURL('image/png');
  } catch (e) {
    // 方法2: fetch 下载（扩展有 host_permissions）
    try {
      const resp = await fetch(imgElement.src);
      const blob = await resp.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    } catch (e2) {
      // 方法3: 传 URL 给 Python 下载
      return { url: imgElement.src };
    }
  }
}
```

Python 后端扩展支持：

```python
# solver/ai.py 新增
async def _prepare_question(question: dict) -> dict:
    """如果 stem_images 中包含 URL，尝试下载并 OCR"""
    images = question.get("stem_images", [])
    ocr_texts = []
    for img in images:
        if isinstance(img, str) and img.startswith("http"):
            # Python 下载 → OCR
            resp = await httpx_client.get(img)
            ocr_texts.append(await ocr.image_to_text(resp.content))
        elif isinstance(img, str) and img.startswith("data:"):
            # base64 → OCR
            ocr_texts.append(await ocr.base64_screenshot_to_text(img))
    if ocr_texts:
        question["stem"] += "\n[图片文字]: " + " ".join(ocr_texts)
    return question
```

### 4.13 Python 后端 API

```
POST /api/solve
Content-Type: application/json

Request:
{
  "questions": [
    {
      "index": 1,
      "type": "single",
      "stem": "走中国工业化道路，必须采取正确的经济建设方针，其中不包括（）。",
      "options": ["A. 统筹兼顾", "B. ..."],
      "stem_images": []
    }
  ],
  "config": {
    "api_key": "sk-...",
    "model": "deepseek-chat",
    "api_base": "https://api.deepseek.com",
    "provider": "openai"
  }
}

Response 200:
{
  "ok": true,
  "results": [
    {"index": 1, "answer": "A", "reason": "..."}
  ]
}

Response 500:
{
  "ok": false,
  "error": "AI API 调用失败: ..."
}

GET /api/health
Response 200:
{"status": "ok", "version": "1.0"}
```

### 4.14 自动化流程

```
1. 用户打开 Edge，启动 Python 后端
2. 用户登录学习通，进入作业页面
3. Content Script (all_frames) 注入每个 iframe
4. 每个 frame 执行 classifyFrame():
   - 'inactive' → 静默退出
   - 'transit' / 'primary' → 上报 Background
5. Background 仲裁 primary frame（questionCount 最大）
6. 检测模式：
   - autoMode=true → 自动触发
   - autoMode=false → 等待 Popup 手动"开始"
7. extractQuestions() → solve_request → Background
8. Background fetch Python /api/solve → solve_result → Content
9. Content 逐题 fillAnswer() + humanDelay()
10. 全部填入 → submitPage()
11. submitPage() 后 watchPageChange():
    - dom_change → 回到步骤 7
    - timeout(30s) → task_complete → 清除 taskActive
12. 用户可随时通过 Popup 停止
```

### 4.15 错误处理

| 场景 | 处理 |
|------|------|
| Python 后端未启动 | Popup 显示红色"后端未连接"，提供启动指引 |
| AI 返回格式错误 | 重试 3 次（复用 ai.py 逻辑） |
| 网络超时 | fetch 10s 超时 + 错误提示 |
| 页面无题目 | 提示"当前页面未检测到题目" |
| 用户手动停止 | 立即中断填入，不清除已填答案 |
| 同一 tab 多 frame 竞争 | Background 仲裁，只选一个 primary |
| 图片跨域 | fetch → blob → base64 降级 → Python URL 下载 |
| 30 分钟无活动 | 自动清除 taskActive，防止残留 |

### 4.16 content.js 主控制流

```javascript
// content/content.js — 初始化入口

(async function main() {
  // 1. 分类当前 frame
  const role = classifyFrame();
  if (role === 'inactive') return;

  // 2. 通知 Background 并获取 tabId/frameId
  chrome.runtime.sendMessage({
    type: 'frame_classify',
    role: role,
    questionCount: role === 'primary' ? countQuestions() : 0
  }, (response) => {
    if (response) {
      window.__cxTabId = response.tabId;
      window.__cxFrameId = response.frameId;
    }
  });

  // 3. 监听 Background 指令
  chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    // 检查是否是发给本 frame 的
    if (msg.frameId && msg.frameId !== getFrameId()) return;

    switch (msg.type) {
      case 'start':
        await handleStart(msg.autoMode);
        break;
      case 'stop':
        handleStop();
        break;
      case 'solve_result':
        await handleSolveResult(msg.results);
        break;
    }
  });

  // 4. transit frame: 等待页面内 iframe 加载完成
  if (role === 'transit') {
    // 不需要主动做什么，inner frames 会各自上报
    return;
  }

  // 5. primary frame: 检查是否需要自动开始
  const tabState = await chrome.runtime.sendMessage({
    type: 'get_tab_state',
    tabId: getTabId()
  });

  if (tabState && tabState.taskActive && tabState.autoMode) {
    await handleStart(true);
  }
})();

// ── 任务处理 ──

let taskRunning = false;
let stopRequested = false;

async function handleStart(autoMode) {
  if (taskRunning) return;
  taskRunning = true;
  stopRequested = false;

  try {
    while (taskRunning && !stopRequested) {
      // 提取题目
      const questions = extractQuestions();
      if (questions.length === 0) break;

      reportProgress('extracted', { total: questions.length });

      // 请求 AI 答案
      reportProgress('solving');
      const results = await chrome.runtime.sendMessage({
        type: 'solve_request',
        tabId: getTabId(),
        frameId: getFrameId(),
        questions: questions
      });

      if (!results || results.length === 0) {
        reportProgress('error', { message: 'AI 未返回答案' });
        break;
      }

      // 逐题填入
      for (let i = 0; i < results.length; i++) {
        if (stopRequested) break;

        const question = questions[i];
        const answer = results[i]?.answer || '';
        if (!answer) {
          reportProgress('question_done', { index: question.index, status: 'skipped' });
          continue;
        }

        const result = fillAnswer(question, answer);
        reportProgress('question_done', {
          index: question.index,
          status: result,
          answer: answer,
          progress: `${i + 1}/${results.length}`
        });

        await humanDelay(true);
      }

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
      // else: 'dom_change' → 循环继续提取下一页
    }
  } catch (e) {
    reportProgress('error', { message: e.message });
  } finally {
    taskRunning = false;
    if (!stopRequested) {
      chrome.runtime.sendMessage({
        type: 'task_complete',
        tabId: getTabId(),
        frameId: getFrameId()
      });
    }
  }
}

function handleStop() {
  stopRequested = true;
}

function fillAnswer(question, answer) {
  const container = question.container;
  if (!container) return 'skip';

  // 检查 DOM 是否仍连接
  if (!document.contains(container)) return 'skip';

  const strategy = fillStrategies[question.type];
  if (!strategy) return 'skip';

  return strategy(container, answer);
}

function reportProgress(status, detail = {}) {
  chrome.runtime.sendMessage({
    type: 'progress',
    tabId: getTabId(),
    frameId: getFrameId(),
    status: status,
    detail: detail
  });
}
```

### 4.17 Python 后端 CORS

```python
# main.py — FastAPI CORS 配置

from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "chrome-extension://*",   # Edge/Chrome 扩展
        "moz-extension://*",      # Firefox 扩展（备用）
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
```

---

## 5. 可复用现有代码

| 文件 | 复用方式 |
|------|---------|
| `solver/ai.py` | 直接保留，扩展 `/api/solve` 接口参数 |
| `solver/prompt.py` | 直接保留，System Prompt 和题型模板不变 |
| `extractor/ocr.py` | 直接保留，PaddleOCR 不变 |
| `config.yaml` | 保留为默认配置，扩展 options 可覆盖 |
| `main.py` | 精简后保留（移除 Playwright 相关） |
| `requirements.txt` | 移除 playwright、移除前端依赖 |
| `.env.example` | 保留 |

---

## 6. 文件清单

### 新增文件

```
extension/
├── manifest.json
├── background.js
├── content/
│   ├── detect.js
│   └── content.js
├── shared/
│   ├── protocol.js
│   ├── extractor.js
│   ├── filler.js
│   └── humanize.js
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
└── options/
    ├── options.html
    ├── options.js
    └── options.css
```

### 修改文件

```
main.py               # 精简，移除 Playwright 启动
backend/solver/ai.py   # 扩展 /api/solve 接口
requirements.txt       # 移除 playwright
```

### 废弃文件

```
backend/browser/       # 不需要 Playwright
backend/auth/          # 用户手动登录
backend/submitter/     # 逻辑迁到 JS
backend/extractor/dom_parser.py  # 选择器失效
frontend/              # 迁入扩展 popup/options
start_edge_debug.bat   # 简化为只启动 Python
```

---

## 7. 测试策略

### 7.1 单元测试

- `extractor.js`: mock 学习通页面 HTML，验证提取正确性
- `filler.js`: mock DOM 容器，验证各题型填入策略
- `ai.py`: 保留现有 prompt 测试

### 7.2 集成测试

- 扩展 + Python 后端联调：使用 agent-browser 打开真实学习通页面
- 验证完整流程：检测 → 提取 → AI 答题 → 填入 → 提交
- 多标签页并发测试

### 7.3 回归测试

- 学习通页面模板变化时，验证提取器降级策略
- 每种题型（单选/多选/判断/填空/简答）的正确填入

---

## 8. 已知限制

1. **页面结构依赖**: 依赖 `【题型】` 文本标记和 `[role="option"]` 属性，学习通改版可能导致失效
2. **图片题**: OCR 准确率取决于 PaddleOCR，复杂公式/图表可能识别不准
3. **反作弊**: 学习通可能检测自动化操作（拟人化延迟可缓解但不保证）
4. **iframe 深度**: 极深的 iframe 嵌套可能导致 Content Script 在某些边界情况下注入失败
5. **CDP 端口**: Python 后端使用 HTTP，端口 8765 需未被占用

---

## 9. 安全注意事项

- Python 后端绑定 `127.0.0.1`（不绑定 `0.0.0.0`），仅本机可访问
- API Key 通过 localhost 传输，不经过公网
- 扩展 host_permissions 仅限 `chaoxing.com` 和 `127.0.0.1`
- `.env` 文件不应提交到版本控制
- 建议用户使用 API Key 而非账号密码登录 AI 服务
