# 学习通自动答题 Edge 扩展 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 Edge 扩展 + Python 后端，自动完成学习通作业的题目提取、AI 答题、填入和提交。

**Architecture:** Edge 扩展（MV3）通过 Background Service Worker 中转，与本地 Python FastAPI 后端（127.0.0.1:8765）通信。Content Script 以 `all_frames: true` 注入所有 iframe，通过文本特征（`【单选题】` 等）识别题目 frame。

**Tech Stack:** JavaScript (MV3 Extension), Python 3.13 (FastAPI + OpenAI SDK), PaddleOCR

---

## File Structure Map

```
316/                                  # 项目根目录
├── extension/                        # [NEW] Edge 扩展
│   ├── manifest.json                 # MV3 清单
│   ├── background.js                 # Service Worker
│   ├── content/
│   │   ├── detect.js                 # MAIN world — confirm/alert 覆盖
│   │   └── content.js                # ISOLATED world — 核心流程
│   ├── shared/
│   │   ├── protocol.js               # 消息类型 + 工具函数
│   │   ├── extractor.js              # 题目提取
│   │   ├── filler.js                 # 答案填入
│   │   └── humanize.js               # 拟人化延迟
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   └── options/
│       ├── options.html
│       ├── options.js
│       └── options.css
├── main.py                           # [MODIFY] 精简，移除 Playwright
├── backend/
│   ├── app.py                        # [MODIFY] 添加 CORS + 新 API
│   └── solver/
│       ├── ai.py                     # [MODIFY] 适配新 request 格式
│       └── prompt.py                 # [KEEP] 不变
├── requirements.txt                  # [MODIFY] 移除 playwright 依赖
└── start_edge_debug.bat              # [MODIFY] 简化为只启动 Python
```

---

### Task 1: Python 后端精简

**Files:**
- Modify: `main.py`
- Modify: `backend/app.py`
- Modify: `requirements.txt`
- Modify: `start_edge_debug.bat`

- [ ] **Step 1: 精简 main.py**

移除所有 Playwright 引用，只保留 FastAPI 启动逻辑：

```python
"""
学习通自动答题 — Python AI 后端
使用方法: python main.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from backend.utils.config import config


def main():
    import uvicorn

    log_level = config.get("logging", {}).get("level", "info").lower()
    host = "127.0.0.1"
    port = 8765

    print(f"""
╔══════════════════════════════════════════╗
║     学习通自动答题 AI 后端 v1.0          ║
║                                          ║
║  API:    http://{host}:{port}/api/solve   ║
║  Health: http://{host}:{port}/api/health  ║
║  Model:  {config.get('ai', {}).get('model', 'deepseek-chat'):<10s}         ║
╚══════════════════════════════════════════╝
    """)

    uvicorn.run(
        "backend.app:app",
        host=host,
        port=port,
        log_level=log_level,
        reload=False,
    )


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 重构 backend/app.py**

简化为纯 API 服务，添加 CORS，移除 WebSocket、Browser 相关代码：

```python
"""
FastAPI 应用 — AI 答题 API。
"""
import asyncio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

from backend.utils.config import config
from backend.utils.logger import setup_logger, log
from backend.solver.ai import ai_solver
from backend.extractor.ocr import image_to_text, base64_screenshot_to_text

app = FastAPI(title="学习通 AI 后端", version="1.0")

# CORS — 允许扩展访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["chrome-extension://*", "moz-extension://*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# ─── Request Models ───

class QuestionItem(BaseModel):
    index: int
    type: str  # single | multi | judge | fill | short
    stem: str
    options: list[str] = []
    stem_images: list[str] = []

class AIConfig(BaseModel):
    api_key: str = ""
    model: str = "deepseek-chat"
    api_base: str = "https://api.deepseek.com"
    provider: str = "openai"

class SolveRequest(BaseModel):
    questions: list[QuestionItem]
    config: Optional[AIConfig] = None

class SolveResult(BaseModel):
    index: int
    answer: str = ""
    reason: str = ""

class SolveResponse(BaseModel):
    ok: bool
    results: list[SolveResult] = []
    error: Optional[str] = None

# ─── API ───

@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0"}

@app.post("/api/solve", response_model=SolveResponse)
async def solve(req: SolveRequest):
    """接收题目列表，返回 AI 答案。"""
    log.info(f"收到 {len(req.questions)} 道题目")

    # 合并配置：请求参数覆盖 config.yaml 默认值
    provider = req.config.provider if req.config else config.get("ai", {}).get("provider", "openai")
    model = req.config.model if req.config else config.get("ai", {}).get("model", "deepseek-chat")
    api_key = req.config.api_key if req.config else config.get("ai", {}).get("api_key", "")
    api_base = req.config.api_base if req.config else config.get("ai", {}).get("api_base", "")

    # 为本次请求临时覆盖 AI solver 配置
    ai_solver.provider = provider
    ai_solver.model = model
    if api_key:
        ai_solver.api_key = api_key
    if api_base:
        ai_solver.api_base = api_base

    results = []
    for q in req.questions:
        try:
            # 图片 OCR 预处理
            stem = q.stem
            for img in q.stem_images:
                if isinstance(img, str):
                    if img.startswith("data:"):
                        ocr_text = await base64_screenshot_to_text(img)
                        if ocr_text:
                            stem += "\n[图片文字]: " + ocr_text
                    elif img.startswith("http"):
                        import httpx
                        try:
                            async with httpx.AsyncClient() as client:
                                resp = await client.get(img, timeout=10)
                                ocr_text = await image_to_text(resp.content)
                                if ocr_text:
                                    stem += "\n[图片文字]: " + ocr_text
                        except Exception as e:
                            log.warning(f"图片下载失败: {e}")

            # 构造内部 Question 对象并调用 AI
            from backend.extractor.dom_parser import Question
            question = Question(
                index=q.index,
                q_type=q.type,
                stem=stem,
                options=q.options,
            )
            result = await ai_solver.solve_one(question)

            results.append(SolveResult(
                index=q.index,
                answer=result.get("answer", ""),
                reason=result.get("reason", ""),
            ))

        except Exception as e:
            log.error(f"题 #{q.index} 处理失败: {e}")
            results.append(SolveResult(
                index=q.index,
                answer="",
                reason=str(e),
            ))

    success_count = sum(1 for r in results if r.answer)
    return SolveResponse(
        ok=success_count > 0,
        results=results,
        error=None if success_count > 0 else "所有题目处理失败",
    )
```

- [ ] **Step 3: 更新 requirements.txt**

```txt
# AI / LLM
openai==1.51.0
anthropic==0.36.0

# Web framework
fastapi==0.115.0
uvicorn[standard]==0.30.6

# OCR
paddleocr==2.9.1
paddlepaddle==3.0.0
opencv-python-headless==4.10.0.84
Pillow==10.4.0

# Config
pyyaml==6.0.2

# Utilities
httpx==0.27.2
python-dotenv==1.0.1
```

- [ ] **Step 4: 简化 start_edge_debug.bat**

```bat
@echo off
echo 学习通自动答题 — Python AI 后端
echo.
echo 请保持此窗口运行，不要关闭。
echo.
python main.py
pause
```

- [ ] **Step 5: 验证 Python 后端启动**

```bash
pip install -r requirements.txt
python main.py
```

打开 `http://127.0.0.1:8765/api/health`，期望返回：
```json
{"status":"ok","version":"1.0"}
```

- [ ] **Step 6: 测试 /api/solve**

```bash
curl -X POST http://127.0.0.1:8765/api/solve \
  -H "Content-Type: application/json" \
  -d '{"questions":[{"index":1,"type":"single","stem":"1+1=?","options":["A. 1","B. 2","C. 3","D. 4"]}]}'
```

期望返回包含 `"answer": "B"` 的 JSON。

- [ ] **Step 7: 清理废弃文件**

```bash
# 删除不再需要的模块
rm -rf backend/browser
rm -rf backend/auth
rm -rf backend/submitter
rm backend/extractor/dom_parser.py
rm -rf frontend
```

---

### Task 2: 扩展骨架搭建

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/shared/protocol.js`

- [ ] **Step 1: 创建扩展目录结构**

```bash
mkdir -p extension/content extension/shared extension/popup extension/options
```

- [ ] **Step 2: 创建 manifest.json**

```json
{
  "manifest_version": 3,
  "name": "学习通助手",
  "version": "1.0",
  "description": "自动答题工具 — 支持单选、多选、判断、填空、简答",
  "permissions": ["storage", "tabs"],
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
      "js": [
        "shared/protocol.js",
        "shared/extractor.js",
        "shared/filler.js",
        "shared/humanize.js",
        "content/content.js"
      ],
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

- [ ] **Step 3: 创建 shared/protocol.js**

```javascript
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
```

- [ ] **Step 4: 在 Edge 中加载扩展**

```
1. 打开 Edge，导航到 edge://extensions/
2. 开启"开发人员模式"
3. 点击"加载解压缩的扩展"
4. 选择 316/extension/ 目录
5. 确认扩展出现在列表中，无错误
```

---

### Task 3: 题目提取模块

**Files:**
- Create: `extension/shared/extractor.js`

- [ ] **Step 1: 创建 extractor.js**

```javascript
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
```

- [ ] **Step 2: 验证提取逻辑**

在 Edge 中打开学习通作业页面，在开发者工具 Console（需选中题目所在的 iframe context）中粘贴 extractor.js 代码，运行：

```javascript
console.log('Frame role:', classifyFrame());
console.log('Questions:', extractQuestions());
```

期望输出题目数组，每道题包含 index, type, stem, options。

---

### Task 4: 答案填入模块

**Files:**
- Create: `extension/shared/filler.js`
- Create: `extension/shared/humanize.js`

- [ ] **Step 1: 创建 humanize.js**

```javascript
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
```

- [ ] **Step 2: 创建 filler.js**

```javascript
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
```

---

### Task 5: Content Scripts

**Files:**
- Create: `extension/content/detect.js`
- Create: `extension/content/content.js`

- [ ] **Step 1: 创建 detect.js（MAIN world）**

```javascript
// content/detect.js — 运行在 MAIN world
// 自动覆盖 confirm/alert，通过 DOM 属性与 ISOLATED world 通信

window._originalConfirm = window.confirm;
window._originalAlert = window.alert;

window.confirm = function(msg) {
  document.body.setAttribute('data-cx-confirm', String(msg || ''));
  return true;
};

window.alert = function(msg) {
  document.body.setAttribute('data-cx-alert', String(msg || ''));
};
```

- [ ] **Step 2: 创建 content.js（ISOLATED world）**

```javascript
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
```

---

### Task 6: Background Service Worker

**Files:**
- Create: `extension/background.js`

- [ ] **Step 1: 创建 background.js**

```javascript
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
```

- [ ] **Step 2: 验证 Background 运行**

在 Edge 的 `edge://extensions/` 中，点击扩展的"Service Worker"链接，查看 Console 是否有错误。期望看到 `Service Worker activated`（或无错误）。

---

### Task 7: Options Page（配置页）

**Files:**
- Create: `extension/options/options.html`
- Create: `extension/options/options.js`
- Create: `extension/options/options.css`

- [ ] **Step 1: 创建 options.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>学习通助手 — 设置</title>
  <link rel="stylesheet" href="options.css">
</head>
<body>
  <div class="container">
    <h1>⚙️ 学习通助手 设置</h1>

    <section>
      <h2>AI 配置</h2>

      <div class="form-group">
        <label for="provider">AI 提供商</label>
        <select id="provider">
          <option value="openai">OpenAI / DeepSeek (兼容)</option>
          <option value="anthropic">Anthropic Claude</option>
        </select>
      </div>

      <div class="form-group">
        <label for="apiKey">API Key</label>
        <input type="password" id="apiKey" placeholder="sk-..." autocomplete="off">
        <span class="hint">仅在本地传输，不上传任何服务器</span>
      </div>

      <div class="form-group">
        <label for="apiBase">API Base URL</label>
        <input type="text" id="apiBase" placeholder="https://api.deepseek.com">
        <span class="hint">DeepSeek 用户填 https://api.deepseek.com</span>
      </div>

      <div class="form-group">
        <label for="model">模型</label>
        <input type="text" id="model" placeholder="deepseek-chat">
        <span class="hint">如: gpt-4o-mini, deepseek-chat, claude-sonnet-4-6</span>
      </div>
    </section>

    <section>
      <h2>行为设置</h2>

      <div class="form-group">
        <label class="toggle">
          <input type="checkbox" id="autoMode" checked>
          <span>自动检测题目并开始答题</span>
        </label>
        <span class="hint">关闭后需手动点击扩展图标开始</span>
      </div>
    </section>

    <div class="actions">
      <button id="saveBtn" class="btn-primary">保存设置</button>
      <span id="status" class="status"></span>
    </div>
  </div>
  <script src="options.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 options.js**

```javascript
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
```

- [ ] **Step 3: 创建 options.css**

```css
/* options/options.css */
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f5f5f5;
  color: #333;
}

.container {
  max-width: 560px;
  margin: 40px auto;
  padding: 32px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.08);
}

h1 { font-size: 24px; margin-bottom: 24px; }
h2 { font-size: 16px; margin: 24px 0 12px; padding-bottom: 8px; border-bottom: 1px solid #eee; }

.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 4px; }

.form-group input[type="text"],
.form-group input[type="password"],
.form-group select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  transition: border-color 0.2s;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: #4a90d9;
  box-shadow: 0 0 0 2px rgba(74,144,217,0.2);
}

.hint { display: block; font-size: 12px; color: #999; margin-top: 4px; }

.toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 500; }
.toggle input[type="checkbox"] { width: 18px; height: 18px; }

.actions { margin-top: 24px; display: flex; align-items: center; gap: 12px; }

.btn-primary {
  padding: 10px 24px;
  background: #4a90d9;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-primary:hover { background: #3a7bc8; }

.status { font-size: 14px; }
.status.success { color: #2ecc71; }
```

- [ ] **Step 4: 验证 Options Page**

```
1. 右键扩展图标 → "选项"
2. 填入 DeepSeek API Key 和模型
3. 点击"保存设置"
4. 看到"✓ 已保存"提示
```

---

### Task 8: Popup（控制面板）

**Files:**
- Create: `extension/popup/popup.html`
- Create: `extension/popup/popup.js`
- Create: `extension/popup/popup.css`

- [ ] **Step 1: 创建 popup.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="popup">
    <div class="header">
      <h1>🎓 学习通助手</h1>
      <span id="backendDot" class="dot offline" title="后端状态"></span>
    </div>

    <div id="tabList" class="tab-list">
      <p class="empty">暂无活跃的标签页</p>
    </div>

    <div class="footer">
      <button id="optionsBtn" class="btn-secondary">⚙️ 设置</button>
    </div>
  </div>
  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 popup.js**

```javascript
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
```

- [ ] **Step 3: 创建 popup.css**

```css
/* popup/popup.css */
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  width: 340px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  color: #333;
}

.popup { padding: 16px; }

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.header h1 { font-size: 18px; }

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.dot.online { background: #2ecc71; }
.dot.offline { background: #e74c3c; }

.tab-list { min-height: 60px; }

.empty { color: #999; text-align: center; padding: 20px; }

.tab-card {
  background: #f8f9fa;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
}

.tab-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.tab-name { font-weight: 600; }

.btn-start, .btn-stop, .btn-secondary {
  padding: 4px 12px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.btn-start { background: #2ecc71; color: #fff; }
.btn-stop { background: #e74c3c; color: #fff; }
.btn-secondary { background: #eee; color: #333; }

.btn-start:hover { background: #27ae60; }
.btn-stop:hover { background: #c0392b; }

.progress-bar {
  height: 6px;
  background: #e0e0e0;
  border-radius: 3px;
  overflow: hidden;
}

.progress-bar .fill {
  height: 100%;
  background: #4a90d9;
  border-radius: 3px;
  transition: width 0.3s;
}

.progress-text, .status-text { font-size: 11px; color: #666; margin-top: 4px; display: block; }

.footer { margin-top: 16px; text-align: right; }
```

---

### Task 9: 端到端集成测试

- [ ] **Step 1: 启动 Python 后端**

```bash
cd c:\Users\谭竣\Desktop\316
python main.py
```

确认输出显示 `http://127.0.0.1:8765`。

- [ ] **Step 2: 加载扩展**

在 Edge 中：
1. 导航到 `edge://extensions/`
2. 确认扩展已加载，无错误

- [ ] **Step 3: 配置 API**

1. 右键扩展图标 → "选项"
2. 填入 DeepSeek API Key 和模型
3. 保存

- [ ] **Step 4: 完整流程测试**

用 agent-browser 验证：

```bash
# 启动 Edge（如果尚未以调试模式运行）
# 使用扩展已加载的 Edge profile

# 打开学习通作业页面
agent-browser --cdp 9222 open <作业页面URL>

# 在 Popup 中点击"开始"
# 观察题目被提取、AI 返回答案、自动填入
```

- [ ] **Step 5: 验证每种题型**

在包含多种题型的页面上测试：
- 单选题：radio 正确选中
- 多选题：checkbox 正确选中
- 判断题：正确/错误 radio 选中
- 填空题：文本正确填入 input
- 简答题：文本正确填入 textarea

- [ ] **Step 6: 验证提交与翻页**

- 全部填入后自动点击"提交"
- confirm 弹窗自动确认
- 翻页后自动继续

- [ ] **Step 7: 验证手动停止**

- 答题中途在 Popup 中点击"停止"
- 填入立即中断
- 已填答案保留

---

## 测试总结

完成所有 Task 后，以下场景应全部通过：

| # | 测试场景 | 预期结果 |
|---|---------|---------|
| 1 | Python 后端未启动，打开 Popup | 后端状态红点，提示未连接 |
| 2 | 启动后端，打开 Popup | 后端状态绿点 |
| 3 | 进入学习通作业页面，autoMode=true | 自动检测题目并开始答题 |
| 4 | autoMode=false，进入作业页面 | 不自动开始，等待手动点击 |
| 5 | 单选题填入 | 对应 radio 正确选中 |
| 6 | 多选题填入 | 对应 checkbox 正确选中 |
| 7 | 判断题填入 | 对应正确/错误 radio 选中 |
| 8 | 填空题填入 | 文本正确输入，多空按分号分隔 |
| 9 | 简答题填入 | 文本正确输入 textarea/iframe |
| 10 | 提交按钮点击 | 提交按钮被点击，确认弹窗自动确认 |
| 11 | 翻页检测 | 翻页后自动重新提取和答题 |
| 12 | 全部完成 | Popup 显示完成状态，taskActive 清除 |
| 13 | 手动停止 | 答题立即中断，已填答案保留 |
| 14 | 多标签页 | 两个标签页独立运行，互不干扰 |
| 15 | 标签页关闭 | registry 清理，无残留 |
| 16 | 30 分钟超时 | 任务自动停止，标记清除 |
